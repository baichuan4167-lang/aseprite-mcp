'use strict';

/**
 * Spawns the MCP server as a real client would and speaks JSON-RPC over stdio.
 * Used by the smoke test and the demo so both exercise the actual protocol
 * instead of calling the tool functions directly.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

class Client {
  constructor(options = {}) {
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.options = options;
  }

  async start() {
    this.child = spawn(process.execPath, [SERVER], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buffer = '';
    this.child.stdout.on('data', (data) => {
      buffer += data.toString();
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        }
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

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, this.options.timeoutMs || 180000);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
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
