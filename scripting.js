/**
 * DIHBLOCKS — scripting.js
 * Multi-language sandboxed scripting engine for the browser game.
 */
'use strict';

(function() {
  const DIHLANG_KEYWORDS = new Set([
    'move','rotate','gravity','jumpForce','moveSpeed','friction','size','color',
    'say','play','stop','create','destroy',
    'loop','if','else','end','wait',
    'and','or','not','true','false','random',
    'var','set','to','when','event'
  ]);

  function tokenizeDihlang(s) {
    const tokens = []; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === '"' || c === "'") {
        const q = c; i++; let str = '';
        while (i < s.length && s[i] !== q) {
          if (s[i] === '\\' && i + 1 < s.length) { str += s[i + 1]; i += 2; }
          else { str += s[i]; i++; }
        }
        i++; tokens.push('"' + str + '"'); continue;
      }
      if (c === '(' || c === ')' || c === ',') { tokens.push(c); i++; continue; }
      if (c === '>' || c === '<' || c === '=' || c === '!') {
        let op = c; i++;
        if (i < s.length && (s[i] === '=' || s[i] === '>')) { op += s[i]; i++; }
        tokens.push(op); continue;
      }
      let tok = '';
      while (i < s.length &&
        !(s[i]===' '||s[i]==='\t'||s[i]==='\r'||s[i]==='\n'||
          s[i]==='('||s[i]===')'||s[i]===','||
          s[i]==='>'||s[i]==='<'||s[i]==='='||s[i]==='!'||
          s[i]==='"'||s[i]==="'")) { tok += s[i]; i++; }
      if (tok) tokens.push(tok);
    }
    return tokens;
  }

  class DihlangParser {
    constructor(tokens) { this.tokens = tokens; this.pos = 0; this.blocks = []; }
    peek(o = 0) { return this.tokens[this.pos + o] || null; }
    consume() { return this.tokens[this.pos++] || null; }
    parse() {
      this.blocks = [];
      while (this.pos < this.tokens.length) {
        const b = this.parseStatement();
        if (b) this.blocks.push(b);
        while (this.peek() === ')' || this.peek() === ',') this.consume();
      }
      return this.blocks;
    }
    parseStatement() {
      const t = this.peek();
      if (!t) return null;
      if (t === ')' || t === ',') { this.consume(); return null; }
      if (t === 'end')  { this.consume(); return null; }
      if (t === 'else') { this.consume(); return null; }
      if (t === 'loop') return this.parseLoop();
      if (t === 'if')   return this.parseIf();
      if (t === 'var')  return this.parseVar();
      if (t === 'set')  return this.parseSet();
      if (t === 'when') return this.parseWhen();
      return this.parseAction(t);
    }
    parseAction(name) {
      this.consume();
      const args = [];
      if (this.peek() === '(') this.consume();
      let n = this.peek();
      while (n && n !== ')' && n !== ',' && !DIHLANG_KEYWORDS.has(n)) {
        const arg = this.parseValue(n);
        if (arg !== null) { args.push(arg); this.consume(); } else break;
        n = this.peek();
        if (n === ',') { this.consume(); n = this.peek(); }
      }
      if (this.peek() === ')') this.consume();
      return { type: 'action', name, args };
    }
    parseLoop() {
      this.consume();
      const count = this.parseValue(this.consume());
      const body = [];
      while (this.pos < this.tokens.length && this.peek() !== 'end') {
        const st = this.parseStatement(); if (st) body.push(st);
      }
      if (this.peek() === 'end') this.consume();
      return { type: 'loop', count, body };
    }
    parseIf() {
      this.consume();
      const cond = this.parseCondition();
      const thenB = [], elseB = []; let inElse = false;
      while (this.pos < this.tokens.length && this.peek() !== 'end') {
        if (this.peek() === 'else') { this.consume(); inElse = true; continue; }
        const st = this.parseStatement(); if (!st) continue;
        (inElse ? elseB : thenB).push(st);
      }
      if (this.peek() === 'end') this.consume();
      return { type: 'if', condition: cond, thenBranch: thenB, elseBranch: elseB };
    }
    parseVar() {
      this.consume(); const name = this.consume(); let val = 0;
      if (this.peek() === 'to') { this.consume(); val = this.parseValue(this.consume()); }
      return { type: 'var', name, value: val };
    }
    parseSet() {
      this.consume(); const name = this.consume();
      if (this.peek() === 'to') this.consume();
      return { type: 'set', name, value: this.parseValue(this.consume()) };
    }
    parseWhen() {
      this.consume(); const evt = this.consume(); const body = [];
      while (this.pos < this.tokens.length && this.peek() !== 'end') {
        const st = this.parseStatement(); if (st) body.push(st);
      }
      if (this.peek() === 'end') this.consume();
      return { type: 'when', event: evt, body };
    }
    parseCondition() {
      const left = this.parseValue(this.consume());
      const op = this.consume();
      const right = this.parseValue(this.consume());
      let chain = null;
      if (this.peek() === 'and' || this.peek() === 'or') {
        const join = this.consume();
        const l2 = this.parseValue(this.consume());
        const o2 = this.consume();
        const r2 = this.parseValue(this.consume());
        chain = { join, left2: l2, op2: o2, right2: r2 };
      }
      return { left, op, right, chain };
    }
    parseValue(token) {
      if (!token) return 0;
      if (token === 'true')  return true;
      if (token === 'false') return false;
      if (token === 'random') {
        const max = this.peek() && !isNaN(Number(this.peek())) ? Number(this.consume()) : 100;
        return { type: 'random', max };
      }
      if (!isNaN(Number(token))) return Number(token);
      if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1);
      if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
      return { type: 'var', name: token };
    }
  }

  class DihlangRuntime {
    constructor(api) {
      this.api = api;
      this.vars = {};
      this.handlers = { start: [], touch: [], tick: [], jump: [] };
      this.running = false;
    }
    async run(source) {
      const tokens = tokenizeDihlang(source);
      const parser = new DihlangParser(tokens);
      const blocks = parser.parse();
      this.vars = {};
      this.handlers = { start: [], touch: [], tick: [], jump: [] };
      this.running = true;
      for (const b of blocks) {
        if (b.type === 'when') (this.handlers[b.event] || []).push(...b.body);
        else await this.exec(b);
      }
      if (this.handlers.start.length) {
        for (const b of this.handlers.start) await this.exec(b);
      }
    }
    stop() { this.running = false; }
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
        case 'when': return;
      }
    }
    execAction(block) {
      const args = block.args.map(a => this.resolve(a));
      const api = this.api;
      switch (block.name) {
        case 'move':      api.move(args[0]||0, args[1]||0); break;
        case 'rotate':    api.rotate(args[0]||0); break;
        case 'color':     api.color(args[0]||'#fff'); break;
        case 'size':      api.size(args[0]||1, args[1]||args[0]||1); break;
        case 'wait':      return this.wait(args[0]||0);
        case 'create':    api.create(args[0]||'cube', args[1]||0, args[2]||0); break;
        case 'destroy':   api.destroy(args[0]); break;
        case 'say':       api.say(String(args[0]||'')); break;
        case 'play':      api.playSound(args[0]||'beep'); break;
        case 'stop':      api.stopSound(args[0]); break;
        case 'gravity':   api.gravity(args[0]||0.55); break;
        case 'jumpForce': api.jumpForce(args[0]||-13.5); break;
        case 'moveSpeed': api.moveSpeed(args[0]||4.5); break;
        case 'friction':  api.friction(args[0]||0.78); break;
        default:          api.custom(block.name, args); break;
      }
      return Promise.resolve();
    }
    wait(seconds) { return new Promise(r => setTimeout(r, seconds * 1000)); }
    evalCondition(cond) {
      const l = this.resolve(cond.left), r = this.resolve(cond.right);
      let ok = this.compare(l, cond.op, r);
      if (cond.chain) {
        const l2 = this.resolve(cond.chain.left2), r2 = this.resolve(cond.chain.right2);
        const ok2 = this.compare(l2, cond.chain.op2, r2);
        ok = cond.chain.join === 'and' ? (ok && ok2) : (ok || ok2);
      }
      return ok;
    }
    compare(a, op, b) {
      switch (op) {
        case '>':  return a > b;
        case '<':  return a < b;
        case '>=': return a >= b;
        case '<=': return a <= b;
        case '==': return a == b;
        case '!=': return a != b;
        case 'is': return a === b;
        default:   return a == b;
      }
    }
    resolve(value) {
      if (value && typeof value === 'object') {
        if (value.type === 'var')    return this.vars[value.name] || 0;
        if (value.type === 'random') return Math.floor(Math.random() * value.max);
      }
      return value;
    }
    onEvent(name) {
      const list = this.handlers[name] || [];
      for (const b of list) this.exec(b);
    }
    toBlocks(source) {
      const tokens = tokenizeDihlang(source);
      const parser = new DihlangParser(tokens);
      return parser.parse();
    }
  }

  class PythonTranspiler {
    transpile(source) {
      const lines = source.split(/\r?\n/);
      let out = '(async function(api){\n';
      out += '  const image = api.image; const game = api.game; const ui = api.ui;\n';
      let prevIndent = 0;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.replace(/#.*$/, '');
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
        if (head.startsWith('if '))    return `if (${this.expr(head.slice(3))}) {`;
        if (head.startsWith('while ')) return `while (${this.expr(head.slice(6))}) {`;
        return `if (${this.expr(head)}) {`;
      }
      const assign = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
      if (assign) return `let ${assign[1]} = ${this.expr(assign[2])};`;
      return this.expr(line) + ';';
    }
    expr(s) {
      s = s.trim();
      s = s.replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!');
      s = s.replace(/\bprint\s*\(/g, 'api.say(');
      s = s.replace(/\bwait\s*\(/g, 'await api.wait(');
      return s;
    }
  }

  class PythonRuntime {
    constructor(api) { this.api = api; this.running = false; this.transpiler = new PythonTranspiler(); }
    async run(source) {
      this.stop();
      this.running = true;
      const js = this.transpiler.transpile(source);
      try {
        const fn = new Function('return ' + js)();
        await fn(this._wrapApi());
      } catch (e) {
        this.api.onError('Python: ' + e.message);
      }
    }
    stop() { this.running = false; }
    _wrapApi() {
      const api = this.api;
      return {
        move: (x,y) => api.move(x,y),
        rotate: (d) => api.rotate(d),
        color: (c) => api.color(c),
        size: (w,h) => api.size(w,h),
        create: (t,x,y) => api.create(t,x,y),
        destroy: (id) => api.destroy(id),
        say: (msg) => api.say(msg),
        wait: (s) => new Promise(r => setTimeout(r, s*1000)),
        playSound: (n) => api.playSound(n),
        onError: api.onError,
      };
    }
  }

  class JSRuntime {
    constructor(api) { this.api = api; this.running = false; }
    async run(source) {
      this.stop();
      this.running = true;
      const sandbox = this._buildSandbox();
      try {
        const fn = new Function('api', 'ui', 'game', `"use strict";\n${source}`);
        await fn(sandbox, sandbox.ui, sandbox.game);
      } catch (e) {
        this.api.onError('JS: ' + e.message);
      }
    }
    stop() { this.running = false; }
    _buildSandbox() {
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
        log: (msg) => api.onLog(String(msg)),
      };
    }
  }

  class ScriptEngine {
    constructor(api) {
      this.api = api;
      this.dihlang = new DihlangRuntime(api);
      this.python  = new PythonRuntime(api);
      this.js      = new JSRuntime(api);
      this.active  = null;
      this.currentSource = { dihlang: '', python: '', js: '' };
    }
    async run(language, source) {
      this.currentSource[language] = source;
      this.stop();
      this.active = language;
      this.api.onLog('Running ' + language + '…');
      try {
        if (language === 'dihlang')     await this.dihlang.run(source);
        else if (language === 'python') await this.python.run(source);
        else if (language === 'js')     await this.js.run(source);
      } catch (e) {
        this.api.onError('Script error: ' + e.message);
      }
    }
    stop() {
      this.dihlang.stop(); this.python.stop(); this.js.stop();
      this.active = null;
    }
    getKeywords() { return Array.from(DIHLANG_KEYWORDS); }
    parseBlocks(source) { return this.dihlang.toBlocks(source); }
    onGameEvent(name) { this.dihlang.onEvent(name); }
  }

  window.ScriptEngine = ScriptEngine;
  window.DihlangParser = DihlangParser;
  window.DihlangRuntime = DihlangRuntime;
})();
