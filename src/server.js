#!/usr/bin/env node
'use strict';

/**
 * Aseprite MCP server.
 *
 * Lets an agent create and edit pixel art and animations by driving Aseprite in
 * headless batch mode. All work happens on real .aseprite files so the user can
 * open the result in the Aseprite GUI at any point.
 *
 * Transport: JSON-RPC 2.0 over stdio.
 * Configuration (environment variables):
 *   ASEPRITE_PATH                Full path to aseprite.exe (auto-detected otherwise).
 *   ASEPRITE_MCP_WORKSPACE       Workspace root. Defaults to the session cwd.
 *   ASEPRITE_MCP_ART_ROOT        Where documents live. Defaults to <workspace>/art.
 *   ASEPRITE_MCP_EXPORT_ROOT     Where exports land. Defaults to <workspace>/out.
 *   ASEPRITE_MCP_TIMEOUT_MS      Per-invocation timeout. Defaults to 120000.
 */

const path = require('node:path');
const { Aseprite } = require('./aseprite');
const { McpServer } = require('./mcp');
const { Workspace } = require('./workspace');

const VERSION = require('../package.json').version;

async function main() {
  const workspaceRoot = process.env.ASEPRITE_MCP_WORKSPACE
    ? path.resolve(process.env.ASEPRITE_MCP_WORKSPACE)
    : process.cwd();

  const workspace = new Workspace({
    root: workspaceRoot,
    artRoot: process.env.ASEPRITE_MCP_ART_ROOT,
    exportRoot: process.env.ASEPRITE_MCP_EXPORT_ROOT,
  });

  const aseprite = new Aseprite({
    executable: process.env.ASEPRITE_PATH || process.env.ASEPRITE_EXE || null,
    timeoutMs: Number(process.env.ASEPRITE_MCP_TIMEOUT_MS || 120000),
  });

  const server = new McpServer({
    name: 'aseprite',
    version: VERSION,
    instructions: [
      'Draw pixel art and animations with Aseprite.',
      '',
      'Workflow:',
      '  1. aseprite_create_sprite  - pick a small canvas (16-32 px for characters/items).',
      '  2. Draw with aseprite_pixels (rectangular blocks of hex colours), or aseprite_draw',
      '     (lines, shapes, gradients, dithering, text).',
      '  3. aseprite_view to LOOK at the result as an image, then refine. Always look before',
      '     declaring a piece finished.',
      '  4. Animate with aseprite_add_frames / aseprite_duplicate_frame, then draw per frame',
      '     (aseprite_draw_across_frames moves the same shapes per frame).',
      '  5. aseprite_set_tag to name an animation, then export with aseprite_export_gif or',
      '     aseprite_export_sprite_sheet.',
      '',
      'Coordinates are 0-based from the top-left. The .aseprite file on disk is always the',
      'source of truth, so the user can open it in Aseprite at any time.',
    ].join('\n'),
  });

  const ctx = { server, aseprite, workspace };

  require('./tools/sprite').register(server, ctx);
  require('./tools/draw').register(server, ctx);
  require('./tools/export').register(server, ctx);

  // Verify the install up front so the failure is obvious and actionable,
  // but never block startup: the client still gets tools/list either way.
  try {
    const probe = await aseprite.probe();
    process.stderr.write(
      `[aseprite-mcp] ${probe.version || 'Aseprite'} at ${probe.executable}\n` +
        `[aseprite-mcp] workspace ${workspace.root} (art: ${workspace.artRoot})\n` +
        `[aseprite-mcp] ${server.tools.size} tools ready\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[aseprite-mcp] WARNING: ${error.message}\n` +
        '[aseprite-mcp] Set ASEPRITE_PATH to the full path of aseprite.exe.\n',
    );
  }

  const shutdown = () => {
    aseprite.dispose();
  };
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
  process.on('exit', shutdown);

  server.listen();
}

main().catch((error) => {
  process.stderr.write(`[aseprite-mcp] fatal: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
