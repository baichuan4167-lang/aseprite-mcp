'use strict';

/**
 * Sprite / layer / frame / tag / palette / loop tools.
 *
 * Every tool that changes a document writes the .aseprite file back to disk, so
 * the file on disk is always the source of truth. That keeps tool calls
 * independent and lets a human open the file in the Aseprite GUI at any moment.
 */

const { ToolError } = require('../mcp');

/** Shared schema fragments. */
const DOCUMENT = {
  type: 'string',
  description:
    'Document to act on: a short name inside the art folder ("hero"), a relative path, ' +
    'or an absolute .aseprite path. Omit to use the active document.',
};

const COLOR = {
  type: 'string',
  description:
    "Colour as hex: '#rrggbb', '#rrggbbaa', '#rgb', '#rgba', '#rrggbb@aa', or a name " +
    "(black, white, red, green, blue, yellow, cyan, magenta, orange, purple, pink, gray, brown).",
};

const FRAME = {
  type: 'integer',
  description: 'Zero-based frame index (omit for the first frame).',
};

/** Build the small `{ document }` object every tool returns. */
function docSummary(workspace, filePath, extra = {}) {
  return {
    document: workspace.display(filePath),
    path: filePath,
    ...extra,
  };
}

/** Trim the verbose sprite report from Lua into something an agent can read. */
function spriteReport(sprite, workspace, extras = {}) {
  if (!sprite) return extras;
  return {
    ...extras,
    document: workspace.display(sprite.path),
    size: `${sprite.width}x${sprite.height}`,
    colorMode: sprite.colorMode,
    frames: sprite.frameCount,
    layers: sprite.layerCount,
    paletteSize: sprite.paletteSize,
    ...(sprite.tags && sprite.tags.length ? { tags: sprite.tags } : {}),
  };
}

