/**
 * DIHBLOCKS — scripting.js
 * Multi-language sandboxed scripting engine for the browser game.
 *
 * Runtimes:
 *   - Dihlang: custom visual/text language with 25 core keywords.
 *   - Python:  transpiled subset bound to game object APIs.
 *   - JS:      raw sandboxed JS with injected game API and UI helpers.
 */
'use strict';

(function() {
  /* ============================================================
     DIHLANG RUNTIME
     ============================================================ */

  // Exactly 25 core keywords.
  const DIHLANG_KEYWORDS = new Set([
    'move', 'rotate', 'color', 'size', 'wait',
    'loop', 'if', 'else', 'end', 'and',
    'or', 'not', 'true', 'false', 'play',
    'stop', 'create', 'destroy', 'say', 'event',
    'when', 'var', 'set', 'to', 'random'
  ]);

  function tokenizeDihlang(source) {
    const tokens = [];
    const lines = source.split(/\r?\n/);
    for (let line of lines) {
      const c = line.trim();
      if (!c || c.startsWith('#')) continue;
      // Simple tokenization: split by whitespace, keep strings together.
      const tks = c.match(/"[^"]*"|[^\s"]+/g) || [];
      tokens.push(...tks);
    }
    return tokens;
  }

  class DihlangParser {
    constructor(tokens) {
      this.tokens = tokens;
      this.pos = 0;
      this.blocks = [];
    }
    peek(offset = 0) { return this.tokens[this.pos + offset]; }
    consume() { return this.tokens[this.pos++]; }
    parse() {
      while (this.pos < this.tokens.length) {
        const block = this.parseStatement();
        if (block) this.blocks.push(block);
      }
      return this.blocks;
    }
    parseStatement() {
      const tok = this.peek();
      if (!tok) return null;
      if (tok === 'end') { this.consume(); return null; }
      if (tok === 'else') return null; // handled by if
      if (tok === 'loop') return this.parseLoop();
      if (tok === 'if') return this.parseIf();
      if (tok === 'var') return this.parseVar();
      if (tok === 'set') return this.parseSet();
      if (tok === 'when') return this.parseWhen();
      // Action commands
      if (['move','rotate','color','size','wait','create','destroy','say','play','stop'].includes(tok)) {
        return this.parseAction(tok);
      }
      // Unknown identifier: treat as command with arguments until keyword boundary
      return this.parseAction(tok);
    }
    parseAction(name) {
      this.consume();
      const args = [];
      while (this.pos < this.tokens.length) {
        const t = this.peek();
        if (DIHLANG_KEYWORDS.has(t) && t !== 'true' && t !== 'false' && t !== 'random') break;
        args.push(this.parseValue(this.consume()));
      }
      return { type: 'action', name, args, line: this.pos };
    }
    parseLoop() {
      this.consume(); // loop
      const count = this.parseValue(this.consume());
      const body = [];
      while (this.pos < this.tokens.length && this.peek() !== 'end') {
        const st = this.parseStatement();
        if (st) body.push(st);
      }
      if (this.peek() === 'end') this.consume();
      return { type: 'loop', count, body };
    }
    parseIf() {
      this.consume(); // if
      const condition = this.parseCondition();
      const thenBranch = [];
      const elseBranch = [];
      let inElse = false;
      while (this.pos < this.tokens.length && this.peek() !== 'end') {
        if (this.peek() === 'else') { this.consume(); inElse = true; continue; }
        const st = this.parseStatement();
        if (!st) continue;
        (inElse ? elseBranch : thenBranch).push(st);
      }
      if (this.peek() === 'end') this.consume();
      return { type: 'if', condition, thenBranch, elseBranch };
    }
    parseVar() {
      this.consume(); // var
      const name = this.consume();
      let value = 0;
      if (this.peek() === 'to') { this.consume(); value = this.parseValue(this.consume()); }
      return { type: 'var', name, value };
    }
    parseSet() {
      this.consume(); // set
      const name = this.consume();
      if (this.peek() === 'to') this.consume();
      const value = this.parseValue(this.consume());
      return { type: 'set', name, value };
    }
    parseWhen() {
      this.consume(); // when
      const event = this.consume(); // e.g. start, touch, tick
      const body = [];
      while (this.pos < this.tokens.length && this.peek() !== 'end') {
        const st = this.parseStatement();
        if (st) body.push(st);
      }
      if (this.peek() === 'end') this.consume();
      return { type: 'when', event, body };
    }
    parseCondition() {
      // simple condition: a op b [and/or c op d]
      const left = this.parseValue(this.consume());
      const op = this.consume();
      const right = this.parseValue(this.consume());
      let chain = null;
      if (this.peek() === 'and' || this.peek() === 'or') {
        const join = this.consume();
        const left2 = this.parseValue(this.consume());
        const op2 = this.consume();
        const right2 = this.parseValue(this.consume());
        chain = { join, left2, op2, right2 };
      }
      return { left, op, right, chain };
    }
    parseValue(token) {
      if (!token) return 0;
      if (token === 'true') return true;
      if (token === 'false') return false;
      if (token === 'random') {
        const max = this.peek() && !isNaN(Number(this.peek())) ? Number(this.consume()) : 100;
        return { type: 'random', max };
      }
      if (!isNaN(Number(token))) return Number(token);
      if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1);
      return { type: 'var', name: token };
    }
  }

  class DihlangRuntime {
    constructor(api) {
      this.api = api;
      this.vars = {};
      this.handlers = { start: [], touch: [], tick: [], jump: [] };
      this.running = false;
      this.pending = [];
    }
    async run(source) {
      const tokens = tokenizeDihlang(source);
      const parser = new DihlangParser(tokens);
      const blocks = parser.parse();
      this.vars = {};
      this.handlers = { start: [], touch: [], tick: [], jump: [] };
      this.running = true;
      for (const block of blocks) {
        if (block.type === 'when') {
          (this.handlers[block.event] || []).push(...block.body);
        } else {
          await this.exec(block);
        }
      }
      // Fire start event
      if (this.handlers.start.length) {
        for (const b of this.handlers.start) await this.exec(b);
      }
    }
    stop() {
      this.running = false;
      this.pending = [];
    }
    async exec(block) {
      if (!this.running) return;
      switch (block.type) {
        case 'action': return this.execAction(block);
        case 'loop': {
          const count = this.resolve(block.count);
          for (let i = 0; i < count && this.running; i++) {
            for (const b of block.body) await this.exec(b);
          }
          return;
        }
        case 'if': {
          const ok = this.evalCondition(block.condition);
          const branch = ok ? block.thenBranch : block.elseBranch;
          for (const b of branch) await this.exec(b);
          return;
        }
        case 'var': this.vars[block.name] = this.resolve(block.value); return;
        case 'set': this.vars[block.name] = this.resolve(block.value); return;
      }
    }
    execAction(block) {
      const args = block.args.map(a => this.resolve(a));
      const api = this.api;
      switch (block.name) {
        case 'move': api.move(args[0] || 0, args[1] || 0); break;
        case 'rotate': api.rotate(args[0] || 0); break;
        case 'color': api.color(args[0] || '#fff'); break;
        case 'size': api.size(args[0] || 1, args[1] || args[0] || 1); break;
        case 'wait': return this.wait(args[0] || 0);
        case 'create': api.create(args[0] || 'cube', args[1] || 0, args[2] || 0); break;
        case 'destroy': api.destroy(args[0]); break;
        case 'say': api.say(String(args[0] || '')); break;
        case 'play': api.playSound(args[0] || 'beep'); break;
        case 'stop': api.stopSound(args[0]); break;
        default: api.custom(block.name, args); break;
      }
      return Promise.resolve();
    }
    wait(seconds) {
      return new Promise(r => setTimeout(r, seconds * 1000));
    }
    evalCondition(cond) {
      const l = this.resolve(cond.left);
      const r = this.resolve(cond.right);
      let ok = this.compare(l, cond.op, r);
      if (cond.chain) {
        const l2 = this.resolve(cond.chain.left2);
        const r2 = this.resolve(cond.chain.right2);
        const ok2 = this.compare(l2, cond.chain.op2, r2);
        ok = cond.chain.join === 'and' ? (ok && ok2) : (ok || ok2);
      }
      return ok;
    }
    compare(a, op, b) {
      switch (op) {
        case '>': return a > b;
        case '<': return a < b;
        case '>=': return a >= b;
        case '<=': return a <= b;
        case '==': return a == b;
        case '!=': return a != b;
        case 'is': return a === b;
        default: return a == b;
      }
    }
    resolve(value) {
      if (value && typeof value === 'object') {
        if (value.type === 'var') return this.vars[value.name] || 0;
        if (value.type === 'random') return Math.floor(Math.random() * value.max);
      }
      return value;
    }
    onEvent(name) {
      const list = this.handlers[name] || [];
      if (!list.length) return;
      for (const b of list) this.exec(b);
    }
    toBlocks(source) {
      // Convert source to block JSON for visual editor.
      const tokens = tokenizeDihlang(source);
      const parser = new DihlangParser(tokens);
      return parser.parse();
    }
  }

  /* ============================================================
     PYTHON-TO-JS TRANSPILER (subset)
     ============================================================ */
  class PythonTranspiler {
    constructor() {
      this.indentStack = [0];
    }
    transpile(source) {
      const lines = source.split(/\r?\n/);
      let out = '(async function(api){\n';
      out += '  const image = api.image; const game = api.game; const ui = api.ui;\n';
      let prevIndent = 0;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.replace(/#.*$/, ''); // strip comments
        const indent = raw.length - raw.trimStart().length;
        if (!line.trim()) continue;
        while (indent < prevIndent) { out += '}\n'; prevIndent -= 2; }
        const stmt = this.transpileLine(line.trim());
        out += '  ' + stmt + '\n';
        if (line.trim().endsWith(':')) prevIndent = indent + 2;
      }
      while (prevIndent > 0) { out += '}\n'; prevIndent -= 2; }
      out += '})';
      return out;
    }
    transpileLine(line) {
      if (line.endsWith(':')) {
        const head = line.slice(0, -1).trim();
        if (head.startsWith('for ')) {
          const m = head.match(/^for\s+(\w+)\s+in\s+range\((\d+)\)$/);
          if (m) return `for (let ${m[1]} = 0; ${m[1]} < ${m[2]}; ${m[1]}++) {`;
        }
        if (head.startsWith('if ')) return `if (${this.expr(head.slice(3))}) {`;
        if (head.startsWith('while ')) return `while (${this.expr(head.slice(6))}) {`;
        return `if (${this.expr(head)}) {`;
      }
      // Assignment
      const assign = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
      if (assign) {
        return `let ${assign[1]} = ${this.expr(assign[2])};`;
      }
      // Method call on object
      return this.expr(line) + ';';
    }
    expr(s) {
      s = s.trim();
      // Translate Python and/or to JS &&/||
      s = s.replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!');
      // Translate print -> api.say
      s = s.replace(/\bprint\s*\(/g, 'api.say(');
      // Wait
      s = s.replace(/\bwait\s*\(/g, 'await api.wait(');
      // Image filters
      s = s.replace(/\bimage\.\w+/g, m => `api.${m}`);
      return s;
    }
  }

  class PythonRuntime {
    constructor(api) {
      this.api = api;
      this.transpiler = new PythonTranspiler();
      this.fn = null;
      this.running = false;
    }
    async run(source) {
      this.stop();
      this.running = true;
      const js = this.transpiler.transpile(source);
      this.fn = new Function('return ' + js)();
      try {
        await this.fn(this.wrapApi());
      } catch (e) {
        this.api.onError('Python: ' + e.message);
      }
    }
    stop() { this.running = false; }
    wrapApi() {
      const api = this.api;
      return {
        move: (x, y) => api.move(x, y),
        rotate: (deg) => api.rotate(deg),
        color: (c) => api.color(c),
        size: (w, h) => api.size(w, h),
        create: (type, x, y) => api.create(type, x, y),
        destroy: (id) => api.destroy(id),
        say: (msg) => api.say(msg),
        wait: (s) => new Promise(r => setTimeout(r, s * 1000)),
        playSound: (name) => api.playSound(name),
        image: api.image,
        game: api.game,
        ui: api.ui,
        onError: api.onError,
      };
    }
  }

  /* ============================================================
     JS RUNTIME
     ============================================================ */
  class JSRuntime {
    constructor(api) {
      this.api = api;
      this.running = false;
    }
    async run(source) {
      this.stop();
      this.running = true;
      const sandboxed = this.buildSandbox();
      try {
        const fn = new Function('api', 'ui', 'game', 'image', `"use strict";\n${source}`);
        await fn(sandboxed, sandboxed.ui, sandboxed.game, sandboxed.image);
      } catch (e) {
        this.api.onError('JS: ' + e.message);
      }
    }
    stop() { this.running = false; }
    buildSandbox() {
      const api = this.api;
      return {
        move: api.move.bind(api),
        rotate: api.rotate.bind(api),
        color: api.color.bind(api),
        size: api.size.bind(api),
        create: api.create.bind(api),
        destroy: api.destroy.bind(api),
        say: api.say.bind(api),
        playSound: api.playSound.bind(api),
        wait: (s) => new Promise(r => setTimeout(r, s * 1000)),
        image: api.image,
        game: api.game,
        ui: api.ui,
        log: (msg) => api.onLog(String(msg)),
      };
    }
  }

  /* ============================================================
     PUBLIC FACADE
     ============================================================ */
  class ScriptEngine {
    constructor(api) {
      this.api = api;
      this.dihlang = new DihlangRuntime(api);
      this.python = new PythonRuntime(api);
      this.js = new JSRuntime(api);
      this.active = null;
      this.currentSource = { dihlang: '', python: '', js: '' };
    }
    async run(language, source) {
      this.currentSource[language] = source;
      this.stop();
      this.active = language;
      this.api.onLog(`Running ${language}…`);
      if (language === 'dihlang') await this.dihlang.run(source);
      else if (language === 'python') await this.python.run(source);
      else if (language === 'js') await this.js.run(source);
    }
    stop() {
      this.dihlang.stop();
      this.python.stop();
      this.js.stop();
      this.active = null;
    }
    getKeywords() { return Array.from(DIHLANG_KEYWORDS); }
    parseBlocks(source) { return this.dihlang.toBlocks(source); }
    onGameEvent(name) { this.dihlang.onEvent(name); }
  }

  // Expose
  window.DihlangParser = DihlangParser;
  window.DihlangRuntime = DihlangRuntime;
  window.PythonTranspiler = PythonTranspiler;
  window.PythonRuntime = PythonRuntime;
  window.JSRuntime = JSRuntime;
  window.ScriptEngine = ScriptEngine;
})();
