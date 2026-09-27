'use strict';

/** Focused diagnostic for aseprite_frames_from_grids. Run: node test/probe-grids.js */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./harness');

const WS = path.join(process.env.TEMP || '/tmp', 'aseprite-grids-probe');

const GRIDS = [
  ['..kk..', '.kkkk.'],
  ['......', '.kkkk.'],
];
const EXPECTED = GRIDS.flat().join('').split('').filter((c) => c === 'k').length;

(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  const c = new Client({ cwd: WS });
  await c.start();
  const j = (r) => {
    const t = (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
    try { return JSON.parse(t); } catch { return t; }
  };
  try {
    process.stdout.write(`expected grid pixels: ${EXPECTED}\n`);
    await c.call('aseprite_create_sprite', { document: 'g', width: 8, height: 8, frames: 2 });
    const r = await c.call('aseprite_frames_from_grids', { document: 'g', grids: GRIDS, key: { k: '#ff0000' } });
    process.stdout.write(`reported: ${JSON.stringify(j(r))}\n`);

    // verify each frame independently
    for (const f of [0, 1]) {
      const insp = await c.call('aseprite_inspect_pixels', { document: 'g', frame: f });
      const text = (insp.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
      process.stdout.write(`\n--- frame ${f} ---\n`);
      process.stdout.write(text.split('\n').slice(3, 11).join('\n') + '\n');
    }
  } catch (e) {
    process.stdout.write(`ERROR: ${e.message.slice(0, 700)}\n`);
  } finally {
    await c.stop();
  }
})();
