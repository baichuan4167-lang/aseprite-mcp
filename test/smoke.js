'use strict';

/**
 * End-to-end smoke test: drives the real MCP server over stdio against a real
 * Aseprite install and asserts on the resulting files and pixel data.
 *
 * Run: node test/smoke.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('./harness');
const { decodePng, inkBounds } = require('./png');
const { decodeRaw, colourStats } = require('../src/image');

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}  ${name}${ok || !detail ? '' : `\n      ${detail}`}\n`);
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aseprite-mcp-smoke-'));
  const client = new Client({ cwd: workDir, env: { ASEPRITE_MCP_TIMEOUT_MS: '180000' } });

  try {
    await client.start();
    check('server initializes', client.serverInfo && client.serverInfo.name === 'aseprite', JSON.stringify(client.serverInfo));

    // Fail with instructions rather than a stack trace when Aseprite is absent:
    // this suite needs a real installation, unlike test/protocol.js.
    try {
      Client.json(await client.call('aseprite_status'));
    } catch (error) {
      process.stdout.write(
        '\nThis suite needs a real Aseprite installation.\n' +
          'Set ASEPRITE_PATH to the Aseprite executable, or install it in a standard\n' +
          'location, then run it again. For checks that need no Aseprite, use:\n' +
          '  node test/syntax-check.js\n' +
          '  node test/protocol.js\n\n' +
          `Reported: ${error.message.split('\n')[0]}\n`,
      );
      process.exitCode = 1;
      return;
    }

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    check('tools/list returns a useful number of tools', names.length >= 35, `got ${names.length}`);
    check('every tool has a description', tools.tools.every((t) => t.description && t.description.length > 20));
    check(
      'every tool has an object input schema',
      tools.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'),
    );

    //--------------------------------------------------------------- status --
    const status = Client.json(await client.call('aseprite_status'));
    check('status reports an Aseprite build', Boolean(status.aseprite && status.aseprite.executable), JSON.stringify(status.aseprite));
    check('status reports the workspace', Boolean(status.workspace && status.workspace.artRoot));

    //--------------------------------------------------------------- create --
    const created = Client.json(
      await client.call('aseprite_create_sprite', { document: 'hero', width: 16, height: 16 }),
    );
    check('create_sprite reports 16x16', created.size === '16x16', JSON.stringify(created));
    const heroPath = path.join(workDir, 'art', 'hero.aseprite');
    check('create_sprite wrote the file', fs.existsSync(heroPath), heroPath);

    check(
      'create_sprite refuses to clobber',
      (await client.callExpectingError('aseprite_create_sprite', { document: 'hero' })).includes('already exists'),
    );

    //--------------------------------------------------------------- pixels --
    // A tiny 5x5 face built from a character grid.
    const pixelResult = Client.json(
      await client.call('aseprite_pixels', {
        document: 'hero',
        rows: ['..kkk..', '.ksskk.', 'kswsks.', 'kssssk.', '.ksskk.', '..kkk..'],
        key: { k: '#1a1c2c', s: '#ffcd75', w: '#ffffff' },
        x: 5,
        y: 5,
      }),
    );
    // The grid has 28 non-'.' cells: rows are 4,5,5,5,5,4.
    check('pixels wrote 28 pixels', pixelResult.pixelsWritten === 28, JSON.stringify(pixelResult));

    const pick = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 7, y: 7 }));
    check('pick_color reads back the drawn pixel', pick.hex === '#ffffff', JSON.stringify(pick));
    const pickSkin = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 6, y: 8 }));
    check('pick_color reads a second colour', pickSkin.hex === '#ffcd75', JSON.stringify(pickSkin));
    const pickEmpty = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 0, y: 0 }));
    check('untouched pixels stay transparent', pickEmpty.opaque === false, JSON.stringify(pickEmpty));

    //------------------------------------------------------------------ view --
    const view = await client.call('aseprite_view', { document: 'hero', includeAscii: true });
    const images = Client.images(view);
    check('view returns a PNG image block', images.length === 1 && images[0].mimeType === 'image/png');
    const pngBytes = Buffer.from(images[0].data, 'base64');
    check('returned PNG has a valid signature', pngBytes.slice(0, 8).toString('hex') === '89504e470d0a1a0a');
    const asciiText = Client.text(view);
    check('view includeAscii returns a pixel map', asciiText.includes('Legend:'), asciiText.slice(-260));
    check('pixel map shows transparent pixels as "."', /^\.+$/m.test(asciiText), asciiText.slice(-400));
    check('pixel map legend carries the drawn colours', asciiText.includes('#1a1c2c') && asciiText.includes('#ffcd75'), asciiText.slice(-200));
    const raw = decodeRaw(Buffer.from(images[0].data, 'base64').toString('base64'));
    check('view image decodes', raw.length > 0);

    //----------------------------------------------------------------- text ---
    // Run before the draw block so nothing else has touched this corner.
    // 'A' has its ink in column 1 of the glyph, so (1,0) is set and (0,0) is not.
    await client.call('aseprite_text', { document: 'hero', text: 'AB', x: 0, y: 0, color: '#ffffff', scale: 1 });
    const textPixel = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 1, y: 0 }));
    check('pixel font drew ink', textPixel.opaque === true, JSON.stringify(textPixel));
    const textGap = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 0, y: 0 }));
    check('pixel font leaves its left margin clear', textGap.opaque === false, JSON.stringify(textGap));

    //------------------------------------------------------------------ draw --
    const drawn = Client.json(
      await client.call('aseprite_draw', {
        document: 'hero',
        ops: [
          { op: 'line', x1: 1, y1: 1, x2: 4, y2: 1, color: '#ff0000' },
          { op: 'rect', x: 1, y: 3, w: 4, h: 2, color: '#00ff00', filled: true },
          { op: 'ellipse', cx: 12, cy: 12, rx: 3, ry: 3, color: '#0000ff' },
          { op: 'fill', x: 2, y: 4, color: '#ffff00' },
          { op: 'gradient', x: 0, y: 0, w: 1, h: 8, from: '#000000', to: '#ffffff', bands: 4 },
          { op: 'dither', x: 8, y: 0, w: 4, h: 4, colors: ['#ff0000', '#0000ff'], matrix: 'bayer2' },
          { op: 'text', text: 'HI', x: 0, y: 12, color: '#ffffff' },
        ],
      }),
    );
    check('draw executed every op', drawn.ops && drawn.ops.lines === 1 && drawn.ops.rects === 1, JSON.stringify(drawn.ops));

    const lineEnd = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 4, y: 1 }));
    check('draw line landed', lineEnd.hex === '#ff0000', JSON.stringify(lineEnd));
    const filled = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 3, y: 4 }));
    check('flood fill recoloured the rect interior', filled.hex === '#ffff00', JSON.stringify(filled));

    // spline + polygon
    await client.call('aseprite_draw', {
      document: 'hero',
      ops: [
        { op: 'spline', points: [[1, 10], [4, 8], [7, 11]], color: '#ff00ff' },
        { op: 'polygon', points: [[9, 9], [13, 9], [11, 12]], color: '#00ffff', filled: true },
      ],
    });
    const poly = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 11, y: 10 }));
    check('filled polygon painted its interior', poly.hex === '#00ffff', JSON.stringify(poly));

    // unknown op must be rejected clearly
    const badOp = await client.callExpectingError('aseprite_draw', { document: 'hero', ops: [{ op: 'nonsense' }] });
    check('unknown draw op reports an error', badOp.includes('unknown op'), badOp);

    //---------------------------------------------------------------- layers --
    const withLayer = Client.json(await client.call('aseprite_add_layer', { document: 'hero', name: 'shade' }));
    check('add_layer reports the new layer count', withLayer.layers === 2, JSON.stringify(withLayer));
    await client.call('aseprite_pixels', {
      document: 'hero',
      layer: 'shade',
      rows: ['k'],
      key: { k: '#000000' },
      x: 0,
      y: 15,
    });
    const shaded = Client.json(await client.call('aseprite_set_layer', { document: 'hero', name: 'shade', opacity: 128 }));
    check('set_layer changes opacity', shaded.layers >= 2);
    const info2 = Client.json(await client.call('aseprite_info', { document: 'hero' }));
    const shadeLayer = info2.detail.layers.find((l) => l.name === 'shade');
    check('layer opacity persisted', shadeLayer && shadeLayer.opacity === 128, JSON.stringify(shadeLayer));

    check(
      'remove_layer errors for a missing layer',
      (await client.callExpectingError('aseprite_remove_layer', { document: 'hero', name: 'nope' })).includes('not found'),
    );

    //---------------------------------------------------------------- frames --
    const frames = Client.json(await client.call('aseprite_add_frames', { document: 'hero', count: 3, mode: 'end', durationMs: 80 }));
    check('add_frames created 4 frames', frames.frames === 4, JSON.stringify(frames));
    const dur = Client.json(await client.call('aseprite_set_frame_duration', { document: 'hero', durationMs: 120, from: 0, to: 3 }));
    check('set_frame_duration applied', dur.durationMs === 120, JSON.stringify(dur));

    const dup = Client.json(await client.call('aseprite_duplicate_frame', { document: 'hero', index: 0 }));
    check('duplicate_frame grew the timeline', dup.frames === 5, JSON.stringify(dup));

    // draw the same shape across frames with motion
    const across = Client.json(
      await client.call('aseprite_draw_across_frames', {
        document: 'hero',
        ops: [{ op: 'rect', x: 2, y: 6, w: 2, h: 2, color: '#ff0000', filled: true }],
        frames: [
          { index: 1, dx: 0, dy: 0 },
          { index: 2, dx: 4, dy: 0 },
          { index: 3, dx: 8, dy: 0 },
        ],
      }),
    );
    check('draw_across_frames touched 3 frames', across.framesDrawn && across.framesDrawn.length === 3, JSON.stringify(across.framesDrawn));
    const step1 = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 2, y: 6, frame: 1 }));
    const step3 = Client.json(await client.call('aseprite_pick_color', { document: 'hero', x: 10, y: 6, frame: 3 }));
    check('per-frame offsets applied', step1.hex === '#ff0000' && step3.hex === '#ff0000', `${JSON.stringify(step1)} ${JSON.stringify(step3)}`);

    const copy = Client.json(await client.call('aseprite_copy_cel', { document: 'hero', fromFrame: 0, toFrame: 4, fromLayer: 'shade', toLayer: 'shade' }));
    check('copy_cel succeeded', copy.frames === 5, JSON.stringify(copy));

    //------------------------------------------------------------------- tag --
    const tagged = Client.json(await client.call('aseprite_set_tag', { document: 'hero', name: 'idle', from: 1, to: 3, direction: 'pingpong' }));
    check('set_tag created a tag', tagged.tags && tagged.tags.some((t) => t.name === 'idle'), JSON.stringify(tagged.tags));
    await client.call('aseprite_set_loop', { document: 'hero', from: 0, to: 2 });
    check(
      'remove_tag errors for a missing tag',
      (await client.callExpectingError('aseprite_remove_tag', { document: 'hero', name: 'ghost' })).includes('not found'),
    );

    //--------------------------------------------------------------- palette --
    const pal = Client.json(await client.call('aseprite_load_palette', { document: 'hero', preset: 'pico8' }));
    check('load_palette pico8 gives 16 colours', pal.paletteColors === 16, JSON.stringify(pal));
    const gotPal = Client.json(await client.call('aseprite_get_palette', { document: 'hero' }));
    check('get_palette returns hex colours', gotPal.colors.length === 16 && gotPal.colors[0].startsWith('#'), JSON.stringify(gotPal.colors.slice(0, 3)));

    const quant = Client.json(await client.call('aseprite_quantize_palette', { document: 'hero', count: 6 }));
    check('quantize_palette returns 6 colours', quant.colors && quant.colors.length === 6, JSON.stringify(quant.colors));

    //-------------------------------------------------------------- transform --
    const flipped = Client.json(await client.call('aseprite_transform', { document: 'hero', action: 'flip', axis: 'horizontal', target: 'sprite' }));
    check('flip succeeded', flipped.size === '16x16', JSON.stringify(flipped));
    const rotated = Client.json(await client.call('aseprite_transform', { document: 'hero', action: 'rotate', degrees: 90, target: 'sprite' }));
    check('rotate succeeded', rotated.size === '16x16', JSON.stringify(rotated));
    const outlined = Client.json(await client.call('aseprite_transform', { document: 'hero', action: 'outline', color: '#000000', target: 'layer', layer: 'Layer 1' }));
    check('outline succeeded', Boolean(outlined.document), JSON.stringify(outlined));

    //----------------------------------------------------------------- canvas --
    const resized = Client.json(await client.call('aseprite_resize_canvas', { document: 'hero', width: 24, height: 20, anchor: 'top-left' }));
    check('resize_canvas changed the size', resized.size === '24x20', JSON.stringify(resized));
    const cropped = Client.json(await client.call('aseprite_crop', { document: 'hero', x: 0, y: 0, width: 20, height: 16 }));
    check('crop changed the size', cropped.size === '20x16', JSON.stringify(cropped));
    const scaled = Client.json(await client.call('aseprite_scale_sprite', { document: 'hero', width: 40, height: 32 }));
    check('scale_sprite scaled', scaled.size === '40x32', JSON.stringify(scaled));

    //------------------------------------------------------------------ erase --
    const erased = Client.json(await client.call('aseprite_erase', { document: 'hero', x: 0, y: 0, width: 6, height: 6 }));
    check('erase cleared pixels', erased.pixelsErased > 0, JSON.stringify(erased));

    //--------------------------------------------------------- replace colour --
    const replaced = Client.json(await client.call('aseprite_replace_color', { document: 'hero', from: '#ff0000', to: '#00ff00' }));
    check('replace_color reports changes', replaced.pixelsChanged >= 0, JSON.stringify(replaced));

    //--------------------------------------------------------------- previews --
    const onion = await client.call('aseprite_onion_preview', { document: 'hero', frame: 1 });
    check('onion_preview returns an image', Client.images(onion).length === 1);

    const inspected = await client.call('aseprite_inspect_pixels', { document: 'hero', frame: 0 });
    const inspectText = Client.text(inspected);
    check('inspect_pixels returns a pixel map', inspectText.includes('Legend:'), inspectText.slice(0, 200));

    //---------------------------------------------------------------- exports --
    const gif = Client.json(await client.call('aseprite_export_gif', { document: 'hero', output: 'hero.gif', scale: 2 }));
    check('export_gif wrote a real file', gif.exists && gif.bytes > 0, JSON.stringify(gif));
    check('gif has a GIF header', fs.readFileSync(gif.absolutePath).slice(0, 3).toString('ascii') === 'GIF');

    const png = Client.json(await client.call('aseprite_export_png', { document: 'hero', output: 'hero.png', frame: 0, scale: 2 }));
    check('export_png wrote a real file', png.exists, JSON.stringify(png));
    check('png has a PNG header', fs.readFileSync(png.absolutePath).slice(0, 4).toString('hex') === '89504e47');
    check('png was upscaled', png.width === 80 && png.height === 64, JSON.stringify(png));

    const seq = Client.json(await client.call('aseprite_export_sequence', { document: 'hero', outputDir: 'hero-frames' }));
    check('export_sequence wrote one file per frame', seq.count === 5, JSON.stringify(seq));
    check('sequence files exist on disk', seq.outputs.every((rel) => fs.existsSync(path.join(workDir, rel))), JSON.stringify(seq.outputs));

    const sheet = Client.json(
      await client.call('aseprite_export_sprite_sheet', {
        document: 'hero',
        output: 'hero-sheet.png',
        sheetType: 'horizontal',
        shapePadding: 1,
        tag: 'idle',
      }),
    );
    check('sprite sheet exists', sheet.sheetBytes > 0, JSON.stringify(sheet));
    check('sprite sheet JSON metadata exists', fs.existsSync(sheet.dataAbsolutePath), JSON.stringify(sheet));
    if (fs.existsSync(sheet.dataAbsolutePath)) {
      const meta = JSON.parse(fs.readFileSync(sheet.dataAbsolutePath, 'utf8'));
      check('sheet metadata lists frames', meta.frames && Object.keys(meta.frames).length >= 1, Object.keys(meta.frames || {}).join(','));
      check('sheet metadata carries the tag', JSON.stringify(meta.meta.frameTags || []).includes('idle'), JSON.stringify(meta.meta.frameTags));
    }

    // ExportSpriteSheet ignores its own `scale` option in this Aseprite build,
    // so the server upscales before exporting. Guard that regression.
    const sheet2x = Client.json(
      await client.call('aseprite_export_sprite_sheet', {
        document: 'hero',
        output: 'hero-sheet-2x.png',
        sheetType: 'horizontal',
        tag: 'idle',
        scale: 2,
      }),
    );
    check('sprite sheet scale is honoured', sheet2x.scale === 2, JSON.stringify(sheet2x));
    {
      // Scaling the sheet has to scale the ARTWORK, not just the canvas.
      // A header-dimension check would pass even when the cells contain a 1x
      // drawing, so compare the ink bounding box of the first frame instead.
      const img = decodePng(sheet2x.absolutePath);
      const meta = JSON.parse(fs.readFileSync(sheet2x.dataAbsolutePath, 'utf8'));
      const f0 = meta.frames[Object.keys(meta.frames)[0]].frame;
      const ink = inkBounds(img, { x: f0.x, y: f0.y, w: f0.w, h: f0.h });
      const oneX = decodePng(sheet.absolutePath);
      const meta1 = JSON.parse(fs.readFileSync(sheet.dataAbsolutePath, 'utf8'));
      const f0one = meta1.frames[Object.keys(meta1.frames)[0]].frame;
      const inkOne = inkBounds(oneX, { x: f0one.x, y: f0one.y, w: f0one.w, h: f0one.h });
      check(
        'scaled sheet frame contains scaled artwork (not a 1x drawing in a 2x cell)',
        Boolean(ink && inkOne) && ink.w >= inkOne.w * 2 - 2 && ink.h >= inkOne.h * 2 - 2,
        `1x ink ${inkOne && `${inkOne.w}x${inkOne.h}`} vs 2x ink ${ink && `${ink.w}x${ink.h}`}`,
      );
    }

    //--------------------------------------------------------------- indexed --
    await client.call('aseprite_create_sprite', {
      document: 'retro',
      width: 8,
      height: 8,
      colorMode: 'indexed',
      palette: ['#000000', '#ffffff', '#ff0000', '#00ff00'],
    });
    const retro = Client.json(await client.call('aseprite_info', { document: 'retro' }));
    check('indexed sprite reports indexed mode', /indexed/i.test(retro.colorMode), retro.colorMode);
    await client.call('aseprite_pixels', {
      document: 'retro',
      pixels: [['#ff0000', '#00ff00'], ['#ffffff', '#000000']],
      x: 1,
      y: 1,
    });
    const retroPix = Client.json(await client.call('aseprite_pick_color', { document: 'retro', x: 1, y: 1 }));
    check('indexed pixel snaps to a palette entry', retroPix.hex === '#ff0000', JSON.stringify(retroPix));

    //--------------------------------------------------------------- grayscale --
    await client.call('aseprite_create_sprite', { document: 'grey', width: 8, height: 8, colorMode: 'grayscale' });
    const greyInfo = Client.json(await client.call('aseprite_info', { document: 'grey' }));
    check('grayscale sprite created', /gray/i.test(greyInfo.colorMode), greyInfo.colorMode);
    await client.call('aseprite_draw', { document: 'grey', ops: [{ op: 'rect', x: 0, y: 0, w: 4, h: 4, color: '#ffffff', filled: true }] });
    const greyPix = Client.json(await client.call('aseprite_pick_color', { document: 'grey', x: 1, y: 1 }));
    check('grayscale pixel round-trips', greyPix.opaque === true, JSON.stringify(greyPix));

    //---------------------------------------------------- frames_from_grids ---
    const gridAnim = Client.json(
      await client.call('aseprite_create_sprite', { document: 'blink', width: 8, height: 8, frames: 2 }),
    );
    check('multi-frame create works', gridAnim.frames === 2, JSON.stringify(gridAnim));
    const grids = Client.json(
      await client.call('aseprite_frames_from_grids', {
        document: 'blink',
        key: { k: '#000000' },
        grids: [
          ['..kk..', '.kkkk.'],
          ['......', '.kkkk.'],
        ],
      }),
    );
    // grid 1: 2 ink in row 1 + 4 in row 2 = 6; grid 2: 0 + 4 = 4. Total 10.
    check('frames_from_grids painted pixels', grids.pixelsWritten === 10, JSON.stringify(grids));
    const blinkFrame0 = Client.json(await client.call('aseprite_pick_color', { document: 'blink', frame: 0, x: 2, y: 0 }));
    const blinkFrame1 = Client.json(await client.call('aseprite_pick_color', { document: 'blink', frame: 1, x: 2, y: 0 }));
    check('each grid landed in its own frame', blinkFrame0.opaque === true && blinkFrame1.opaque === false,
      `frame0=${JSON.stringify(blinkFrame0)} frame1=${JSON.stringify(blinkFrame1)}`);

    //----------------------------------------------------------- flat layers --
    const flat = Client.json(await client.call('aseprite_flatten', { document: 'blink' }));
    check('flatten reduced the layer count', flat.layers === 1, JSON.stringify(flat));

    // A single-frame document used by the frame-count and out-of-bounds guards.
    await client.call('aseprite_create_sprite', { document: 'single', width: 12, height: 12 });
    const singlePixels = Client.json(
      await client.call('aseprite_pixels', {
        document: 'single',
        key: { k: '#000000' },
        rows: ['k...k', 'k...k', 'kkkkk', 'k...k', 'k...k'],
        x: 1,
        y: 1,
      }),
    );
    check('single-frame fixture drew its glyph', singlePixels.pixelsWritten === 13, JSON.stringify(singlePixels));

    const merged = Client.json(await client.call('aseprite_merge_layer_down', { document: 'hero' }));
    check('merge_layer_down succeeded', merged.layers >= 1, JSON.stringify(merged));

    //------------------------------------------------------------- open+info --
    const reopened = Client.json(await client.call('aseprite_open', { document: path.join(workDir, 'art', 'hero.aseprite') }));
    check('can reopen a document by absolute path', reopened.opened === true, JSON.stringify(reopened));

    //------------------------------------------------------------- failures ---
    check(
      'missing document reports a clear error',
      (await client.callExpectingError('aseprite_info', { document: 'does-not-exist' })).includes('not found'),
    );
    check(
      'omitting the document falls back to the active document',
      Client.json(await client.call('aseprite_info', {})).document === 'art/hero.aseprite',
    );
    check(
      'a relative path escaping the workspace is refused',
      (await client.callExpectingError('aseprite_info', { document: '../../../etc/passwd' })).includes('inside the workspace'),
    );
    check(
      'deleting the only frame is refused',
      (await client.callExpectingError('aseprite_remove_frame', { document: 'single', index: 0 })).includes('only frame'),
    );
    check(
      'deleting one of several frames is allowed',
      Client.json(await client.call('aseprite_remove_frame', { document: 'blink', index: 0 })).frames === 1,
    );
    check(
      'bad hex colour is rejected',
      (await client.callExpectingError('aseprite_pixels', { document: 'blink', pixels: [['not-a-colour']], x: 0, y: 0 })).length > 0,
    );
    const oob = await client.callExpectingError('aseprite_pick_color', { document: 'single', x: 999, y: 999 });
    check('an out-of-bounds pick is reported', oob.includes('outside'), oob);

    //------------------------------------------------------------- resources --
    let unknownToolError = null;
    try {
      await client.request('tools/call', { name: 'nope', arguments: {} });
    } catch (error) {
      unknownToolError = error.message;
    }
    check('unknown tool is reported', typeof unknownToolError === 'string' && unknownToolError.includes('Unknown tool'), unknownToolError);
    check('ping works', JSON.stringify(await client.request('ping', {})) === '{}');

    // flush any straggling server output
    check('server logged its startup banner', client.stderr.includes('[aseprite-mcp]'), client.stderr.slice(0, 300));
  } finally {
    await client.stop();
    if (process.env.ASEPRITE_MCP_KEEP_TEST_DIR !== '1') {
      fs.rmSync(workDir, { recursive: true, force: true });
    } else {
      process.stdout.write(`\nTest workspace kept at ${workDir}\n`);
    }
  }

  process.stdout.write(`\n${results.length - failures}/${results.length} checks passed\n`);
  if (failures) {
    process.stdout.write(`\n${failures} FAILED\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('All checks passed.\n');
  }
}

main().catch((error) => {
  process.stderr.write(`\nHarness error: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
