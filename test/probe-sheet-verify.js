'use strict';

/**
 * Verify a sprite sheet actually contains the frames it claims: decode the PNG
 * and measure the ink inside one frame's rect.
 *
 * This is the check that caught the sheet-scaling bug - the canvas and the
 * metadata were both correct while the artwork inside stayed at 1x.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./harness');
const { decodePng, inkBounds } = require('./png');

const WS = path.join(process.env.TEMP || '/tmp', 'aseprite-sheet-verify');

(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  const c = new Client({ cwd: WS });
  await c.start();
  const j = (r) => JSON.parse((r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join(''));

  try {
    await c.call('aseprite_create_sprite', { document: 's', width: 18, height: 14, frames: 4, overwrite: true });
    await c.call('aseprite_frames_from_grids', {
      document: 's',
      key: { g: '#5cc93f' },
      grids: [0, 1, 2, 3].map(() => ['gggg', 'gggg']),
    });
    await c.call('aseprite_set_tag', { document: 's', name: 'idle', from: 0, to: 3, direction: 'pingpong', repeat: 0 });

    for (const scale of [1, 4, 12]) {
      const r = j(await c.call('aseprite_export_sprite_sheet', {
        document: 's', output: `sheet-${scale}.png`, tag: 'idle', sheetType: 'horizontal', scale,
      }));
      const meta = JSON.parse(fs.readFileSync(r.dataAbsolutePath, 'utf8'));
      const keys = Object.keys(meta.frames);
      const img = decodePng(r.absolutePath);
      const f0 = meta.frames[keys[0]].frame;
      // measure the ink inside just the first frame's rect
      const box = inkBounds(img, { x: f0.x, y: f0.y, w: f0.w, h: f0.h });
      process.stdout.write(
        `scale=${String(scale).padEnd(3)} png=${img.width}x${img.height}  meta=${meta.meta.size.w}x${meta.meta.size.h}  ` +
        `frame0=${f0.x},${f0.y} ${f0.w}x${f0.h}  frame0 ink bbox=${box ? `${box.w}x${box.h}` : 'empty'}\n`,
      );
    }
    process.stdout.write('expected frame0 ink bbox = 4*scale x 2*scale  (the test grid is 4x2)\n');
  } catch (e) {
    process.stdout.write(`ERROR: ${e.message.slice(0, 500)}\n`);
  } finally {
    await c.stop();
  }
})();
