'use strict';

/**
 * A minimal PNG reader for tests.
 *
 * The sprite-sheet scaling bug this project hit was invisible to file-size and
 * header-dimension checks: the canvas grew correctly while the artwork inside
 * it stayed at 1x. Catching that needs the actual pixels, and pulling in an
 * image library for it would break the zero-dependency promise.
 *
 * Supports the 8-bit RGBA, non-interlaced PNGs Aseprite writes (including all
 * five scanline filters).
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

const CHANNELS = 4;

/** Decode an 8-bit RGBA PNG to { width, height, data }. */
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`${file} is not a PNG`);
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`unsupported PNG: depth=${depth} colour=${colour} interlace=${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * CHANNELS;
  const out = Buffer.alloc(stride * height);
  let rp = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp];
    rp += 1;
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);

    for (let i = 0; i < stride; i += 1) {
      const a = i >= CHANNELS ? cur[i - CHANNELS] : 0;
      const b = prev[i];
      const c = i >= CHANNELS ? prev[i - CHANNELS] : 0;
      let v = line[i];
      switch (filter) {
        case 0:
          break;
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`bad scanline filter ${filter}`);
      }
      cur[i] = v & 0xff;
    }
  }

  return { width, height, data: out };
}

/**
 * Bounding box of the non-transparent pixels inside a region of an image.
 * @returns {{x0,y0,x1,y1,w,h}|null} null when the region is fully transparent
 */
function inkBounds(image, region) {
  const r = region || { x: 0, y: 0, w: image.width, h: image.height };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;

  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      if (image.data[(y * image.width + x) * CHANNELS + 3] > 0) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

module.exports = { decodePng, inkBounds };
