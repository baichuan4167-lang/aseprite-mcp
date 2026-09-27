'use strict';

/**
 * Drawing tools: raw pixel data, drawing primitives, previews.
 *
 * `aseprite_pixels` is the primary way to put real artwork into a sprite - it
 * takes a rectangular grid of hex colours. `aseprite_draw` handles vector-ish
 * primitives (lines, shapes, ramps, fills) for constructing and shading forms.
 */

const { ToolError } = require('../mcp');
const { decodeRaw, scaleNearest, toAscii, toImageContent, colourStats } = require('../image');
const { DOCUMENT, COLOR, FRAME, spriteReport } = require('./sprite');

/** Expand "ab" + {a:'#f00'} into ['#f00','#000'] style lookups. */
function parseCell(raw, key) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '' || s === '.' || s === '-' || s === ' ' || s.toLowerCase() === 'transparent') return null;
  const resolved = key ? key[s] : undefined;
  if (resolved !== undefined) return resolved;
  // a hex-looking cell is used directly
  if (/^#?[0-9a-fA-F]{3,8}$/.test(s)) return s;
  throw new ToolError(
    `Pixel value "${s}" is not a colour. Use a hex value like "#ff8800", "." for transparent, ` +
      (key ? 'or one of the keys in `key`.' : 'or pass a `key` map.'),
  );
}

function parsePixelArgs(args) {
  const key = args.key || null;

  // Form 1: rows of single characters, resolved through `key`.
  if (args.rows) {
    if (!key) {
      throw new ToolError('`rows` requires a `key` map, e.g. key: {"k":"#000000", "s":"#ffcc99"}.');
    }
    return args.rows.map((row) => {
      if (typeof row !== 'string') {
        throw new ToolError('Every entry of `rows` must be a string.');
      }
      return [...row].map((ch) => parseCell(ch, key));
    });
  }

  // Form 2: rectangular grid of colours.
  if (args.pixels) {
    const grid = args.pixels;
    if (!Array.isArray(grid) || !grid.length) {
      throw new ToolError('`pixels` must be a non-empty array of rows.');
    }
    return grid.map((row) => {
      if (!Array.isArray(row)) throw new ToolError('Each row of `pixels` must be an array.');
      return row.map((cell) => parseCell(cell, key));
    });
  }

  // Form 3: explicit points.
  if (args.points) {
    return args.points.map((p) => {
      if (!p || typeof p !== 'object') throw new ToolError('Each point must be an object {x, y, color}.');
      return { x: p.x, y: p.y, color: parseCell(p.color ?? p.value, key) };
    });
  }

  throw new ToolError('Provide pixels in one of these forms: `pixels` (2-D grid), `rows` (character grid) + `key`, or `points`.');
}

/**
 * Encode a 2-D grid of resolved colours as dense character rows plus a
 * character -> colour map.
 *
 * This is not just a size optimisation: Lua's `#` and `ipairs` stop at the
 * first nil, so passing a JSON array with nulls (transparent pixels) silently
 * truncates the data. Characters have no such hole, and "." carries the
 * meaning explicitly.
 *
 * @param {(string|null)[][]} grid
 * @param {object|null} suppliedKey character -> colour map from the caller
 * @returns {{rows: string[], key: Record<string,string>}}
 */
function buildRows(grid, suppliedKey) {
  const key = suppliedKey ? { ...suppliedKey } : {};
  if (suppliedKey) {
    for (const [ch, color] of Object.entries(suppliedKey)) {
      if ([...ch].length !== 1) {
        throw new ToolError(`key "${ch}" must be a single character.`);
      }
      if (ch === '.') throw new ToolError('"." is reserved for transparent pixels - pick another key character.');
    }
  }

  const byColor = new Map();
  for (const [ch, color] of Object.entries(key)) {
    byColor.set(String(color).toLowerCase(), ch);
  }
  // Characters that are safe inside a grid string and not already used.
  const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{};:,<>?/|~';
  let next = 0;
  const allocate = (color) => {
    if (next >= pool.length) {
      throw new ToolError('Too many distinct colours for one call (max 88). Split the drawing into several calls.');
    }
    const ch = pool[next];
    next += 1;
    key[ch] = color;
    byColor.set(String(color).toLowerCase(), ch);
    return ch;
  };

  const rows = grid.map((row, rowIndex) => {
    let line = '';
    row.forEach((cell, colIndex) => {
      if (cell === null || cell === undefined) {
        line += '.';
        return;
      }
      const normalized = String(cell);
      const existing = byColor.get(normalized.toLowerCase());
      if (existing !== undefined) {
        line += existing;
        return;
      }
      // If the caller's key already maps some character to this colour, reuse it.
      line += allocate(normalized);
    });
    return line;
  });

  return { rows, key };
}

