'use strict';

/**
 * Resolves the "document" an agent is talking about.
 *
 * The agent mostly passes short names ("hero", "hero.aseprite") and the server
 * maps them onto a real file inside the art root. Absolute paths are honoured
 * so an agent can work on a file that already exists elsewhere. Short names are
 * always confined to the art root, which keeps a stray argument from writing
 * over something unrelated on disk.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ToolError } = require('./mcp');

const DEFAULT_EXTENSION = '.aseprite';

class Workspace {
  /**
   * @param {object} options
   * @param {string} options.root Session working directory.
   * @param {string} [options.artRoot] Where short document names live.
   * @param {string} [options.exportRoot] Where exports land by default.
   */
  constructor(options) {
    this.root = path.resolve(options.root);
    this.artRoot = path.resolve(options.artRoot || path.join(this.root, 'art'));
    this.exportRoot = path.resolve(options.exportRoot || path.join(this.root, 'out'));
    this.statePath = path.join(this.root, '.aseprite-mcp', 'state.json');
    fs.mkdirSync(this.artRoot, { recursive: true });
    fs.mkdirSync(this.exportRoot, { recursive: true });
    this._state = this._loadState();
  }

  _loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return {};
    }
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this._state, null, 2), 'utf8');
    } catch {
      /* state is a convenience only */
    }
  }

  get activeDocument() {
    return this._state.activeDocument || null;
  }

  setActiveDocument(filePath) {
    this._state.activeDocument = filePath ? path.resolve(filePath) : null;
    this._saveState();
    return this._state.activeDocument;
  }

  /**
   * Resolve a document argument to an absolute path.
   * @param {string} [name] Document name or absolute path.
   * @param {object} [options]
   * @param {boolean} [options.mustExist] Fail when the file is missing.
   * @returns {string} absolute path
   */
  resolveDocument(name, options = {}) {
    const mustExist = options.mustExist !== false;
    const explicit = name && String(name).trim().length > 0 ? String(name).trim() : null;

    let target;
    if (explicit) {
      if (path.isAbsolute(explicit)) {
        target = path.resolve(explicit);
      } else if (explicit.includes('/') || explicit.includes('\\')) {
        // relative path: resolve against the art root but stay inside the workspace
        target = path.resolve(this.artRoot, explicit);
        if (!isInside(this.root, target)) {
          throw new ToolError(
            `Relative document paths must stay inside the workspace (${this.root}). ` +
              `Received: ${explicit}`,
          );
        }
      } else {
        const withExt = path.extname(explicit) ? explicit : explicit + DEFAULT_EXTENSION;
        target = path.resolve(this.artRoot, withExt);
      }
    } else if (this.activeDocument) {
      target = this.activeDocument;
    } else {
      throw new ToolError(
        'No document given and no active document is set. Pass `document` (for example ' +
          '"hero") or call the aseprite_create_sprite tool first.',
      );
    }

    if (mustExist && !fs.existsSync(target)) {
      throw new ToolError(
        `Document not found: ${target}. ` +
          (this.activeDocument === target
            ? 'The active document no longer exists - create it or pass another name.'
            : 'Create it with aseprite_create_sprite, or pass an existing path.'),
      );
    }
    return target;
  }

  /**
   * Resolve an export target. Relative names land in the export root.
   * @param {string} name
   * @returns {string} absolute path
   */
  resolveExport(name, options = {}) {
    const fallbackExt = options.extension || '.png';
    if (!name || !String(name).trim()) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const base = options.basename || 'export';
      return path.join(this.exportRoot, `${base}-${stamp}${fallbackExt}`);
    }
    const explicit = String(name).trim();
    if (path.isAbsolute(explicit)) return path.resolve(explicit);
    const withExt = path.extname(explicit) ? explicit : explicit + fallbackExt;
    const target = path.resolve(this.exportRoot, withExt);
    if (!isInside(this.root, target) && !isInside(this.exportRoot, target)) {
      throw new ToolError(
        `Relative export paths must stay inside the workspace (${this.root}). Received: ${explicit}`,
      );
    }
    return target;
  }

  /** Make sure a directory exists, returning it. */
  ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A short display path: relative to the workspace when possible. */
  display(filePath) {
    if (!filePath) return filePath;
    const rel = path.relative(this.root, filePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    return filePath;
  }

  describe() {
    return {
      workspace: this.root,
      artRoot: this.artRoot,
      exportRoot: this.exportRoot,
      activeDocument: this.activeDocument,
    };
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { Workspace, isInside };
