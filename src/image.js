'use strict';

/**
 * Minimal RGBA image helpers: a dependency-free PNG encoder plus a few
 * transforms used to hand artwork back to an agent in a form it can inspect.
 *
 * Aseprite returns raw RGBA8888 bytes, base64-encoded. Everything here works
 * on those buffers.
 */

const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * Encode raw RGBA8888 pixels as a PNG.
 * @param {Buffer} rgba length must be width*height*4
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePng(rgba, width, height) {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`expected ${expected} bytes of RGBA data, received ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) in front of every scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode the base64 payload Aseprite's Lua sends back. */
function decodeRaw(base64) {
  return Buffer.from(base64, 'base64');
}

/**
 * Nearest-neighbour upscale, so a 32x32 sprite is legible when previewed.
 * @returns {Buffer} new RGBA buffer
 */
function scaleNearest(rgba, width, height, factor) {
  if (!factor || factor <= 1) return rgba;
  const outW = width * factor;
  const outH = height * factor;
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < outW; x += 1) {
      const sx = Math.floor(x / factor);
      const src = (sy * width + sx) * 4;
      const dst = (y * outW + x) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return out;
}

/** Count distinct opaque colours - a quick "is this a tidy pixel-art palette?" check. */
function colourStats(rgba) {
  const seen = new Map();
  let opaque = 0;
  let transparent = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) {
      transparent += 1;
      continue;
    }
    opaque += 1;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const colours = [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({
      hex: `#${key.toString(16).padStart(6, '0')}`,
      count,
      percent: Number(((count / Math.max(1, opaque)) * 100).toFixed(1)),
    }));
  return { opaquePixels: opaque, transparentPixels: transparent, uniqueColours: colours.length, colours: colours.slice(0, 48) };
}

/**
 * Render a compact text view of a frame: one character per pixel, mapping the
 * most common colours onto a stable alphabet.
 */
function toAscii(rgba, width, height) {
  const lookup = new Map();
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let next = 0;
  const legend = [];
  const rows = [];

  for (let y = 0; y < height; y += 1) {
    let line = '';
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] === 0) {
        line += '.';
        continue;
      }
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      let ch = lookup.get(key);
      if (!ch) {
        if (next < alphabet.length) {
          ch = alphabet[next];
          next += 1;
          lookup.set(key, ch);
          legend.push({ char: ch, hex: `#${key.toString(16).padStart(6, '0')}` });
        } else {
          ch = '?';
          lookup.set(key, ch);
        }
      }
      line += ch;
    }
    rows.push(line);
  }
  return { rows, legend };
}

/** Pack an RGBA buffer into the MCP image content shape. */
function toImageContent(rgba, width, height) {
  return {
    type: 'image',
    data: encodePng(rgba, width, height).toString('base64'),
    mimeType: 'image/png',
  };
}

module.exports = {
  encodePng,
  decodeRaw,
  scaleNearest,
  colourStats,
  toAscii,
  toImageContent,
  crc32,
};
