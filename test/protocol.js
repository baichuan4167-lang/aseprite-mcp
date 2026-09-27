'use strict';

/**
 * Protocol-level checks that need no Aseprite installation.
 *
 * The server must start, complete the MCP handshake, and publish a complete,
 * well-formed tool catalog even when Aseprite cannot be found — the tools fail
 * at call time with a clear message, they do not disappear.
 *
 * This drives `src/server.js` in-process rather than spawning it, so it runs
 * anywhere, including CI sandboxes that refuse to spawn a piped child. The
 * spawned path is covered by test/smoke.js, which needs a real Aseprite anyway.
 *
 * Run: node test/protocol.js
 */

const os = require('node:os');
const path = require('node:path');
const { Client } = require('./harness');

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n      ${detail}`}\n`);
};

/** Tools that must exist for the documented workflow to be possible. */
const REQUIRED_TOOLS = [
  'aseprite_create_sprite',
  'aseprite_open',
  'aseprite_info',
  'aseprite_add_layer',
  'aseprite_set_layer',
  'aseprite_remove_layer',
  'aseprite_add_frames',
  'aseprite_remove_frame',
  'aseprite_duplicate_frame',
  'aseprite_set_frame_duration',
  'aseprite_set_tag',
  'aseprite_pixels',
  'aseprite_frames_from_grids',
  'aseprite_draw',
  'aseprite_draw_across_frames',
  'aseprite_text',
  'aseprite_set_palette',
  'aseprite_load_palette',
  'aseprite_quantize_palette',
  'aseprite_view',
  'aseprite_onion_preview',
  'aseprite_pick_color',
  'aseprite_export_png',
  'aseprite_export_gif',
  'aseprite_export_sequence',
  'aseprite_export_sprite_sheet',
  'aseprite_status',
];

(async () => {
  // An empty workspace and a deliberately bogus Aseprite path, so this runs on
  // a machine that has neither.
  const workspace = path.join(os.tmpdir(), 'aseprite-mcp-protocol');
  process.env.ASEPRITE_PATH = path.join(workspace, 'definitely-not-aseprite.exe');
  process.env.ASEPRITE_MCP_WORKSPACE = workspace;

  const client = new Client({ cwd: workspace });

  try {
    await client.startInProcess();
    await client._handshake();
    check(
      client.serverInfo && client.serverInfo.name === 'aseprite',
      'server completes the MCP handshake',
      JSON.stringify(client.serverInfo),
    );
    check(
      Boolean(client.capabilities && client.capabilities.tools),
      'server advertises the tools capability',
      JSON.stringify(client.capabilities),
    );

    const { tools } = await client.listTools();
    check(tools.length >= 40, `publishes its full tool catalog (${tools.length} tools)`);

    const names = tools.map((t) => t.name);
    const missing = REQUIRED_TOOLS.filter((n) => !names.includes(n));
    check(missing.length === 0, 'every documented tool is present', `missing: ${missing.join(', ')}`);

    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    check(duplicates.length === 0, 'no duplicate tool names', duplicates.join(', '));

    const badNames = names.filter((n) => !/^[a-z][a-z0-9_]*$/.test(n));
    check(badNames.length === 0, 'tool names are lowercase snake_case', badNames.join(', '));

    const noDescription = tools.filter((t) => !t.description || t.description.trim().length < 20).map((t) => t.name);
    check(noDescription.length === 0, 'every tool documents itself', noDescription.join(', '));

    const badSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object').map((t) => t.name);
    check(badSchema.length === 0, 'every tool has an object input schema', badSchema.join(', '));

    const noProperties = tools
      .filter((t) => !t.inputSchema.properties || typeof t.inputSchema.properties !== 'object')
      .map((t) => t.name);
    check(noProperties.length === 0, 'every input schema declares its properties', noProperties.join(', '));

    check(JSON.stringify(await client.request('ping', {})) === '{}', 'ping is answered');

    const unknown = await client
      .request('tools/call', { name: 'aseprite_no_such_tool', arguments: {} })
      .then(() => null)
      .catch((e) => e.message);
    check(
      typeof unknown === 'string' && unknown.includes('Unknown tool'),
      'an unknown tool name is rejected',
      String(unknown),
    );

    // A real tool call must produce a readable error (not a hang or a crash)
    // when Aseprite is missing, and the server must survive it.
    const failure = await client.callExpectingError('aseprite_status', {});
    check(failure.length > 0, 'a tool call without Aseprite returns a readable error', failure.slice(0, 200));
    check(
      JSON.stringify(await client.request('ping', {})) === '{}',
      'server stays responsive after a failed tool call',
    );
  } catch (error) {
    check(false, 'protocol checks completed', error && error.stack ? error.stack : String(error));
  } finally {
    await client.stop();
  }

  process.stdout.write(failures === 0 ? '\nAll protocol checks passed.\n' : `\n${failures} protocol check(s) FAILED\n`);
  if (failures) process.exitCode = 1;
})();
