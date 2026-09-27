'use strict';

/**
 * Demo: draw a complete animated character through the MCP server and export
 * it, exercising the same tool calls an agent would make.
 *
 * Run: node test/demo-art.js
 * Writes into <workspace>/art and <workspace>/out.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./harness');

const WORKSPACE = path.resolve(__dirname, '..');
const W = 16;
const H = 24;

/**
 * Palette: one outline plus eight shades. Keeping a tight, coherent ramp like
 * this is most of what makes low-resolution pixel art read well.
 */
const P = {
  k: '#1a1c2c', // outline
  h: '#e8b796', // hair highlight
  H: '#c28569', // hair shade
  s: '#ffcd75', // skin
  S: '#d99a5b', // skin shade
  c: '#41a6f6', // tunic
  C: '#2b6cb0', // tunic shade
  t: '#8f563b', // trousers
  o: '#5a3921', // boots
};

/**
 * Head: hair cap over a face, outline all the way around. Character art at this
 * size lives or dies on the silhouette, so the sides are strictly symmetric.
 */
const HEAD = [
  '.....kkkkkk.....',
  '...kkhhhhhhkk...',
  '..khhhhhhhhhhk..',
  '..khhssssssshk..',
  '..khsssssssshk..',
  '..khsksssskshk..',
  '..khsssssssshk..',
  '...kssssssssk...',
  '....kkkkkkkk....',
];

/**
 * Torso. The shoulders are knitted into the top rows so the arms connect
 * cleanly; the walk cycle swings the sleeve rows added per frame.
 */
const TORSO = [
  '..kkcccccccckk..',
  '.kcccccccccccck.',
  '.kccCCCCCCCCcck.',
  '.kcccccccccccck.',
  '..kcccccccccck..',
  '...kttttttttk...',
];

/**
 * Leg poses, one per frame. Alternating which leg leads is what makes a walk
 * read as a walk rather than a shuffle. The first row is the hip, which stays
 * put so the legs always meet the body.
 */
const LEGS = [
  // 0: contact - both legs together
  ['...kttttttttk...', '....ktt..ttk....', '....ktt..ttk....', '....koo..ook....', '....kkk..kkk....'],
  // 1: leading leg forward, trailing leg back
  ['...kttttttttk...', '...ktt...ttk....', '..ktt.....ttk...', '..koo.....ook...', '..kkk.....kkk...'],
  // 2: passing pose - legs together, body lifted
  ['...kttttttttk...', '....ktt..ttk....', '....ktt..ttk....', '....koo..ook....', '....kkk..kkk....'],
  // 3: mirror of frame 1
  ['...kttttttttk...', '....ktt...ttk...', '...ktt.....ttk..', '...koo.....ook..', '...kkk.....kkk..'],
];

/** Arm swing per frame: vertical offset of the left and right sleeve. */
const SLEEVES = [
  [0, 0],
  [1, -1],
  [0, 0],
  [-1, 1],
];

/** Vertical bounce: the body lifts on the passing pose. */
const BOUNCE = [0, 0, -1, 0];

const TORSO_TOP = 10;

/** Compose one animation frame as rows of palette characters. */
function buildFrame(i) {
  const canvas = new Array(H).fill('.'.repeat(W));
  const put = (row, y) => {
    if (y < 0 || y >= H) return;
    const line = [...canvas[y]];
    [...row].forEach((ch, x) => {
      if (ch !== '.' && x < W) line[x] = ch;
    });
    canvas[y] = line.join('');
  };

  const bounce = BOUNCE[i];
  HEAD.forEach((row, idx) => put(row, idx + bounce));
  TORSO.forEach((row, idx) => put(row, TORSO_TOP + idx + bounce));
  LEGS[i].forEach((row, idx) => put(row, TORSO_TOP + TORSO.length + idx));

  // Sleeves hang off the shoulders and swing forward/back with the stride.
  // They sit just inside the torso's outline columns.
  const [leftY, rightY] = SLEEVES[i];
  const armRows = ['kc', 'kcc'];
  for (const [sleeveY, x] of [[leftY, 1], [rightY, W - 4]]) {
    armRows.forEach((arm, idx) => put(at(x, arm), TORSO_TOP + 1 + sleeveY + idx + bounce));
  }

  return canvas;
}

