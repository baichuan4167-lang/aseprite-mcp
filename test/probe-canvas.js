'use strict';

/**
 * Focused diagnostic for the canvas operations. Run: node test/probe-canvas.js
 * Not part of the normal suite; kept because canvas resize/crop hit several
 * Aseprite API dead ends and this is the fastest way to re-check them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./harness');

const WS = path.join(process.env.TEMP || '/tmp', 'aseprite-canvas-probe');

(async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  process.stderr.write(`workspace: ${WS}\n`);

  const c = new Client({ cwd: WS });
  await c.start();
  const j = (r) => {
    const t = (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
    try { return JSON.parse(t); } catch { return t; }
  };
  const attempt = async (label, name, args) => {
    try {
      const r = await c.call(name, args);
      const v = j(r);
      process.stdout.write(`${label.padEnd(14)}: size=${v.size} layers=${v.layers} frames=${v.frames}\n`);
      return v;
    } catch (e) {
      process.stdout.write(`${label.padEnd(14)}: ERROR: ${e.message.slice(0, 300)}\n`);
      return null;
    }
  };

  try {
    await attempt('create', 'aseprite_create_sprite', { document: 'cv', width: 16, height: 16 });
    await attempt('resize_canvas', 'aseprite_resize_canvas', { document: 'cv', width: 24, height: 20, anchor: 'top-left' });
    await attempt('crop', 'aseprite_crop', { document: 'cv', x: 0, y: 0, width: 20, height: 16 });
    await attempt('scale', 'aseprite_scale_sprite', { document: 'cv', width: 40, height: 32 });
  } finally {
    await c.stop();
  }
})();