function register(server, ctx) {
  const { aseprite, workspace } = ctx;

  const call = (cmd, args, filePath) =>
    aseprite.run(cmd, args, { doc: filePath });

  //================================================================ create ==

  server.tool({
    name: 'aseprite_create_sprite',
    description:
      'Create a new pixel-art document and make it active. Every other tool works on this ' +
      'file. Coordinates are 0-based with the origin at the TOP-LEFT, x growing right and y ' +
      'growing down. Choose a small canvas: 16-32 px for characters and items, 64-128 px for ' +
      'scenes. Set `frames` up front when planning an animation.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { ...DOCUMENT, description: 'Name for the new document, e.g. "hero". Defaults to "sprite".' },
        width: { type: 'integer', description: 'Canvas width in pixels (default 32).', minimum: 1, maximum: 4096 },
        height: { type: 'integer', description: 'Canvas height in pixels (default 32).', minimum: 1, maximum: 4096 },
        colorMode: {
          type: 'string',
          enum: ['rgb', 'indexed', 'grayscale'],
          description: 'rgb (default, 16M colours), indexed (fixed palette, classic console look), grayscale.',
        },
        background: {
          type: ['string', 'null'],
          description: "Fill the canvas with this colour. Default is transparent.",
        },
        frames: { type: 'integer', description: 'Create this many frames immediately (default 1).', minimum: 1, maximum: 2048 },
        layerName: { type: 'string', description: 'Name of the first layer (default "Layer 1").' },
        palette: {
          type: 'array',
          items: { type: 'string' },
          description: 'Palette colours for indexed mode.',
        },
        paletteSize: { type: 'integer', description: 'Palette size for indexed mode when `palette` is omitted.' },
        overwrite: { type: 'boolean', description: 'Overwrite the document if it already exists.' },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document || 'sprite', { mustExist: false });
      const fs = require('node:fs');
      if (fs.existsSync(filePath) && !args.overwrite) {
        throw new ToolError(
          `Document already exists: ${filePath}. Pass overwrite: true to replace it, ` +
            'or choose another name.',
        );
      }
      const data = await call(
        'sprite_create',
        {
          width: args.width ?? 32,
          height: args.height ?? 32,
          colorMode: args.colorMode ?? 'rgb',
          background: args.background ?? null,
          frames: args.frames ?? 1,
          layerName: args.layerName,
          palette: args.palette,
          paletteSize: args.paletteSize,
        },
        filePath,
      );
      workspace.setActiveDocument(filePath);
      return spriteReport(data.sprite, workspace, {
        created: true,
        hint: 'Add pixels with aseprite_pixels (rectangular pixel data) or aseprite_draw (lines, shapes, fills). Preview with aseprite_view.',
      });
    },
  });

  //================================================================== open ==

  server.tool({
    name: 'aseprite_open',
    description:
      'Point the server at an existing .aseprite file (absolute path, or a path inside the art ' +
      'folder) and make it active. Use this to continue work on a file, or to work on art the ' +
      'user already has.',
    inputSchema: {
      type: 'object',
      properties: { document: { ...DOCUMENT, description: 'Path to an existing .aseprite file.' } },
      required: ['document'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document, { mustExist: true });
      const data = await call('sprite_info', {}, filePath);
      workspace.setActiveDocument(filePath);
      return spriteReport(data.sprite, workspace, { opened: true });
    },
  });

  //================================================================== info ==

  server.tool({
    name: 'aseprite_info',
    description:
      'Report a document\'s size, colour mode, layer list, frame list (with durations) and ' +
      'tags. Call this when you need to re-orient before editing, or to confirm a change landed.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document, { mustExist: true });
      const data = await call('sprite_info', {}, filePath);
      return { ...spriteReport(data.sprite, workspace), detail: data.sprite };
    },
  });

  //================================================================ layers ==

  server.tool({
    name: 'aseprite_add_layer',
    description:
      'Add a layer. Good practice for pixel art: separate layers for outline, base colour ' +
      'blocks, shading and highlights, so you can revise one without touching the others.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        name: { type: 'string', description: 'Layer name, e.g. "outline" or "shading".' },
        opacity: { type: 'integer', description: 'Layer opacity 0-255 (default 255).', minimum: 0, maximum: 255 },
        blendMode: {
          type: 'string',
          description: 'Blend mode name, e.g. normal, multiply, screen, overlay, add.',
        },
        below: { type: 'string', description: 'Insert this layer directly below the named layer.' },
        above: { type: 'string', description: 'Insert this layer directly above the named layer.' },
      },
      required: ['name'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'layer_add',
        { name: args.name, opacity: args.opacity, blendMode: args.blendMode, below: args.below, above: args.above },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { addedLayer: args.name });
    },
  });

  server.tool({
    name: 'aseprite_set_layer',
    description: 'Change a layer\'s opacity, visibility, blend mode, or rename it.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        name: { type: 'string', description: 'Existing layer name.' },
        newName: { type: 'string', description: 'Rename the layer to this.' },
        opacity: { type: 'integer', minimum: 0, maximum: 255, description: 'Opacity 0-255.' },
        visible: { type: 'boolean', description: 'Show or hide the layer.' },
        blendMode: { type: 'string', description: 'Blend mode name.' },
      },
      required: ['name'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'layer_set',
        { name: args.name, newName: args.newName, opacity: args.opacity, visible: args.visible, blendMode: args.blendMode },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { updatedLayer: args.name });
    },
  });

  server.tool({
    name: 'aseprite_remove_layer',
    description: 'Delete a layer and everything drawn on it.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT, name: { type: 'string', description: 'Layer to delete.' } },
      required: ['name'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('layer_remove', { name: args.name }, filePath);
      return spriteReport(data.sprite, workspace, { removedLayer: args.name });
    },
  });

  server.tool({
    name: 'aseprite_merge_layer_down',
    description:
      'Merge a layer into the one beneath it. Use at the end of a piece, or to flatten shading ' +
      'into a base layer.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        name: { type: 'string', description: 'Layer to merge down (default: the bottom layer).' },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('layer_merge_down', { name: args.name }, filePath);
      return spriteReport(data.sprite, workspace);
    },
  });

  //================================================================ frames ==

  server.tool({
    name: 'aseprite_add_frames',
    description:
      'Insert empty frames. Frame indices are 0-based. Use `mode` to control where they land ' +
      'relative to an existing frame. Frames start empty, so draw into each one afterwards ' +
      '(aseprite_draw accepts a `frame` argument).',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        count: { type: 'integer', description: 'How many frames to add (default 1).', minimum: 1, maximum: 512 },
        mode: {
          type: 'string',
          enum: ['after', 'before', 'end'],
          description: 'Place after `index` (default), before it, or at the end of the timeline.',
        },
        index: { ...FRAME, description: 'Reference frame (default 0).' },
        durationMs: { type: 'integer', description: 'Frame duration in milliseconds (default 100).' },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'frame_add',
        { count: args.count ?? 1, mode: args.mode ?? 'end', index: (args.index ?? 0) + 1, durationMs: args.durationMs },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { addedFrames: data.addedFrames });
    },
  });

  server.tool({
    name: 'aseprite_remove_frame',
    description: 'Delete a frame. Refuses to remove the last remaining frame.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT, index: FRAME },
      required: ['index'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('frame_remove', { index: args.index + 1 }, filePath);
      return spriteReport(data.sprite, workspace, { removedFrame: args.index });
    },
  });

  server.tool({
    name: 'aseprite_set_frame_duration',
    description:
      'Set frame durations in milliseconds. Applies to a range when `from`/`to` are given, ' +
      'otherwise to every frame. 100 ms = 10 fps is a good default; 40-80 ms suits fast ' +
      'actions like a run cycle.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        durationMs: { type: 'integer', description: 'Duration in milliseconds (default 100).', minimum: 1, maximum: 60000 },
        from: FRAME,
        to: FRAME,
      },
      required: ['durationMs'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'frame_set_duration',
        {
          durationMs: args.durationMs,
          from: args.from === undefined ? undefined : args.from + 1,
          to: args.to === undefined ? undefined : args.to + 1,
        },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { durationMs: data.durationMs });
    },
  });

  server.tool({
    name: 'aseprite_duplicate_frame',
    description:
      'Copy a frame (all layers) to the next slot. The fastest way to build an animation: ' +
      'duplicate, then move or redraw only the parts that change.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT, index: FRAME, durationMs: { type: 'integer', description: 'Duration for the copy in ms.' } },
      required: ['index'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('frame_duplicate', { index: args.index + 1, durationMs: args.durationMs }, filePath);
      return spriteReport(data.sprite, workspace, { duplicatedFrame: args.index });
    },
  });

  server.tool({
    name: 'aseprite_move_frame',
    description: 'Reorder the timeline by moving one frame to another position.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT, from: { ...FRAME, description: 'Frame to move.' }, to: { ...FRAME, description: 'Destination index.' } },
      required: ['from', 'to'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('frame_move', { from: args.from + 1, to: args.to + 1 }, filePath);
      return spriteReport(data.sprite, workspace);
    },
  });

  server.tool({
    name: 'aseprite_copy_cel',
    description:
      'Copy one layer\'s artwork from one frame to another (a cel = one layer on one frame). ' +
      'Useful for holding poses, or stamping a base drawing across a new animation.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        fromFrame: { ...FRAME, description: 'Source frame.' },
        toFrame: { ...FRAME, description: 'Destination frame.' },
        fromLayer: { type: 'string', description: 'Source layer (default: active layer).' },
        toLayer: { type: 'string', description: 'Destination layer (default: same as source).' },
      },
      required: ['fromFrame', 'toFrame'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'copy_cel',
        {
          fromFrame: args.fromFrame + 1,
          toFrame: args.toFrame + 1,
          fromLayer: args.fromLayer,
          toLayer: args.toLayer,
        },
        filePath,
      );
      return spriteReport(data.sprite, workspace);
    },
  });

  //=================================================================== tag ==

  server.tool({
    name: 'aseprite_set_tag',
    description:
      'Create or update a named animation tag spanning a frame range (e.g. "walk" frames 0-5). ' +
      'Tags are what game engines export as separate animations, and users can play them in ' +
      'the Aseprite timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        name: { type: 'string', description: 'Tag name, e.g. "idle", "walk", "attack".' },
        from: FRAME,
        to: FRAME,
        direction: { type: 'string', enum: ['forward', 'reverse', 'pingpong'], description: 'Playback direction.' },
        repeat: { type: 'integer', description: 'Repeat count (0 = loop forever).', minimum: 0 },
        color: COLOR,
      },
      required: ['name', 'from', 'to'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'tag_set',
        {
          name: args.name,
          from: args.from + 1,
          to: args.to + 1,
          direction: args.direction,
          frameRepeats: args.repeat,
          color: args.color,
        },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { tag: args.name });
    },
  });

  server.tool({
    name: 'aseprite_remove_tag',
    description: 'Delete an animation tag by name.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT, name: { type: 'string', description: 'Tag to remove.' } },
      required: ['name'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('tag_remove', { name: args.name }, filePath);
      return spriteReport(data.sprite, workspace, { removedTag: args.name });
    },
  });

  server.tool({
    name: 'aseprite_set_loop',
    description: 'Restrict playback/export looping to a frame range of the whole sprite.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT, from: FRAME, to: FRAME },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'loop_set',
        {
          from: args.from === undefined ? undefined : args.from + 1,
          to: args.to === undefined ? undefined : args.to + 1,
        },
        filePath,
      );
      return spriteReport(data.sprite, workspace);
    },
  });

  //=============================================================== palette ==

  server.tool({
    name: 'aseprite_set_palette',
    description:
      'Replace the document palette with an explicit colour list. In indexed mode this is the ' +
      'actual set of colours the artwork can use - which is how you keep a piece to a tight, ' +
      'coherent palette.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        colors: { type: 'array', items: COLOR, description: 'Ordered list of hex colours.' },
        size: { type: 'integer', description: 'Palette size (defaults to the number of colours).' },
        remap: { type: 'string', enum: ['nearest'], description: 'In indexed mode, remap existing pixels to the nearest new colour.' },
      },
      required: ['colors'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('palette_set', { colors: args.colors, size: args.size, remap: args.remap }, filePath);
      return spriteReport(data.sprite, workspace);
    },
  });

  server.tool({
    name: 'aseprite_load_palette',
    description:
      'Apply a well-known retro palette by name, or load one from a .gpl/.ase file. Great ' +
      'starting point for a coherent piece. Presets: pico8, gameboy, nes, db16, db32, ' +
      'sweetie16, endesga32.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        preset: {
          type: 'string',
          enum: ['pico8', 'gameboy', 'nes', 'db16', 'db32', 'sweetie16', 'endesga32'],
          description: 'Built-in palette name.',
        },
        file: { type: 'string', description: 'Absolute path to a .gpl or .ase palette file.' },
      },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      if (!args.preset && !args.file) {
        throw new ToolError('Provide either `preset` or `file`.');
      }
      const data = await call('palette_load', { preset: args.preset, file: args.file }, filePath);
      return spriteReport(data.sprite, workspace, { paletteColors: data.colors?.length });
    },
  });

  server.tool({
    name: 'aseprite_get_palette',
    description: 'List the document\'s current palette as hex colours.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      return call('palette_get', {}, filePath);
    },
  });

  server.tool({
    name: 'aseprite_quantize_palette',
    description:
      'Reduce the artwork to N colours (k-means) and snap every pixel to the result. Use this ' +
      'to tame a messy palette or to hit a retro constraint like 16 colours.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        count: { type: 'integer', description: 'Target number of colours (default 16).', minimum: 2, maximum: 256 },
        remap: { type: 'boolean', description: 'Repaint pixels to the new palette (default true).' },
      },
      required: ['count'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('palette_quantize', { count: args.count, remap: args.remap !== false }, filePath);
      return spriteReport(data.sprite, workspace, { colors: data.colors });
    },
  });

  //================================================================ canvas ==

  server.tool({
    name: 'aseprite_resize_canvas',
    description:
      'Change the canvas size without scaling the artwork. Use it to add room for an attack ' +
      'animation or breathing space around a character.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        width: { type: 'integer', minimum: 1, maximum: 4096 },
        height: { type: 'integer', minimum: 1, maximum: 4096 },
        anchor: {
          type: 'string',
          enum: ['top-left', 'center', 'top-right', 'bottom-left', 'bottom-right'],
          description: 'Where existing artwork sits in the new canvas (default top-left).',
        },
      },
      required: ['width', 'height'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('sprite_resize_canvas', { width: args.width, height: args.height, anchor: args.anchor }, filePath);
      return spriteReport(data.sprite, workspace);
    },
  });

  server.tool({
    name: 'aseprite_crop',
    description: 'Crop every frame to a rectangle. Use to trim dead space around the artwork.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        x: { type: 'integer', description: 'Left edge (0-based).' },
        y: { type: 'integer', description: 'Top edge (0-based).' },
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('sprite_crop', { x: args.x, y: args.y, width: args.width, height: args.height }, filePath);
      return spriteReport(data.sprite, workspace);
    },
  });

  server.tool({
    name: 'aseprite_scale_sprite',
    description:
      'Scale the whole sprite (all frames and layers). Use integer factors like 2 or 4 for ' +
      'pixel-art upscaling; non-integer scaling blurs pixels unless Aseprite is set to nearest ' +
      'neighbour.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        width: { type: 'integer', minimum: 1, maximum: 8192 },
        height: { type: 'integer', minimum: 1, maximum: 8192 },
      },
      required: ['width', 'height'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('sprite_resize', { width: args.width, height: args.height }, filePath);
      return spriteReport(data.sprite, workspace);
    },
  });

  server.tool({
    name: 'aseprite_flatten',
    description: 'Flatten all visible layers into one. Do this last, once the composition is settled.',
    inputSchema: {
      type: 'object',
      properties: { document: DOCUMENT },
      required: [],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('sprite_flatten', {}, filePath);
      return spriteReport(data.sprite, workspace);
    },
  });

  //============================================================= transform ==

  server.tool({
    name: 'aseprite_transform',
    description:
      'Flip, rotate by 90/180/270, or add a 1 px outline to the artwork. Outlines are the ' +
      'classic way to make sprite art read clearly against any background.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        action: { type: 'string', enum: ['flip', 'rotate', 'outline'], description: 'What to do.' },
        target: { type: 'string', enum: ['sprite', 'layer', 'frame'], description: 'Scope of the operation (default sprite).' },
        axis: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Flip axis (default horizontal).' },
        degrees: { type: 'integer', enum: [90, 180, 270], description: 'Rotation angle (default 90).' },
        layer: { type: 'string', description: 'Layer name for target "layer" or for outlining a single layer.' },
        color: { ...COLOR, description: 'Outline colour (default black).' },
        outside: { type: 'boolean', description: 'For outline: draw outside the silhouette (default true).' },
        frames: { type: 'array', items: { type: 'integer' }, description: 'Limit the transform to these frame indices.' },
      },
      required: ['action'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'transform',
        {
          action: args.action,
          target: args.target ?? 'sprite',
          axis: args.axis,
          degrees: args.degrees,
          layer: args.layer,
          color: args.color,
          outside: args.outside,
          frames: args.frames,
        },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { applied: data.applied });
    },
  });

  server.tool({
    name: 'aseprite_replace_color',
    description:
      'Replace every pixel of one colour with another across the whole document. Handy for ' +
      'recolouring a character, or swapping a shade across all frames at once.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        from: { ...COLOR, description: 'Colour to replace.' },
        to: { ...COLOR, description: 'Replacement colour.' },
        tolerance: { type: 'integer', description: 'Per-channel tolerance 0-255 (default 0 = exact).', minimum: 0, maximum: 255 },
      },
      required: ['from', 'to'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call('replace_color', { from: args.from, to: args.to, tolerance: args.tolerance }, filePath);
      return spriteReport(data.sprite, workspace, { pixelsChanged: data.pixelsChanged });
    },
  });

  server.tool({
    name: 'aseprite_erase',
    description: 'Erase a rectangular region (make it transparent) on a layer, across frames.',
    inputSchema: {
      type: 'object',
      properties: {
        document: DOCUMENT,
        layer: { type: 'string', description: 'Layer to erase from (default active/first layer).' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
        frames: { type: 'array', items: { type: 'integer' }, description: 'Frame indices (default: all frames).' },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    async handler(args) {
      const filePath = workspace.resolveDocument(args.document);
      const data = await call(
        'erase',
        {
          layer: args.layer,
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          frames: args.frames ? args.frames.map((f) => f + 1) : undefined,
        },
        filePath,
      );
      return spriteReport(data.sprite, workspace, { pixelsErased: data.pixelsErased });
    },
  });
}

module.exports = { register, spriteReport, docSummary, DOCUMENT, COLOR, FRAME };
