'use strict';

/**
 * Static checks that need no Aseprite installation, so CI can run them on any
 * machine.
 *
 *   1. Every JavaScript file parses (`node --check`).
 *   2. No source file starts with a UTF-8 BOM — a `.lua` file with a BOM is an
 *      immediate syntax error in Aseprite, and this has bitten the project.
 *   3. The Lua library parses, when an Aseprite binary is available. Aseprite
 *      compiles the whole script before running it, so pointing it at the
 *      library with no command file exercises the parser without doing any work.
 *
 * Run: node test/syntax-check.js
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { candidateExecutables } = require('../src/aseprite');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'art', 'out', '.git', '.aseprite-mcp']);

let failures = 0;
const report = (ok, label, detail) => {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n      ${detail}`}\n`);
};

/** Recursively list files, skipping generated output. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function findAseprite() {
  if (process.env.ASEPRITE_PATH && fs.existsSync(process.env.ASEPRITE_PATH)) {
    return process.env.ASEPRITE_PATH;
  }
  for (const candidate of candidateExecutables()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const files = walk(ROOT);

//--------------------------------------------------------------- JavaScript --

const jsFiles = files.filter((f) => f.endsWith('.js'));
const jsFailures = [];
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    jsFailures.push(`${path.relative(ROOT, file)}\n${(result.stderr || '').trim().split('\n').slice(0, 4).join('\n')}`);
  }
}
report(jsFailures.length === 0, `${jsFiles.length} JavaScript files parse`, jsFailures.join('\n\n'));

//---------------------------------------------------------------------- BOM --

const textFiles = files.filter((f) => /\.(js|lua|md|json|yml|yaml)$/.test(f));
const bomFiles = [];
for (const file of textFiles) {
  const head = Buffer.alloc(3);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 3, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) bomFiles.push(path.relative(ROOT, file));
}
report(bomFiles.length === 0, `${textFiles.length} text files carry no UTF-8 BOM`, bomFiles.join('\n'));

//---------------------------------------------------------------------- Lua --

const luaLib = path.join(ROOT, 'src', 'lua', 'aseprite_lib.lua');
const aseprite = findAseprite();
if (!aseprite) {
  process.stdout.write('SKIP  Lua library parses (no Aseprite installation found; set ASEPRITE_PATH)\n');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aseprite-mcp-lua-'));
  const cmdPath = path.join(tmp, 'cmd.json');
  const outPath = path.join(tmp, 'out.json');
  fs.writeFileSync(cmdPath, JSON.stringify({ cmd: '__syntax_check__', args: {} }), 'utf8');
  const result = spawnSync(aseprite, ['-b', '--script', luaLib], {
    encoding: 'utf8',
    env: { ...process.env, ASEPRITE_CMD: cmdPath, ASEPRITE_OUT: outPath },
    timeout: 60000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  // A syntax error is reported before anything runs, as "<file>:<line>: <message>".
  // An unknown-command error means the file parsed and reached main().
  const syntaxError = /aseprite_lib\.lua:\d+:/.test(output) && !/unknown command/.test(output);
  report(!syntaxError, 'Lua library parses', output.trim().split('\n').slice(0, 5).join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? '\nAll static checks passed.\n' : `\n${failures} static check(s) FAILED\n`);
if (failures) process.exitCode = 1;
