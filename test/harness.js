'use strict';

/**
 * Spawns the MCP server as a real client would and speaks JSON-RPC over stdio.
 * Used by the smoke test and the demo so both exercise the actual protocol
 * instead of calling the tool functions directly.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

/**
 * Resolve a Node binary to spawn the server with.
 *
 * `process.execPath` is normally correct, but it is not guaranteed to be
 * executable in every environment: GitHub-hosted runners have produced
 * `spawn .../bin/node ENOENT` even though the reported path is used to run the
 * test itself. Prefer it when it exists, otherwise fall back to something on
 * PATH so the suite still runs.
 */
function nodeCandidates() {
  const list = [process.execPath, process.argv[0], 'node'].filter(Boolean);
  return [...new Set(list)];
}

class Client {
  constructor(options = {}) {
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.options = options;
  }

  /**
   * Run the server with no child process at all.
   *
   * A spawned stdio server is the more faithful test, but some CI sandboxes
   * refuse to spawn a piped child (`spawn <node> ENOENT` on a binary that
   * plainly exists). This mode loads the very same `src/server.js` and captures
   * the `readline` interface it creates for stdin, so the handshake and the
   * whole tool catalogue are still verified end to end — just in one process.
   */
  startInProcess() {
    const Module = require('node:module');
    const realWrite = process.stdout.write;

    // Capture the server's replies, which are newline-delimited JSON on stdout.
    // Anything that is NOT a JSON-RPC message is passed through, so the test's
    // own output stays visible.
    const patchedWrite = (chunk, ...rest) => {
      const text = String(chunk);
      const trimmed = text.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const message = JSON.parse(trimmed);
          if (message && message.jsonrpc === '2.0') {
            this._consume(text);
            const callback = rest[rest.length - 1];
            if (typeof callback === 'function') callback();
            return true;
          }
        } catch {
          /* fall through and pass it on */
        }
      }
      return realWrite.call(process.stdout, chunk, ...rest);
    };
    this._savedWrite = patchedWrite;
    process.stdout.write = patchedWrite;

    this.inProcess = true;
    this._input = null;

    // Intercept module loading rather than patching the readline module object.
    // swc-compiled builds can hand out a distinct object per require, so
    // assigning to `readline.createInterface` is not reliable — that mistake
    // cost an afternoon already.
    const realLoad = Module._load;
    const self = this;
    Module._load = function intercepted(request, parent, isMain) {
      // Do NOT load the real readline module first: its createInterface would
      // bind the genuine process.stdin and steal `_input` from the stub.
      if (request === 'node:readline' || request === 'readline') {
        return {
          createInterface() {
            const iface = {
              handlers: {},
              on(event, handler) {
                this.handlers[event] = handler;
                return this;
              },
              close() {},
            };
            self._input = iface;
            return iface;
          },
        };
      }
      return realLoad.apply(this, arguments);
    };
    try {
      require(SERVER);
    } finally {
      Module._load = realLoad;
    }

    // The server attaches to stdin from an async main(), and registers its
    // request handler immediately after. Wait for both before sending anything.
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const ready = () => this._input && this._input.handlers && this._input.handlers.line;
      const poll = () => {
        if (ready()) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(
            new Error(
              this._input
                ? 'src/server.js attached to stdin but never registered a request handler'
                : 'src/server.js never attached to stdin; the in-process driver cannot start',
            ),
          );
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  /** Send one JSON-RPC message, to the child process or the in-process server. */
  _send(message) {
    const line = JSON.stringify(message);
    if (this.inProcess) {
      const handler = this._input && this._input.handlers && this._input.handlers.line;
      if (!handler) throw new Error('the in-process server has no stdin line handler');
      handler(line);
      return;
    }
    this.child.stdin.write(`${line}\n`);
  }

  /** Handle anything the server writes (possibly several lines at once). */
  _consume(chunk) {
    const line = chunk.trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  /**
   * Spawn the server, falling back to another Node binary if the first one
   * cannot be executed. The `error` event is handled here so a failed spawn
   * surfaces as a rejected promise instead of an unhandled event.
   */
  _spawnServer() {
    const candidates = nodeCandidates();
    const seen = [];
    return new Promise((resolve, reject) => {
      const attempt = (index) => {
        if (index >= candidates.length) {
          reject(
            new Error(
              `could not spawn the server (tried: ${candidates.join(', ')})\n${seen.join('\n')}`,
            ),
          );
          return;
        }
        const command = candidates[index];
        const child = spawn(command, [SERVER], {
          cwd: this.options.cwd,
          env: { ...process.env, ...(this.options.env || {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        child.once('error', (error) => {
          seen.push(
            `  ${command}: ${error.code} ${error.syscall || ''} path=${error.path || '?'} ` +
              `spawnargs=${JSON.stringify(error.spawnargs || [])} cwd=${this.options.cwd || process.cwd()}`,
          );
          // A binary that cannot be executed here: try the next candidate.
          if (error.code === 'ENOENT' || error.code === 'EACCES') attempt(index + 1);
          else reject(error);
        });
        child.once('spawn', () => {
          this.child = child;
          resolve();
        });
      };
      attempt(0);
    });
  }

  /** Finish the MCP handshake. Shared by both transport modes. */
  async _handshake() {
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aseprite-mcp-test', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
    this.serverInfo = init.serverInfo;
    this.capabilities = init.capabilities;
    return init;
  }

  async start() {
    await this._spawnServer();
    let buffer = '';
    this.child.stdout.on('data', (data) => {
      buffer += data.toString();
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        this._consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });

    this.child.stderr.on('data', (data) => {
      this.stderr += data.toString();
    });

    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`server exited with code ${code}`));
      }
      this.pending.clear();
    });

    return this._handshake();
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, this.options.timeoutMs || 180000);
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  listTools() {
    return this.request('tools/list', {});
  }

  /** Call a tool and throw on isError, so tests fail loudly. */
  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError) {
      const text = (result.content || []).map((c) => c.text).join('\n');
      const error = new Error(`tool ${name} failed: ${text}`);
      error.toolResult = result;
      throw error;
    }
    return result;
  }

  /** Call a tool that is expected to fail, returning the error text. */
  async callExpectingError(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (!result.isError) {
      throw new Error(`tool ${name} unexpectedly succeeded`);
    }
    return (result.content || []).map((c) => c.text).join('\n');
  }

  /** Concatenate the text blocks of a tool result. */
  static text(result) {
    return (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  /** Extract image blocks of a tool result. */
  static images(result) {
    return (result.content || []).filter((c) => c.type === 'image');
  }

  /** Parse the JSON payload of a text result. */
  static json(result) {
    return JSON.parse(Client.text(result));
  }

  async stop() {
    if (this.inProcess) {
      if (this._savedWrite) process.stdout.write = this._savedWrite;
      return;
    }
    if (!this.child) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 3000);
      this.child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { Client };
