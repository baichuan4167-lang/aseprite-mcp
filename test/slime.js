'use strict';

/**
 * A green slime with a squash-and-stretch idle animation, drawn entirely
 * through the aseprite-mcp server.
 *
 * Each pose is hand-drawn as rows of colour characters and centred on the
 * canvas by the buildGrid helper. At this size every edge pixel matters, so
 * the silhouette is authored by hand rather than derived from a formula - the
 * only thing shared between poses is the colour key.
 *
 * Run: node test/slime.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./harness');

const WORKSPACE = path.resolve(__dirname, '..');
const W = 18;
const H = 14;

const P = {
  o: '#12331f', // outline, a dark green rather than pure black
  G: '#a8f07a', // highlight
  g: '#5cc93f', // body
  d: '#2f8f3a', // shadow
  e: '#0b1f14', // eye
  w: '#ffffff', // eye glint - a single pixel each, which is what makes it read as alive
};

/**
 * Four idle poses, hand-drawn as rows and centred by buildGrid. `rest` is the
 * neutral mound, `rise` is the same blob stretched taller and narrower, and
 * `squash` is it flattened and spread. Played rest -> rise -> rest -> squash as
 * a ping-pong loop, that reads as breathing.
 */
const POSES = {
  rest: [
    '....oooooo....',
    '..ooGGGGggoo..',
    '.oGGGggggggo..',
    '.oGggggggggo..',
    '.ogggggggggo..',
    '.oggeggggeggo.',
    '.oggggggggdo..',
    'oggggggggggdo.',
    'oddgggggggggdo',
  ],
  rise: [
    '...oooooo...',
    '..oGGGGggo..',
    '.oGGGgggggo.',
    '.oGgggggggo.',
    '.oggggggggo.',
    '.oggegggeggo',
    '.ogggggggdo.',
    '.ogggggggdo.',
    'ogggggggggdo',
    'oddgggggggdo',
    'oddgggggggdo',
    '.oooooooooo.',
  ],
  squash: [
    '...oooooooo...',
    '..oGGGGgggdo..',
    '.oGggggggggdo.',
    '.oggeggggeggo.',
    '.ogggggggggdo.',
    'oddgggggggggdo',
    'oooooooooooooo',
  ],
};

/** The loop order: breathe out, settle, breathe in, settle. */
const FRAMES = [
  { pose: 'rest', label: 'rest' },
  { pose: 'rise', label: 'rise' },
  { pose: 'rest', label: 'rest2' },
  { pose: 'squash', label: 'squash' },
];

/**
 * Centre one pose's rows on the canvas and pad to full height, anchoring the
 * bottom so the slime always sits on the ground.
 */
function buildGrid(rows) {
  const grid = [];
  const topPad = H - rows.length;
  for (let i = 0; i < topPad; i += 1) grid.push('.'.repeat(W));
  for (const text of rows) {
    const pad = W - text.length;
    const left = Math.floor(pad / 2);
    grid.push('.'.repeat(Math.max(0, left)) + text + '.'.repeat(Math.max(0, pad - left)));
  }
  if (grid.length !== H) {
    throw new Error(`pose produced ${grid.length} rows, expected ${H}`);
  }
  return grid;
}

(async () => {
  const client = new Client({ cwd: WORKSPACE });
  await client.start();
  const json = (r) => JSON.parse((r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
  const log = (s) => process.stdout.write(`${s}\n`);

  try {
    log('1. create sprite');
    const created = json(
      await client.call('aseprite_create_sprite', {
        document: 'slime',
        width: W,
        height: H,
        frames: FRAMES.length,
        layerName: 'slime',
        overwrite: true,
      }),
    );
    log(`   ${created.size}, ${created.frames} frames`);

    log('2. draw all four idle poses in a single call');
    const grids = FRAMES.map(({ pose }) => buildGrid(POSES[pose]));
    FRAMES.forEach((f, i) => log(`   ${f.label}:\n${grids[i].map((r) => `     ${r}`).join('\n')}`));

    const drawn = json(await client.call('aseprite_frames_from_grids', { document: 'slime', grids, key: P }));
    log(`   ${drawn.pixelsWritten} pixels painted`);

    log('3. name the animation and set its timing');
    await client.call('aseprite_set_frame_duration', { document: 'slime', durationMs: 140 });
    await client.call('aseprite_set_tag', {
      document: 'slime', name: 'idle', from: 0, to: 3, direction: 'pingpong', repeat: 0,
    });

    log('4. look at every frame');
    for (let f = 0; f < FRAMES.length; f += 1) {
      const view = await client.call('aseprite_view', { document: 'slime', frame: f, scale: 16 });
      const img = (view.content || []).find((c) => c.type === 'image');
      const outFile = path.join(WORKSPACE, 'out', `slime-${f}-${FRAMES[f].label}.png`);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, Buffer.from(img.data, 'base64'));
    }
    log('   wrote out/slime-<n>-<pose>.png');

    log('5. export');
    const gif = json(await client.call('aseprite_export_gif', { document: 'slime', output: 'slime.gif', scale: 10 }));
    log(`   GIF    ${gif.bytes} bytes -> ${gif.output}`);
    const sheet = json(await client.call('aseprite_export_sprite_sheet', {
      document: 'slime', output: 'slime-sheet.png', tag: 'idle', sheetType: 'horizontal', shapePadding: 1, scale: 10,
    }));
    log(`   sheet  ${sheet.sheetBytes} bytes -> ${sheet.output}`);
    const png = json(await client.call('aseprite_export_png', { document: 'slime', output: 'slime.png', frame: 1, scale: 16 }));
    log(`   still  ${png.width}x${png.height} -> ${png.output}`);

    const info = json(await client.call('aseprite_info', { document: 'slime' }));
    log(`\n${info.document} - ${info.size}, ${info.frames} frames, ${info.layers} layer`);
    log(`frames: ${info.detail.frames.map((f) => `${f.durationMs}ms`).join(', ')}`);
    log(`tags: ${JSON.stringify(info.tags)}`);
  } catch (error) {
    process.stderr.write(`\nFailed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await client.stop();
  }
})();
