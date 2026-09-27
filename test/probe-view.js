'use strict';

/** Diagnostic: narrow down the "expected N bytes of RGBA" failure. */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./harness');

const WS = path.join(process.env.TEMP || '/tmp', 'aseprite-view-probe');

(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  const c = new Client({ cwd: WS });
  await c.start();
  const attempt = async (label, args) => {
    try {
      const r = await c.call('aseprite_view', args);
      const i = (r.content || []).find((x) => x.type === 'image');
      const meta = (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join(' | ');
      process.stdout.write(`OK   ${label.padEnd(34)} ${meta.split('\n')[1] || ''}\n`);
    } catch (e) {
      process.stdout.write(`FAIL ${label.padEnd(34)} ${e.message.split('\n')[0].slice(0, 120)}\n`);
    }
  };

  try {
    await c.call('aseprite_create_sprite', { document: 's', width: 8, height: 8, frames: 2, layerName: 'character', overwrite: true });
    await c.call('aseprite_pixels', { document: 's', rows: ['.ssss.', 'sccccs', '.ssss.'], key: { s: '#ffcd75', c: '#41a6f6' }, x: 1, y: 2 });

    process.stdout.write('--- before adding the second layer ---\n');
    await attempt('frame 0, auto scale', { document: 's', frame: 0 });
    await attempt('frame 0, scale 1', { document: 's', frame: 0, scale: 1 });
    await attempt('frame 0, scale 12', { document: 's', frame: 0, scale: 12 });

    await c.call('aseprite_add_layer', { document: 's', name: 'shadow', below: 'character' });

    process.stdout.write('--- after adding an empty second layer ---\n');
    await attempt('frame 0, auto scale', { document: 's', frame: 0 });
    await attempt('frame 0, scale 1', { document: 's', frame: 0, scale: 1 });
    await attempt('frame 0, scale 12', { document: 's', frame: 0, scale: 12 });
    await attempt('frame 0, scale 12, layers', { document: 's', frame: 0, scale: 12, layers: ['character'] });
    await attempt('frame 1, scale 12', { document: 's', frame: 1, scale: 12 });

    await c.call('aseprite_draw', { document: 's', layer: 'shadow', ops: [{ op: 'rect', x: 0, y: 7, w: 8, h: 1, color: '#1a1c2c', filled: true }], frame: 1 });
    process.stdout.write('--- after drawing on the second layer ---\n');
    await attempt('frame 1, auto scale', { document: 's', frame: 1 });
    await attempt('frame 1, scale 12', { document: 's', frame: 1, scale: 12 });
    await attempt('frame 0, scale 12', { document: 's', frame: 0, scale: 12 });
  } catch (e) {
    process.stdout.write(`SETUP ERROR: ${e.message.slice(0, 400)}\n`);
  } finally {
    await c.stop();
  }
})();
