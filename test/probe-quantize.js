'use strict';

/** Diagnostic: does palette quantization preserve colours that are already few? */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./harness');

const WS = path.join(process.env.TEMP || '/tmp', 'aseprite-quant-probe');

// Four visually distinct colours plus an outline.
const KEY = { k: '#1a1c2c', a: '#ff0000', b: '#00ff00', c: '#0000ff', d: '#ffffff' };
const GRID = [
  'kkkkkkkk',
  'kaabbccd',
  'kabcdabc',
  'kkkkkkkk',
];

(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  const c = new Client({ cwd: WS });
  await c.start();
  const j = (r) => JSON.parse((r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join(''));
  const show = async (label) => {
    const pal = j(await c.call('aseprite_get_palette', { document: 'q' }));
    const picks = [];
    for (const [x, y, want] of [[1, 1, 'red'], [3, 1, 'green'], [5, 1, 'blue'], [7, 1, 'white']]) {
      const p = j(await c.call('aseprite_pick_color', { document: 'q', x, y }));
      picks.push(`${want}=${p.hex}`);
    }
    process.stdout.write(`${label}\n  picks: ${picks.join(' ')}\n  palette(${pal.colors.length}): ${pal.colors.slice(0, 12).join(' ')}\n`);
  };

  try {
    await c.call('aseprite_create_sprite', { document: 'q', width: 8, height: 4, overwrite: true });
    await c.call('aseprite_pixels', { document: 'q', rows: GRID, key: KEY, x: 0, y: 0 });
    await show('after drawing 5 known colours:');

    const q = j(await c.call('aseprite_quantize_palette', { document: 'q', count: 5 }));
    process.stdout.write(`quantize(5) -> ${q.colors ? q.colors.join(' ') : JSON.stringify(q)}\n`);
    await show('after quantize(5):');
  } catch (e) {
    process.stdout.write(`ERROR: ${e.message.slice(0, 500)}\n`);
  } finally {
    await c.stop();
  }
})();