/** Right-pad `text` after placing it at column `x` of a W-wide row. */
function at(x, text) {
  return '.'.repeat(x) + text + '.'.repeat(Math.max(0, W - x - text.length));
}
(async () => {
  const client = new Client({ cwd: WORKSPACE });
  await client.start();
  const json = (r) => JSON.parse((r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
  const log = (s) => process.stdout.write(`${s}\n`);

  try {
    log('1. create the sprite');
    const created = json(
      await client.call('aseprite_create_sprite', {
        document: 'walker',
        width: W,
        height: H,
        frames: 4,
        layerName: 'character',
        overwrite: true,
      }),
    );
    log(`   ${created.size}, ${created.frames} frames, ${created.layers} layer`);

    log('2. draw the four animation frames in one call');
    const grids = [0, 1, 2, 3].map(buildFrame);
    const drawn = json(
      await client.call('aseprite_frames_from_grids', {
        document: 'walker',
        grids,
        key: P,
      }),
    );
    log(`   ${drawn.pixelsWritten} pixels painted across the timeline`);

    log('3. tighten the palette to the 12 colours the piece already uses');
    // Quantize while the artwork is the only layer: the translucent shadow
    // added next must not feed into the palette reduction.
    const quant = json(await client.call('aseprite_quantize_palette', { document: 'walker', count: 12 }));
    log(`   ${quant.colors.join(' ')}`);

    log('4. add a translucent ground shadow on its own layer');
    await client.call('aseprite_add_layer', { document: 'walker', name: 'shadow', below: 'character' });
    await client.call('aseprite_draw_across_frames', {
      document: 'walker',
      layer: 'shadow',
      ops: [{ op: 'ellipse', cx: 8, cy: 19, rx: 5, ry: 1, color: '#1a1c2c', filled: true }],
      frames: [0, 1, 2, 3],
    });
    // soften it so it reads as a shadow rather than a black bar
    await client.call('aseprite_set_layer', { document: 'walker', name: 'shadow', opacity: 70 });

    log('5. set a snappy 90 ms frame time');
    await client.call('aseprite_set_frame_duration', { document: 'walker', durationMs: 90 });

    log('6. tag the cycle as "walk"');
    const tagged = json(
      await client.call('aseprite_set_tag', { document: 'walker', name: 'walk', from: 0, to: 3, direction: 'forward', repeat: 0 }),
    );
    log(`   tags: ${tagged.tags.map((t) => t.name).join(', ')}`);

    log('7. look at every frame');
    for (let f = 0; f < 4; f += 1) {
      const view = await client.call('aseprite_view', { document: 'walker', frame: f, includeAscii: true });
      const img = (view.content || []).find((c) => c.type === 'image');
      const outFile = path.join(WORKSPACE, 'out', `walker-frame-${f}.png`);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, Buffer.from(img.data, 'base64'));
      const ascii = (view.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const map = ascii.split('Pixel map')[1];
      log(`\n   --- frame ${f} (${outFile}) ---`);
      if (map) {
        log(
          map
            .split('\n')
            .slice(2, 2 + H)
            .map((l) => `   ${l}`)
            .join('\n'),
        );
      }
    }

    log('\n8. export deliverables');
    const gif = json(await client.call('aseprite_export_gif', { document: 'walker', output: 'walker.gif', scale: 6 }));
    log(`   GIF       ${gif.bytes} bytes -> ${gif.output}`);

    const sheet = json(
      await client.call('aseprite_export_sprite_sheet', {
        document: 'walker',
        output: 'walker-sheet.png',
        sheetType: 'horizontal',
        tag: 'walk',
        shapePadding: 1,
        scale: 4,
      }),
    );
    log(`   sheet     ${sheet.sheetBytes} bytes -> ${sheet.output}`);
    log(`   metadata           -> ${sheet.dataOutput}`);

    const seq = json(await client.call('aseprite_export_sequence', { document: 'walker', outputDir: 'walker-sequence', scale: 4 }));
    log(`   sequence  ${seq.count} files -> ${seq.outputDir}`);

    const png = json(await client.call('aseprite_export_png', { document: 'walker', output: 'walker.png', frame: 1, scale: 6 }));
    log(`   still     ${png.width}x${png.height} -> ${png.output}`);

    log('\n9. document on disk');
    const info = json(await client.call('aseprite_info', { document: 'walker' }));
    log(`   ${info.document} - ${info.size}, ${info.frames} frames, ${info.layers} layers, ${info.paletteSize} palette entries`);
    log(`   layers: ${info.detail.layers.map((l) => l.name).join(', ')}`);
    log(`   frames: ${info.detail.frames.map((f) => `${f.durationMs}ms`).join(', ')}`);

    log('\nDone.');
  } catch (error) {
    process.stderr.write(`\nDemo failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await client.stop();
  }
})();
