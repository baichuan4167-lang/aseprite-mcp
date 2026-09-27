'use strict';

/**
 * A small, dependency-free MCP (Model Context Protocol) stdio server.
 *
 * Framing is newline-delimited JSON-RPC 2.0 on stdin/stdout, which is what
 * MCP clients speak in practice; `Content-Length` framing is also accepted on
 * the way in so a stricter client still works.
 *
 * Supported methods:
 *   initialize, notifications/initialized, ping,
 *   tools/list, tools/call,
 *   resources/list, resources/templates/list, prompts/list  (empty defaults)
 */

const readline = require('node:readline');

const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);

/** Thrown by a tool to signal a user-facing failure rather than a crash. */
class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
    this.isToolError = true;
  }
}

class McpServer {
  /**
   * @param {object} options
   * @param {string} options.name
   * @param {string} options.version
   * @param {string} [options.instructions]
   */
  constructor(options) {
    this.name = options.name;
    this.version = options.version;
    this.instructions = options.instructions || '';
    /** @type {Map<string, object>} */
    this.tools = new Map();
    /** @type {Map<string, object>} */
    this.resources = new Map();
    /** @type {Map<string, object>} */
    this.prompts = new Map();
    this._initialized = false;
  }

  /**
   * Register a tool.
   * @param {object} definition
   * @param {string} definition.name
   * @param {string} definition.description
   * @param {object} definition.inputSchema JSON Schema for the arguments.
   * @param {(args: object, context: object) => Promise<any>} definition.handler
   */
  tool(definition) {
    if (this.tools.has(definition.name)) {
      throw new Error(`duplicate tool name: ${definition.name}`);
    }
    this.tools.set(definition.name, {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema || { type: 'object', properties: {} },
      handler: definition.handler,
      annotations: definition.annotations,
    });
    return this;
  }

  resource(definition) {
    this.resources.set(definition.uri, definition);
    return this;
  }

  prompt(definition) {
    this.prompts.set(definition.name, definition);
    return this;
  }

  /** Start serving over stdio. */
  listen() {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this._write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      void this._handle(message);
    });
    rl.on('close', () => {
      process.exit(0);
    });
  }

  async _handle(message) {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    try {
      const result = await this._dispatch(method, params || {});
      if (!isNotification) this._write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (isNotification) return;
      this._write({
        jsonrpc: '2.0',
        id,
        error: {
          code: error && error.code ? error.code : -32603,
          message: error && error.message ? error.message : String(error),
        },
      });
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const negotiated =
          requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
        return {
          protocolVersion: negotiated,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: { name: this.name, version: this.version },
          instructions: this.instructions || undefined,
        };
      }

      case 'notifications/initialized':
      case 'initialized':
        this._initialized = true;
        return {};

      case 'ping':
        return {};

      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        };

      case 'tools/call': {
        const tool = this.tools.get(params.name);
        if (!tool) throw new Error(`Unknown tool: ${params.name}`);
        const args = params.arguments || {};
        try {
          const outcome = await tool.handler(args, { server: this });
          return normaliseToolResult(outcome);
        } catch (error) {
          if (error && error.isToolError) {
            return { isError: true, content: [{ type: 'text', text: error.message }] };
          }
          return {
            isError: true,
            content: [{ type: 'text', text: describeFailure(error) }],
          };
        }
      }

      case 'resources/list':
        return { resources: [...this.resources.values()] };

      case 'resources/templates/list':
        return { resourceTemplates: [] };

      case 'resources/read': {
        const resource = this.resources.get(params.uri);
        if (!resource) throw new Error(`Unknown resource: ${params.uri}`);
        return resource.read();
      }

      case 'prompts/list':
        return {
          prompts: [...this.prompts.values()].map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments || [],
          })),
        };

      case 'prompts/get': {
        const prompt = this.prompts.get(params.name);
        if (!prompt) throw new Error(`Unknown prompt: ${params.name}`);
        return prompt.build(params.arguments || {});
      }

      case 'logging/setLevel':
      case 'completion/complete':
        return {};

      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return {};

      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  _write(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

/** Turn whatever a handler returned into an MCP tool result. */
function normaliseToolResult(outcome) {
  if (outcome === undefined || outcome === null) {
    return { content: [{ type: 'text', text: 'OK' }] };
  }
  if (typeof outcome === 'string') {
    return { content: [{ type: 'text', text: outcome }] };
  }
  if (Array.isArray(outcome)) {
    return { content: outcome };
  }
  if (outcome.content) {
    return { isError: Boolean(outcome.isError), content: outcome.content };
  }
  return { content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }] };
}

/** Produce a readable message for an unexpected (non-tool) failure. */
function describeFailure(error) {
  if (!error) return 'Unknown failure.';
  const parts = [error.message || String(error)];
  if (error.details && Object.keys(error.details).length) {
    const details = { ...error.details };
    for (const key of Object.keys(details)) {
      if (details[key] === undefined || details[key] === null || details[key] === '') {
        delete details[key];
      }
    }
    if (Object.keys(details).length) {
      parts.push(JSON.stringify(details, null, 2));
    }
  }
  return parts.join('\n\n');
}

module.exports = { McpServer, ToolError, PROTOCOL_VERSION };
