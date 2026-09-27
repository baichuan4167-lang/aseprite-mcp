'use strict';

/**
 * Export and import tools.
 *
 * Exports write real files to disk and the tools echo back the paths, so an
 * agent can hand the user game-ready assets (sprite sheets + JSON metadata for
 * engines, GIFs for previews, PNG sequences for pipelines).
 */

const fs = require('node:fs');
const path = require('node:path');
const { ToolError } = require('../mcp');
const { DOCUMENT, spriteReport } = require('./sprite');

function register(server, ctx) {
  const { aseprite, workspace } = ctx;
  const call = (cmd, args, filePath) => aseprite.run(cmd, args, { doc: filePath });

  server.tool({
    name: 'aseprite_export_png',
    description:
      'Export the sprite as a flat PNG. By default every visible layer is composited and the ' +
      'first frame is written. Pass `frame` for a specific frame, or `scale` to upscale (integer ' +
      'scales keep pixels crisp).',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        output: { type: 'string', description: 'Output path. Relative paths land in the out folder.' },
        frame: { type: 'integer', description: 'Export just this frame (0-based). Omit to export frame 0.' },
        scale: { type: 'integer', description: 'Integer upscale factor (default 1).', minimum: 1, maximum: 16 },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const out = workspace.resolveExport(args.output, { extension: '.png', basename: baseName(filePath) });
      workspace.ensureDir(path.dirname(out));
      const data = await call('export_png', { output: out, frame: args.frame, scale: args.scale ?? 1 }, filePath);
      return {
        ...data,
        output: workspace.display(out),
        absolutePath: out,
        exists: fs.existsSync(out),
      };
    },
  });

  server.tool({
    name: 'aseprite_export_gif',
    description:
      'Export the animation as an animated GIF, using each frame\'s own duration. This is the ' +
      'quickest way to show the user a moving preview of what you animated.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        output: { type: 'string', description: 'Output .gif path. Relative paths land in the out folder.' },
        scale: { type: 'integer', description: 'Integer upscale factor (default 1).', minimum: 1, maximum: 8 },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const out = workspace.resolveExport(args.output, { extension: '.gif', basename: baseName(filePath) });
      workspace.ensureDir(path.dirname(out));
      const data = await call('export_gif', { output: out, scale: args.scale ?? 1 }, filePath);
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      return {
        ...data,
        output: workspace.display(out),
        absolutePath: out,
        bytes: size,
        exists: size > 0,
        hint: size > 0 ? 'Animated GIF written - open it or show it to the user as a preview.' : 'The export produced no file.',
      };
    },
  });

  server.tool({
    name: 'aseprite_export_sequence',
    description:
      'Export every frame as its own numbered PNG (hero_000.png, hero_001.png, ...). Use this ' +
      'when an engine or artist wants individual frames rather than a packed sheet.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        outputDir: { type: 'string', description: 'Directory for the frames. Relative paths land in the out folder.' },
        name: { type: 'string', description: 'Base filename (default: the document name).' },
        format: { type: 'string', enum: ['png', 'jpg', 'webp'], description: 'Image format (default png).' },
        scale: { type: 'integer', description: 'Integer upscale factor (default 1).', minimum: 1, maximum: 16 },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const dir = args.outputDir
        ? workspace.resolveExport(args.outputDir, { extension: '', basename: baseName(filePath) })
        : path.join(workspace.exportRoot, `${baseName(filePath)}-frames`);
      workspace.ensureDir(dir);
      const data = await call(
        'export_sequence',
        { outputDir: dir, name: args.name || baseName(filePath), format: args.format || 'png', scale: args.scale ?? 1 },
        filePath,
      );
      return {
        ...data,
        outputDir: workspace.display(dir),
        absolutePath: dir,
        outputs: (data.outputs || []).map((o) => workspace.display(o)),
      };
    },
  });

  server.tool({
    name: 'aseprite_export_sprite_sheet',
    description:
      'Export a sprite sheet PNG plus optional JSON metadata - the standard way to hand pixel-art ' +
      'animations to a game engine. Use `tag` to export a single animation, `sheetType` to choose ' +
      'the layout, and padding options to avoid bleeding between tiles when the sheet is scaled.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        output: { type: 'string', description: 'Sprite sheet PNG path. Relative paths land in the out folder.' },
        dataOutput: { type: 'string', description: 'Optional JSON metadata path (frame rects, durations, tags, layers).' },
        dataFormat: { type: 'string', enum: ['json-hash', 'json-array'], description: 'JSON shape (default json-hash).' },
        sheetType: {
          type: 'string',
          enum: ['horizontal', 'vertical', 'rows', 'columns', 'packed'],
          description: 'Layout (default horizontal).',
        },
        tag: { type: 'string', description: 'Export only the frames in this animation tag.' },
        frameRange: { type: 'array', items: { type: 'integer' }, description: '[from, to] inclusive, 0-based.' },
        columns: { type: 'integer', description: 'Column count for sheetType rows.' },
        rows: { type: 'integer', description: 'Row count for sheetType columns.' },
        borderPadding: { type: 'integer', description: 'Padding around the sheet edge.' },
        shapePadding: { type: 'integer', description: 'Padding between frames (use 1-2 to prevent bleeding).' },
        innerPadding: { type: 'integer', description: 'Padding inside each frame.' },
        trim: { type: 'boolean', description: 'Trim transparent pixels and record offsets in the JSON.' },
        extrude: { type: 'boolean', description: 'Duplicate edge pixels to prevent sampling artifacts.' },
        ignoreEmpty: { type: 'boolean', description: 'Skip empty frames.' },
        mergeDuplicates: { type: 'boolean', description: 'Merge identical frames.' },
        splitLayers: { type: 'boolean', description: 'Export each layer as a separate row in the sheet.' },
        scale: { type: 'integer', description: 'Integer upscale factor.', minimum: 1, maximum: 8 },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const base = baseName(filePath);
      const out = workspace.resolveExport(args.output, { extension: '.png', basename: `${base}-sheet` });
      workspace.ensureDir(path.dirname(out));
      const dataOut = args.dataOutput
        ? workspace.resolveExport(args.dataOutput, { extension: '.json', basename: `${base}-sheet` })
        : out.replace(/\.png$/i, '.json');
      const data = await call(
        'export_sheet',
        {
          output: out,
          dataOutput: dataOut,
          dataFormat: args.dataFormat,
          sheetType: args.sheetType,
          tag: args.tag,
          frameRange: args.frameRange ? [args.frameRange[0] + 1, args.frameRange[1] + 1] : undefined,
          columns: args.columns,
          rows: args.rows,
          borderPadding: args.borderPadding,
          shapePadding: args.shapePadding,
          innerPadding: args.innerPadding,
          trim: args.trim,
          extrude: args.extrude,
          ignoreEmpty: args.ignoreEmpty,
          mergeDuplicates: args.mergeDuplicates,
          splitLayers: args.splitLayers,
          scale: args.scale,
        },
        filePath,
      );
      return {
        ...data,
        output: workspace.display(out),
        absolutePath: out,
        dataOutput: fs.existsSync(dataOut) ? workspace.display(dataOut) : undefined,
        dataAbsolutePath: fs.existsSync(dataOut) ? dataOut : undefined,
        sheetBytes: fs.existsSync(out) ? fs.statSync(out).size : 0,
      };
    },
  });

  server.tool({
    name: 'aseprite_import_image',
    description:
      'Bring an external image into the pipeline. With `asNewSprite` it becomes a new document ' +
      '(useful for tracing over a reference, or for slicing an existing sprite sheet by hand). ' +
      'Otherwise it is drawn onto a layer of the active document at (x, y) - handy for stamping a ' +
      'palette reference, a logo, or a texture into a piece.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        source: { type: 'string', description: 'Absolute path to the image to import (PNG, JPG, GIF, ...).' },
        asNewSprite: { type: 'boolean', description: 'Import as a new document rather than into the active one.' },
        layer: { type: 'string', description: 'Target layer (a new layer is created when omitted).' },
        x: { type: 'integer', description: 'Left edge to place the image at (default 0).' },
        y: { type: 'integer', description: 'Top edge to place the image at (default 0).' },
        frame: { type: 'integer', description: 'Target frame (default 0).' },
      },
      required: ['source'],
    },
    async handler(args) {
      if (!args.source || !path.isAbsolute(args.source)) {
        throw new ToolError('`source` must be an absolute path to the image file.');
      }
      if (!fs.existsSync(args.source)) {
        throw new ToolError(`Image not found: ${args.source}`);
      }
      const filePath = workspace.resolveDocument(args.document, { mustExist: Boolean(args.document) });
      const data = await call(
        'import_image',
        {
          source: args.source,
          asNewSprite: args.asNewSprite,
          layer: args.layer,
          x: args.x ?? 0,
          y: args.y ?? 0,
          frame: (args.frame ?? 0) + 1,
        },
        filePath,
      );
      return data;
    },
  });

  server.tool({
    name: 'aseprite_status',
    description:
      'Report the Aseprite installation the server found, the workspace folders it uses, and the ' +
      'active document. Call this first if a tool fails, or to learn where files are being written.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async handler() {
      const probe = await aseprite.probe();
      return {
        aseprite: probe,
        workspace: workspace.describe(),
        documentsInArtFolder: listAseprite(workspace.artRoot),
        exportsInOutFolder: listFiles(workspace.exportRoot),
      };
    },
  });
}

function baseName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function listAseprite(dir) {
  return listFiles(dir).filter((f) => f.endsWith('.aseprite') || f.endsWith('.ase'));
}

function listFiles(dir, limit = 200) {
  try {
    return fs.readdirSync(dir).slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = { register };
