'use strict';

/**
 * Diagnose child-process spawning in restricted environments.
 *
 * Some CI sandboxes deny piped stdio, which makes the MCP stdio harness
 * unspawnable even though the Node binary is valid. This prints what actually
 * works so the failure is not a mystery. Run: node test/spawn-diagnostic.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'src', 'server.js');

function probe(label, options) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(`${label.padEnd(28)} ${result}`);
    };
    let child;
    try {
      child = spawn(process.execPath, ['-e', 'process.exit(0)'], options);
    } catch (error) {
      finish(`THREW ${error.code || error.message}`);
      return;
    }
    child.on('error', (error) => finish(`ERROR ${error.code} ${error.syscall || ''}`));
    child.on('spawn', () => {
      child.on('close', (code) => finish(`ok (exit ${code})`));
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish('TIMEOUT');
    }, 8000);
  });
}

(async () => {
  const tmp = path.join(os.tmpdir(), 'aseprite-mcp-spawn-diag');
  fs.mkdirSync(tmp, { recursive: true });

  process.stdout.write(`platform      : ${process.platform}\n`);
  process.stdout.write(`node          : ${process.version}\n`);
  process.stdout.write(`execPath      : ${process.execPath}\n`);
  process.stdout.write(`execPath exists: ${fs.existsSync(process.execPath)}\n`);
  process.stdout.write(`cwd           : ${process.cwd()}\n`);
  process.stdout.write(`tmpdir exists : ${fs.existsSync(tmp)}\n\n`);

  process.stdout.write(`${await probe('inherit all', { stdio: 'inherit' })}\n`);
  process.stdout.write(`${await probe('ignore all', { stdio: 'ignore' })}\n`);
  process.stdout.write(`${await probe('pipes only', { stdio: ['pipe', 'pipe', 'pipe'] })}\n`);
  process.stdout.write(`${await probe('pipes + cwd=tmpdir', { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmp })}\n`);
  process.stdout.write(`${await probe('ignore + cwd=tmpdir', { stdio: 'ignore', cwd: tmp })}\n`);

  // The real thing: can we start the server itself at all?
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => {
      process.stdout.write(`server w/ ignore stdio     ERROR ${error.code}\n`);
      resolve();
    });
    child.on('spawn', () => {
      process.stdout.write('server w/ ignore stdio     spawned\n');
      setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
    });
  });
})();
