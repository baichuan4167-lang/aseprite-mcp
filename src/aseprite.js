'use strict';

/**
 * Spawns Aseprite in headless batch mode and runs a command through
 * `src/lua/aseprite_lib.lua`.
 *
 * Two details drive this design:
 *
 *  1. Aseprite's `--script-param` does not reach `app.params` in batch mode
 *     (verified against 1.3.18.3-dev), so the request travels as a JSON file
 *     whose path is passed through the environment.
 *  2. `app.exit()` is not honoured from a batch script, so the real outcome is
 *     read from the result JSON rather than the process exit code. A crash
 *     (exit code -1, no result file) is still reported as a failure.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const LUA_LIB = path.join(__dirname, 'lua', 'aseprite_lib.lua');

/** Candidate install locations, checked in order. */
function candidateExecutables() {
  const list = [];
  if (process.env.ASEPRITE_PATH) list.push(process.env.ASEPRITE_PATH);
  if (process.env.ASEPRITE_EXE) list.push(process.env.ASEPRITE_EXE);

  const roots = [
    'C:\\Program Files\\Aseprite',
    'C:\\Program Files (x86)\\Aseprite',
    'D:\\Program Files\\Aseprite',
    'D:\\Aseprite',
    'D:\\SteamLibrary\\steamapps\\common\\Aseprite',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Aseprite',
  ];
  for (const root of roots) list.push(path.join(root, 'aseprite.exe'));
  return list;
}

class AsepriteError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'AsepriteError';
    this.details = details || {};
  }
}

class Aseprite {
  /**
   * @param {object} [options]
   * @param {string} [options.executable] Explicit path to aseprite.exe.
   * @param {number} [options.timeoutMs] Per-invocation timeout.
   */
  constructor(options = {}) {
    this.explicitExecutable = options.executable || null;
    this.timeoutMs = options.timeoutMs || 120000;
    this._resolved = null;
    this._queue = new Map();
    this._tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aseprite-mcp-'));
  }

  /** Locate aseprite.exe once and remember it. */
  resolveExecutable() {
    if (this._resolved) return this._resolved;
    if (this.explicitExecutable) {
      if (!fs.existsSync(this.explicitExecutable)) {
        throw new AsepriteError(
          `ASEPRITE_PATH points at a file that does not exist: ${this.explicitExecutable}`,
        );
      }
      this._resolved = this.explicitExecutable;
      return this._resolved;
    }
    for (const candidate of candidateExecutables()) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          this._resolved = candidate;
          return candidate;
        }
      } catch {
        /* keep looking */
      }
    }
    throw new AsepriteError(
      'Could not find aseprite.exe. Set the ASEPRITE_PATH environment variable ' +
        'to the full path of aseprite.exe (or ASEPRITE_EXE).',
      { searched: candidateExecutables() },
    );
  }

  /** Serialise invocations that touch the same document. */
  async _withLock(key, fn) {
    const previous = this._queue.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this._queue.set(key, previous.then(() => current));
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this._queue.get(key) === current) this._queue.delete(key);
    }
  }

  /**
   * Run one command.
   * @param {string} cmd Operation name (a key of the Lua OPS table).
   * @param {object} [args] Operation arguments.
   * @param {object} [options]
   * @param {string} [options.doc] Absolute path to the .aseprite document.
   * @returns {Promise<object>} The `data` object produced by Lua.
   */
  async run(cmd, args = {}, options = {}) {
    const lockKey = options.doc ? path.resolve(options.doc) : `cmd:${cmd}`;
    return this._withLock(lockKey, () => this._invoke(cmd, args, options));
  }

  async _invoke(cmd, args, options) {
    const executable = this.resolveExecutable();
    const stamp = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const cmdPath = path.join(this._tmpRoot, `${stamp}.cmd.json`);
    const outPath = path.join(this._tmpRoot, `${stamp}.out.json`);

    const request = { cmd, args: args || {} };
    if (options.doc) request.doc = path.resolve(options.doc);

    await fsp.writeFile(cmdPath, JSON.stringify(request), 'utf8');

    const env = {
      ...process.env,
      ASEPRITE_CMD: cmdPath,
      ASEPRITE_OUT: outPath,
      // keep Aseprite from writing its own crash dumps into the workspace
      ASEPRITE_USER_FOLDER: path.join(this._tmpRoot, 'user'),
    };

    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let spawnError = null;

    try {
      const result = await new Promise((resolve) => {
        const child = spawn(executable, ['-b', '--script', LUA_LIB], {
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          resolve({ timedOut: true });
        }, this.timeoutMs);

        child.stdout.on('data', (d) => {
          stdout += d.toString();
        });
        child.stderr.on('data', (d) => {
          stderr += d.toString();
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          spawnError = err;
          resolve({ spawnError: err });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          exitCode = code;
          resolve({});
        });
      });

      if (result.spawnError || spawnError) {
        throw new AsepriteError(
          `Failed to launch Aseprite: ${(spawnError || result.spawnError).message}`,
          { executable },
        );
      }
      if (result.timedOut) {
        throw new AsepriteError(
          `Aseprite did not finish within ${this.timeoutMs} ms (command "${cmd}").`,
          { executable, cmd },
        );
      }

      let payload = null;
      try {
        const raw = await fsp.readFile(outPath, 'utf8');
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }

      if (!payload) {
        throw new AsepriteError(
          `Aseprite did not return a result for "${cmd}". It exited with code ${exitCode}.`,
          { cmd, exitCode, stdout: stdout.trim(), stderr: cleanStderr(stderr) },
        );
      }

      if (!payload.ok) {
        // Lua-level failure: surface it as-is, it is already user-facing.
        throw new AsepriteError(payload.error || `Command "${cmd}" failed.`, {
          cmd,
          log: cleanStderr(stderr),
        });
      }

      const data = payload.data || {};
      const warnings = cleanStderr(stderr);
      if (warnings) data._log = warnings;
      return data;
    } finally {
      await Promise.allSettled([
        fsp.unlink(cmdPath).catch(() => {}),
        fsp.unlink(outPath).catch(() => {}),
      ]);
    }
  }

  /** Report install details without running a sprite command. */
  async probe() {
    const executable = this.resolveExecutable();
    const version = await new Promise((resolve) => {
      const child = spawn(executable, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d.toString();
      });
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(out.trim()));
    });
    return { executable, version };
  }

  dispose() {
    try {
      fs.rmSync(this._tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Strip Aseprite's own chatter so only our warnings survive. */
function cleanStderr(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .filter((line) => line.includes('[aseprite-mcp]'))
    .map((line) => line.replace(/^\[aseprite-mcp\]\s*/, ''))
    .join('\n')
    .trim();
}

module.exports = { Aseprite, AsepriteError, LUA_LIB, candidateExecutables };