function register(server, ctx) {
  const { aseprite, workspace } = ctx;
  const call = (cmd, args, filePath) => aseprite.run(cmd, args, { doc: filePath });

  //=========================================================== raw pixels ==

  server.tool({
    name: 'aseprite_pixels',
    description:
      'Draw a rectangular block of pixels - the main tool for putting actual artwork into a ' +
      'sprite. The origin is the top-left of the canvas; x grows right, y grows down.\n\n' +
      'Two ways to pass data:\n' +
      '  1. `pixels`: array of rows, each row an array of hex colours. ' +
      'null or "." leaves the pixel transparent.\n' +
      '  2. `rows` + `key`: rows given as compact strings where each character is looked up in ' +
      '`key`. Much shorter for larger art - for example rows: ["kksskk","kssssk"] with ' +
      'key: {"k":"#1a1c2c","s":"#ffcd75"}.\n\n' +
      'All rows must be the same length. Drawing only touches the pixels you supply; everything ' +
      'else on the canvas is left alone. To keep revisions cheap, send one small block per ' +
      'part (outline, fill, shading) rather than repainting the whole sprite.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        pixels: {
          type: 'array',
          items: { type: 'array', items: { type: ['string', 'null'] } },
          description: 'Rows of hex colours, e.g. [["#000000","#ff0000"],["#ff0000",null]].',
        },
        rows: {
          type: 'array',
          items: { type: 'string' },
          description: 'Rows as character strings, resolved through `key`.',
        },
        key: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Character-to-colour map, e.g. {"k":"#000000"}. "." always means transparent.',
        },
        points: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              color: COLOR,
            },
            required: ['x', 'y', 'color'],
          },
          description: 'Alternatively, an explicit list of pixels.',
        },
        x: { type: 'integer', description: 'Left edge of the block (default 0).' },
        y: { type: 'integer', description: 'Top edge of the block (default 0).' },
        layer: { type: 'string', description: 'Target layer (default active layer).' },
        frame: { ...FRAME, description: 'Target frame (default 0).' },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const grid = parsePixelArgs(args);

      // points form goes straight through
      if (grid.length && grid[0] && !Array.isArray(grid[0]) && grid[0].x !== undefined) {
        const data = await call(
          'pixels',
          { format: 'points', pixels: grid, layer: args.layer, frame: (args.frame ?? 0) + 1 },
          filePath,
        );
        return spriteReport(data.sprite, workspace, { pixelsWritten: data.pixelsWritten });
      }

      const { rows, key } = buildRows(grid, args.key);
      const data = await call(
        'pixels_encoded',
        { rows, key, x: args.x ?? 0, y: args.y ?? 0, layer: args.layer, frame: (args.frame ?? 0) + 1 },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { pixelsWritten: data.pixelsWritten });
    },
  });

  server.tool({
    name: 'aseprite_fill_regions',
    description:
      'Paint a set of individual pixels, each with its own colour, on one layer. Unlike ' +
      '`aseprite_pixels` this does not need a rectangular block, so it suits touching up ' +
      'scattered details, adding a highlight, or fixing stray pixels.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        cells: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              color: COLOR,
              frame: { type: 'integer', description: 'Target frame (default 0).' },
            },
            required: ['x', 'y', 'color'],
          },
          description: 'Pixels to paint.',
        },
        x: { type: 'integer', description: 'X offset added to every cell (default 0).' },
        y: { type: 'integer', description: 'Y offset added to every cell (default 0).' },
        layer: { type: 'string', description: 'Target layer.' },
      },
      required: ['cells'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const cells = args.cells.map((c, i) => {
        if (!c || c.x === undefined || c.y === undefined || !c.color) {
          throw new ToolError(`cells[${i}] needs x, y and color.`);
        }
        return { x: c.x, y: c.y, color: c.color, frame: (c.frame ?? 0) + 1 };
      });
      const data = await call('fill_region', { cells, x: args.x ?? 0, y: args.y ?? 0, layer: args.layer }, filePath);
      return spriteReport(data.sprite, workspace, { pixelsWritten: data.pixelsWritten });
    },
  });

  server.tool({
    name: 'aseprite_frames_from_grids',
    description:
      'Draw a whole animation in one call: pass one character grid per frame and the tool writes ' +
      'each grid into its own frame. This is the fastest, most token-efficient way to produce a ' +
      'multi-frame animation. Grids are applied on a single layer; use `x`/`y` to offset them.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        grids: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'One grid (array of character rows) per frame.',
        },
        key: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Character-to-colour map. "." means transparent.',
        },
        x: { type: 'integer', description: 'Left edge for every grid (default 0).' },
        y: { type: 'integer', description: 'Top edge for every grid (default 0).' },
        layer: { type: 'string', description: 'Target layer (all frames are drawn on it).' },
      },
      required: ['grids'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      if (!args.key) throw new ToolError('`key` is required so the grid characters can be resolved to colours.');
      for (const [ch, color] of Object.entries(args.key)) {
        if ([...ch].length !== 1) throw new ToolError(`key "${ch}" must be a single character.`);
        if (ch === '.') throw new ToolError('"." is reserved for transparent pixels - pick another key character.');
        if (typeof color !== 'string') throw new ToolError(`key "${ch}" must map to a colour string.`);
      }
      const grids = args.grids.map((grid, gi) => {
        if (!Array.isArray(grid)) throw new ToolError(`grids[${gi}] must be an array of strings.`);
        return grid.map((row, ri) => {
          if (typeof row !== 'string') throw new ToolError(`grids[${gi}][${ri}] must be a string.`);
          return row;
        });
      });
      const data = await call(
        'frames_from_grids',
        { grids, key: args.key, x: args.x ?? 0, y: args.y ?? 0, layer: args.layer },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { pixelsWritten: data.pixelsWritten });
    },
  });

  //================================================================ draw ==

  server.tool({
    name: 'aseprite_draw',
    description:
      'Draw geometric primitives. Pass `ops`: an array of drawing operations applied in order, ' +
      'all in one call. Coordinates are 0-based from the top-left.\n\n' +
      'Operations:\n' +
      '  {op:"pixel", x, y, color}                       one pixel\n' +
      '  {op:"line", x1, y1, x2, y2, color}              Bresenham line\n' +
      '  {op:"rect", x, y, w, h, color, filled:false}    rectangle (w/h in pixels)\n' +
      '  {op:"ellipse", cx, cy, rx, ry, color, filled:false}  ellipse; rx=ry for a circle\n' +
      '  {op:"polygon", points:[[x,y],...], color, filled:false}\n' +
      '  {op:"spline", points:[[x,y],...], color}        smooth Catmull-Rom curve (good for tails, hair, limbs)\n' +
      '  {op:"fill", x, y, color, tolerance:0}           flood fill from a seed pixel\n' +
      '  {op:"clear", x, y, w, h}                        make a region transparent\n' +
      '  {op:"gradient", x, y, w, h, from, to, bands:8, direction:"vertical"}  banded ramp (classic pixel-art shading)\n' +
      '  {op:"dither", x, y, w, h, colors:[a,b], matrix:"bayer4", ratio:0.5}   ordered dithering\n' +
      '  {op:"pattern", x, y, w, h, tile:[["#111","."],["#222","#333"]]}       repeating 2-D tile\n' +
      '  {op:"text", text:"Hi", x, y, color, scale:1}    built-in 5x7 pixel font\n\n' +
      'Each op may override `layer` and `frame`. Colors accept "#rrggbb", "#rrggbbaa" or a name.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        ops: {
          type: 'array',
          description: 'Drawing operations, applied in order.',
          items: {
            type: 'object',
            properties: { op: { type: 'string', description: 'Operation name.' } },
            required: ['op'],
            additionalProperties: true,
          },
        },
        layer: { type: 'string', description: 'Default target layer for every op.' },
        frame: { ...FRAME, description: 'Default target frame for every op.' },
      },
      required: ['ops'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const ops = args.ops.map((op, i) => {
        if (!op || !op.op) throw new ToolError(`ops[${i}] needs an "op" field.`);
        return { ...op, frame: op.frame === undefined ? (args.frame ?? 0) + 1 : op.frame + 1 };
      });
      const data = await call('draw', { ops, layer: args.layer, frame: (args.frame ?? 0) + 1 }, filePath);
      return spriteReport(data.sprite, workspace, { ops: data.ops });
    },
  });

  server.tool({
    name: 'aseprite_draw_across_frames',
    description:
      'Apply the same set of drawing operations to several frames, optionally shifting them per ' +
      'frame. This is how you animate motion efficiently: describe the moving part once and give ' +
      'each frame an offset.\n\n' +
      'With no `frames` argument the ops are drawn on every frame. Pass `frames` as an array of ' +
      'indices, or of objects like {index:2, dx:3, dy:-1} to move the drawing by (dx, dy) on ' +
      'that frame.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        ops: { type: 'array', description: 'Same operation objects as aseprite_draw.', items: { type: 'object', additionalProperties: true } },
        frames: {
          type: 'array',
          description: 'Frame indices, or {index, dx, dy} objects. Omit to draw on all frames.',
          items: {
            anyOf: [
              { type: 'integer' },
              {
                type: 'object',
                properties: { index: { type: 'integer' }, dx: { type: 'integer' }, dy: { type: 'integer' } },
                required: ['index'],
              },
            ],
          },
        },
        layer: { type: 'string', description: 'Target layer.' },
      },
      required: ['ops'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const frames = args.frames
        ? args.frames.map((f) =>
            typeof f === 'number' ? { index: f + 1 } : { index: f.index + 1, dx: f.dx ?? 0, dy: f.dy ?? 0 },
          )
        : undefined;
      const data = await call('draw_frames', { ops: args.ops, frames, layer: args.layer }, filePath);
      return spriteReport(data.sprite, workspace, { framesDrawn: data.framesDrawn });
    },
  });

  server.tool({
    name: 'aseprite_text',
    description:
      'Draw text with the built-in 5x7 pixel font. Suitable for labels, UI mockups and small ' +
      'titles. Non-ASCII characters render as "?". Use `scale` 2 or 3 for larger text that ' +
      'stays crisp.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        text: { type: 'string', description: 'ASCII text to draw.' },
        x: { type: 'integer', description: 'Left edge.' },
        y: { type: 'integer', description: 'Top edge.' },
        color: { ...COLOR, description: 'Text colour (default white).' },
        scale: { type: 'integer', description: 'Pixel scale of the font (default 1).', minimum: 1, maximum: 8 },
        layer: { type: 'string' },
        frame: FRAME,
      },
      required: ['text', 'x', 'y'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'draw',
        {
          ops: [{ op: 'text', text: args.text, x: args.x, y: args.y, color: args.color ?? '#ffffff', scale: args.scale ?? 1, layer: args.layer }],
          layer: args.layer,
          frame: (args.frame ?? 0) + 1,
        },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { text: args.text });
    },
  });

  //================================================================ view ==

  async function renderView(args, opts = {}) {
    const filePath = workspace.resolveDocument(args.document);
    const data = await call(
      opts.onion ? 'onion_preview' : 'view',
      {
        frame: (args.frame ?? 0) + 1,
        scale: args.scale ?? 1,
        layers: args.layers,
      },
      filePath,
    );
    const image = data.image;
    const rgba = decodeRaw(image.data);

    // `image.width/height` is the size of the buffer Aseprite returned, which
    // already includes any explicit `scale`. `logicalWidth/Height` is the real
    // canvas size and is what pixel coordinates refer to.
    const bufW = image.width;
    const bufH = image.height;
    const width = image.logicalWidth ?? bufW;
    const height = image.logicalHeight ?? bufH;

    // Upscale small sprites for legibility, unless the caller chose a scale.
    let previewRgba = rgba;
    let previewScale = 1;
    if (!args.scale && width * 8 <= 1024 && height * 8 <= 1024) {
      previewScale = Math.max(1, Math.min(8, Math.floor(512 / Math.max(width, height))));
      if (previewScale > 1) previewRgba = scaleNearest(rgba, bufW, bufH, previewScale);
    }

    const previewWidth = bufW * previewScale;
    const previewHeight = bufH * previewScale;
    const stats = colourStats(previewRgba);
    const lines = [
      `${opts.onion ? 'Onion-skin preview' : 'Preview'} of ${workspace.display(filePath)} - frame ${args.frame ?? 0}`,
      `canvas ${width}x${height}${previewScale > 1 ? ` (shown at ${previewScale}x)` : image.scale > 1 ? ` (rendered at ${image.scale}x)` : ''}`,
      `opaque pixels: ${stats.opaquePixels}, transparent: ${stats.transparentPixels}, distinct colours: ${stats.uniqueColours}`,
    ];
    if (stats.colours.length) {
      lines.push(
        `dominant colours: ${stats.colours
          .slice(0, 12)
          .map((c) => `${c.hex} (${c.percent}%)`)
          .join(', ')}`,
      );
    }

    const content = [{ type: 'text', text: lines.join('\n') }];
    content.push(toImageContent(previewRgba, previewWidth, previewHeight));

    // Optionally include a text view so the agent can reason about exact pixels.
    if (args.includeAscii) {
      const ascii = toAscii(rgba, width, height);
      if (ascii.legend.length <= 40) {
        content.push({
          type: 'text',
          text: `Pixel map (one character per pixel, '.' = transparent):\n${ascii.rows.join('\n')}\n\nLegend: ${ascii.legend
            .map((l) => `${l.char}=${l.hex}`)
            .join(' ')}`,
        });
      } else {
        content.push({
          type: 'text',
          text: `Pixel map omitted: ${ascii.legend.length} distinct colours is too many to map to characters. Quantize the palette first if you need a text view.`,
        });
      }
    }

    return {
      content,
      structuredContent: {
        document: workspace.display(filePath),
        frame: args.frame ?? 0,
        width,
        height,
        colours: stats.uniqueColours,
        opaquePixels: stats.opaquePixels,
      },
    };
  }

  server.tool({
    name: 'aseprite_view',
    description:
      'Render a frame to a PNG image so you can actually LOOK at the artwork and judge it. Use ' +
      'this after drawing, and before telling the user the piece is finished. Set ' +
      '`includeAscii: true` to also get an exact character map of the pixels, which is the most ' +
      'precise way to verify positions and colours.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        frame: FRAME,
        scale: { type: 'integer', description: 'Integer zoom for the rendered image (default: automatic).', minimum: 1, maximum: 16 },
        layers: { type: 'array', items: { type: 'string' }, description: 'Render only these layers.' },
        includeAscii: { type: 'boolean', description: 'Also return a character map of the frame.' },
      },
      required: [],
    },
    handler: (args) => renderView(args, { onion: false }),
  });

  server.tool({
    name: 'aseprite_onion_preview',
    description:
      'Render a frame with the previous frame ghosted red and the next frame ghosted cyan. This ' +
      'is how animators check that motion reads correctly between frames - use it to verify the ' +
      'arc of a swing, a walk, or a bounce.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT, frame: FRAME, scale: { type: 'integer', minimum: 1, maximum: 16 } },
      required: ['frame'],
    },
    handler: (args) => renderView(args, { onion: true }),
  });

  server.tool({
    name: 'aseprite_pick_color',
    description: 'Read the final composited colour at a single pixel. Returns hex plus RGBA.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT, x: { type: 'integer' }, y: { type: 'integer' }, frame: FRAME },
      required: ['x', 'y'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('pick_color', { x: args.x, y: args.y, frame: (args.frame ?? 0) + 1 }, filePath);
      return { ...data, document: workspace.display(filePath) };
    },
  });

  server.tool({
    name: 'aseprite_inspect_pixels',
    description:
      'Dump a frame as text rows, one character per pixel, with a palette legend. Cheaper and ' +
      'more precise than an image when you only need to verify exact pixel positions or check a ' +
      'symmetric arrangement. "." is transparent.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        frame: FRAME,
        maxPixels: { type: 'integer', description: 'Safety limit for very large canvases (default 4096).' },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('inspect', { frame: (args.frame ?? 0) + 1, maxPixels: args.maxPixels }, filePath);
      const legend = data.paletteLegend || [];
      const text = [
        `Pixel map of ${workspace.display(filePath)}, frame ${data.frame} (${data.sprite.width}x${data.sprite.height})`,
        data.legendNote,
        '',
        ...data.rows,
        '',
        `Legend: ${legend.map((hex, i) => `${i.toString(16).toUpperCase()}=${hex}`).join(' ')}`,
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: { legend, frame: data.frame } };
    },
  });
}

module.exports = { register };
