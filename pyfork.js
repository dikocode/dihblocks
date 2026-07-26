/**
 * PYFORK — a tiny "Python-like" scripting language that compiles to JavaScript.
 * Designed for the Dihblocks "Thing" scripting system.
 *
 * It is NOT full Python. It is a friendly indentation-based DSL with a huge
 * set of game keywords (gravity, colour, move, spawn, delete, create, trigger,
 * every, wait, on_start, on_touch, on_click, on_key, on <event>, ...).
 *
 * Output: a JS function body string executed inside a sandbox provided by
 * things.js. The sandbox exposes: self, player, world, api (create/delete/
 * trigger/etc.), state (per-thing), math helpers, wait(ms), etc.
 *
 * Usage:  const jsSource = Pyfork.compile(source);
 *         const fn = new Function('self','player','world','api','state','ctx', jsSource);
 */
(function (global) {
  'use strict';

  // ── Tokenizer ────────────────────────────────────────────
  // Splits a line into tokens: identifiers, numbers, strings, operators.
  const OP_RE = /^(==|!=|<=|>=|\+=|-=|\*=|\/=|&&|\|\||[+\-*\/%<>=(),\[\]{}:.])/;
  const NUM_RE = /^-?\d+(?:\.\d+)?/;
  const STR_RE = /^'([^'\\]*(?:\\.[^'\\]*)*)'|^"([^"\\]*(?:\\.[^"\\]*)*)"/;
  const ID_RE  = /^[A-Za-z_][A-Za-z0-9_]*/;

  function tokenizeLine(line) {
    const out = [];
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      if (/^\s/.test(rest)) { i++; continue; }
      if (rest.startsWith('#')) break; // comment
      let m;
      if ((m = rest.match(STR_RE))) {
        // Preserve quoted string as a single JS string literal token
        out.push({ t: 'str', v: JSON.stringify(m[1] !== undefined ? m[1] : m[2]) });
        i += m[0].length; continue;
      }
      if ((m = rest.match(NUM_RE))) { out.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
      if ((m = rest.match(OP_RE)))  { out.push({ t: 'op',  v: m[0] }); i += m[0].length; continue; }
      if ((m = rest.match(ID_RE)))  { out.push({ t: 'id',  v: m[0] }); i += m[0].length; continue; }
      // Unknown char — swallow it silently rather than crash.
      i++;
    }
    return out;
  }

  // Convert a token stream into a JS expression string. We map Python-y bits
  // to JS: `and`→`&&`, `or`→`||`, `not`→`!`, `True`→`true`, etc.
  const KEYWORD_MAP = {
    'True': 'true', 'true': 'true',
    'False': 'false', 'false': 'false',
    'None': 'null', 'null': 'null',
    'and': '&&', 'or': '||', 'not': '!',
    'self': 'self', 'player': 'player', 'world': 'world',
    // Expression-level helper functions, usable inside any expression, e.g.
    // `if distance(self, player) < 100:` or `set a = clamp(x, 0, 10)`.
    'distance': 'api.distance', 'dist': 'api.distance',
    'angle_to': 'api.angleTo', 'angleTo': 'api.angleTo',
    'clamp': 'api.clamp',
    'print_message': 'api.printMessage',
  };

  function tokensToExpr(tokens) {
    // Simple pass-through with keyword translation. Unquoted bare identifiers
    // become JS identifiers, so `self.x + 20` still works.
    return tokens.map(tk => {
      if (tk.t === 'id') return (KEYWORD_MAP[tk.v] !== undefined) ? KEYWORD_MAP[tk.v] : tk.v;
      return tk.v;
    }).join(' ');
  }

  // Join tokens with sensible spacing (used for building JS args).
  //
  // Keyword statements in this DSL are written two ways:
  //   `push self by 10, 20`     (comma-separated)
  //   `bounce player 700`       (bare space-separated — the common case)
  // If a top-level comma is present we split on commas as before. Otherwise
  // we split into separate args on whitespace between top-level *simple*
  // tokens (numbers, bare identifiers, strings) — but we do NOT split inside
  // an expression that contains operators/dots/parens, since something like
  // `self.x + 20` or `self.x` must stay one argument.
  function joinArgs(tokens) {
    const hasTopComma = (() => {
      let depth = 0;
      for (const tk of tokens) {
        if (tk.t === 'op' && (tk.v === '(' || tk.v === '[' || tk.v === '{')) depth++;
        if (tk.t === 'op' && (tk.v === ')' || tk.v === ']' || tk.v === '}')) depth--;
        if (tk.t === 'op' && tk.v === ',' && depth === 0) return true;
      }
      return false;
    })();

    if (hasTopComma) {
      const groups = [[]];
      let depth = 0;
      for (const tk of tokens) {
        if (tk.t === 'op' && (tk.v === '(' || tk.v === '[' || tk.v === '{')) depth++;
        if (tk.t === 'op' && (tk.v === ')' || tk.v === ']' || tk.v === '}')) depth--;
        if (tk.t === 'op' && tk.v === ',' && depth === 0) { groups.push([]); continue; }
        groups[groups.length - 1].push(tk);
      }
      return groups.filter(g => g.length).map(tokensToExpr);
    }

    // No top-level comma: greedily split into whole-expression chunks.
    // A new arg starts whenever we're at depth 0 and the previous token
    // ended a "complete" simple value (number/string/id/closing bracket)
    // and the current token also starts a fresh simple value, with no
    // binary operator/dot connecting them.
    const groups = [[]];
    let depth = 0;
    const isValueEnd = (tk) => tk && (tk.t === 'num' || tk.t === 'str' ||
      (tk.t === 'id') || (tk.t === 'op' && (tk.v === ')' || tk.v === ']')));
    const isValueStart = (tk) => tk && (tk.t === 'num' || tk.t === 'str' ||
      (tk.t === 'id') || (tk.t === 'op' && (tk.v === '(' || tk.v === '-' || tk.v === '[')));
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.t === 'op' && (tk.v === '(' || tk.v === '[' || tk.v === '{')) depth++;
      if (tk.t === 'op' && (tk.v === ')' || tk.v === ']' || tk.v === '}')) depth--;
      const cur = groups[groups.length - 1];
      if (depth === 0 && cur.length && tk.t !== 'op' &&
          isValueEnd(cur[cur.length - 1]) && isValueStart(tk) &&
          !(cur[cur.length - 1].t === 'op' && cur[cur.length - 1].v === '.') &&
          tk.v !== '.') {
        groups.push([]);
      } else if (depth === 0 && cur.length && tk.t === 'op' && tk.v === '-' &&
          isValueEnd(cur[cur.length - 1]) && tokens[i+1] && (tokens[i+1].t === 'num')) {
        // Ambiguous: `a -1` (two args) vs `a - 1` (subtraction) both tokenize
        // the same way once whitespace is gone. Treat a `-` immediately
        // followed by a number, after a completed value, as a new negative
        // argument (matches how this DSL's authors write "TARGET -POWER").
        groups.push([]);
      }
      groups[groups.length - 1].push(tk);
    }
    return groups.filter(g => g.length).map(tokensToExpr);
  }

  // ── Indentation-aware line reader ────────────────────────
  function splitLines(src) {
    const raw = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const line = raw[i];
      // Skip pure-blank / pure-comment lines but preserve line numbers via index.
      if (/^\s*(#.*)?$/.test(line)) { out.push({ indent: -1, text: '', n: i + 1 }); continue; }
      const m = line.match(/^(\s*)(.*)$/);
      const indent = m[1].replace(/\t/g, '    ').length;
      out.push({ indent, text: m[2], n: i + 1 });
    }
    return out;
  }

  // ── Compiler ─────────────────────────────────────────────
  // We keep three kinds of top-level handlers so things.js can wire them:
  //   startHandlers, updateHandlers, eventHandlers ({name: fn}), intervalHandlers.
  //
  // The compiled JS returns an object literal with those buckets. Everything
  // is expressed as `async function` bodies to allow `wait`.

  function compile(source) {
    const lines = splitLines(source);
    // A "block" is a sequence of consecutive lines with indent > parentIndent.
    // We walk top-level lines and emit handlers as we go.

    const emit = {
      onStart: [],   // arrays of JS statement strings
      onUpdate: [],
      events: {},    // name -> array of statements
      intervals: [], // { period, body }
      init: [],      // ran once at load, before onStart (colour/gravity/etc.)
    };

    let idx = 0;
    while (idx < lines.length) {
      const line = lines[idx];
      if (line.indent === -1 || line.indent > 0) { idx++; continue; }
      const consumed = compileTopStatement(lines, idx, emit);
      idx = consumed;
    }

    // Assemble a JS module string.
    const parts = [];
    parts.push('"use strict";');
    parts.push('const _handlers = { onStart: [], onUpdate: [], events: {}, intervals: [] };');
    parts.push('const _addEvent = (name, fn) => { (_handlers.events[name] = _handlers.events[name] || []).push(fn); };');

    // Init statements run immediately when the script is loaded.
    if (emit.init.length) {
      parts.push('// init');
      parts.push(emit.init.join('\n'));
    }

    if (emit.onStart.length) {
      parts.push('_handlers.onStart.push(async function(){');
      parts.push(emit.onStart.join('\n'));
      parts.push('});');
    }
    if (emit.onUpdate.length) {
      parts.push('_handlers.onUpdate.push(async function(dt){');
      parts.push(emit.onUpdate.join('\n'));
      parts.push('});');
    }
    for (const iv of emit.intervals) {
      parts.push('_handlers.intervals.push({ period: ' + iv.period + ', fn: async function(){');
      parts.push(iv.body);
      parts.push('} });');
    }
    for (const name of Object.keys(emit.events)) {
      for (const body of emit.events[name]) {
        parts.push('_addEvent(' + JSON.stringify(name) + ', async function(evt){');
        parts.push(body);
        parts.push('});');
      }
    }
    parts.push('return _handlers;');
    return parts.join('\n');
  }

  // Compile a top-level statement starting at lines[idx]. Returns next idx.
  function compileTopStatement(lines, idx, emit) {
    const line = lines[idx];
    const text = line.text.trim();

    // Block-introducing constructs end with ":"
    if (text.endsWith(':')) {
      const header = text.slice(0, -1).trim();
      const block = collectBlock(lines, idx);
      const body = compileBlock(block.lines);

      // Route based on header.
      if (header === 'on_start' || header === 'onstart' || header === 'start') {
        emit.onStart.push(body);
      } else if (header === 'on_update' || header === 'update' || header === 'tick') {
        emit.onUpdate.push(body);
      } else if (/^every\s+/.test(header)) {
        const period = header.replace(/^every\s+/, '').trim();
        const p = tokensToExpr(tokenizeLine(period));
        emit.intervals.push({ period: p, body });
      } else if (/^on_touch(\s+|$)/.test(header)) {
        const rest = header.replace(/^on_touch\s*/, '').trim();
        // rest might be `player` or a thing name filter.
        const filter = rest ? JSON.stringify(rest) : '""';
        // Wrap so `evt.target` becomes `player`.
        emit.events['touch'] = emit.events['touch'] || [];
        emit.events['touch'].push(
          'const player = evt.target;\n' +
          'if (' + filter + ' && ' + filter + ' !== "" && evt.filter && evt.filter !== ' + filter + ') return;\n' +
          body
        );
      } else if (/^on_click$/.test(header)) {
        emit.events['click'] = emit.events['click'] || [];
        emit.events['click'].push(body);
      } else if (/^on_key\s+/.test(header)) {
        const key = header.replace(/^on_key\s+/, '').trim();
        emit.events['key'] = emit.events['key'] || [];
        emit.events['key'].push('if (evt.key !== ' + JSON.stringify(key) + ') return;\n' + body);
      } else if (/^on\s+/.test(header)) {
        // Generic named event: `on 'boom':`
        const nameToks = tokenizeLine(header.replace(/^on\s+/, ''));
        const nameExpr = tokensToExpr(nameToks);
        // Static string preferred; fall back to runtime dispatch by keying on literal.
        let evName = header.replace(/^on\s+/, '').trim();
        if (/^['"]/.test(evName)) evName = evName.slice(1, -1);
        emit.events[evName] = emit.events[evName] || [];
        emit.events[evName].push(body);
        // Also allow expression form:
        // (kept simple — literal names cover the common case)
        void nameExpr;
      } else if (/^def\s+/.test(header)) {
        // Top-level function: emit as init.
        const m = header.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)$/);
        if (m) {
          emit.init.push('async function ' + m[1] + '(' + m[2] + ') {\n' + body + '\n}');
        }
      } else if (/^if\s+/.test(header) || /^while\s+/.test(header) || /^for\s+/.test(header) || header === 'else' || /^elif\s+/.test(header)) {
        // A bare top-level control block runs at init time.
        emit.init.push(compileControlHeader(header) + ' {\n' + body + '\n}');
      } else {
        // Unknown block header — run its body at init as a plain scope.
        emit.init.push('{\n' + body + '\n}');
      }
      return block.next;
    }

    // Otherwise it's a single-line top-level statement (colour/gravity/print/…).
    emit.init.push(compileSimpleStatement(text));
    return idx + 1;
  }

  // Collect indented block after lines[idx].
  function collectBlock(lines, idx) {
    const parentIndent = lines[idx].indent;
    const out = [];
    let j = idx + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.indent === -1) { out.push(l); j++; continue; }
      if (l.indent <= parentIndent) break;
      out.push(l);
      j++;
    }
    // Strip common indent so nested compilation sees indent=0 at top.
    const minIndent = out.filter(l => l.indent !== -1).reduce((m, l) => Math.min(m, l.indent), Infinity);
    const stripped = out.map(l => l.indent === -1 ? l : { ...l, indent: l.indent - minIndent });
    return { lines: stripped, next: j };
  }

  // Compile a sequence of already-dedented lines to a JS string.
  function compileBlock(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l.indent === -1) { i++; continue; }
      if (l.indent > 0) { i++; continue; } // shouldn't happen at this level
      const text = l.text.trim();
      if (text.endsWith(':')) {
        const header = text.slice(0, -1).trim();
        const inner = collectBlock(lines, i);
        const body = compileBlock(inner.lines);
        if (/^if\s+/.test(header) || /^while\s+/.test(header) || /^for\s+/.test(header) || header === 'else' || /^elif\s+/.test(header)) {
          out.push(compileControlHeader(header) + ' {\n' + body + '\n}');
        } else if (/^every\s+/.test(header)) {
          const p = tokensToExpr(tokenizeLine(header.replace(/^every\s+/, '').trim()));
          out.push('api.every(self, ' + p + ', async () => {\n' + body + '\n});');
        } else if (/^on\s+/.test(header)) {
          let evName = header.replace(/^on\s+/, '').trim();
          if (/^['"]/.test(evName)) evName = evName.slice(1, -1);
          out.push('api.on(self, ' + JSON.stringify(evName) + ', async (evt) => {\n' + body + '\n});');
        } else if (/^def\s+/.test(header)) {
          const m = header.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)$/);
          if (m) out.push('async function ' + m[1] + '(' + m[2] + ') {\n' + body + '\n}');
        } else {
          out.push('{\n' + body + '\n}');
        }
        i = inner.next;
      } else {
        out.push(compileSimpleStatement(text));
        i++;
      }
    }
    return out.join('\n');
  }

  function compileControlHeader(header) {
    // `if x > 3` -> `if (x > 3)`; `for i in range(10)` -> a manual loop.
    if (/^if\s+/.test(header))    return 'if ('    + tokensToExpr(tokenizeLine(header.slice(3))) + ')';
    if (/^elif\s+/.test(header))  return 'else if ('+ tokensToExpr(tokenizeLine(header.slice(5))) + ')';
    if (header === 'else')        return 'else';
    if (/^while\s+/.test(header)) return 'while (' + tokensToExpr(tokenizeLine(header.slice(6))) + ')';
    if (/^for\s+/.test(header)) {
      // for VAR in EXPR
      const m = header.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/);
      if (m) {
        return 'for (const ' + m[1] + ' of api.iter(' + tokensToExpr(tokenizeLine(m[2])) + '))';
      }
    }
    return 'if (true)';
  }

  // ── The heart: compile a single statement to JS ──────────
  // Supports both keyword-style commands ("colour '#f00'", "move self by 10 0")
  // and free-form expressions/assignments ("self.x = self.x + 1").
  function compileSimpleStatement(text) {
    const trimmed = text.trim();
    if (!trimmed) return '';

    const toks = tokenizeLine(trimmed);
    if (toks.length === 0) return '';

    // Assignment shortcut: contains a top-level `=` (not ==) that's not part of ==, !=, <=, >=
    const eqIdx = findTopLevelAssign(toks);
    if (eqIdx !== -1) {
      const lhs = tokensToExpr(toks.slice(0, eqIdx));
      const op = toks[eqIdx].v; // = or += etc.
      const rhs = tokensToExpr(toks.slice(eqIdx + 1));
      return lhs + ' ' + op + ' ' + rhs + ';';
    }

    // Keyword-style command based on first identifier.
    const first = toks[0];
    const rest = toks.slice(1);
    if (first.t === 'id') {
      const kw = first.v;
      const cmd = KEYWORDS[kw];
      if (cmd) return cmd(rest, tokensToExpr);
    }

    // Fallback: treat as an expression statement.
    return tokensToExpr(toks) + ';';
  }

  function findTopLevelAssign(tokens) {
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++;
      if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) depth--;
      if (depth === 0 && t.t === 'op' && (t.v === '=' || t.v === '+=' || t.v === '-=' || t.v === '*=' || t.v === '/=')) {
        return i;
      }
    }
    return -1;
  }

  // ── Keyword table ────────────────────────────────────────
  // Each entry receives (restTokens, exprFn) and returns a JS statement.
  const KEYWORDS = {
    // Output
    print(rest) {
      const args = joinArgs(rest);
      return 'api.print(' + args.join(', ') + ');';
    },
    log(rest) { return KEYWORDS.print(rest); },
    print_message(rest) {
      // print_message X  -- shows up in the in-game Console panel
      // (visible to the map's creator only), unlike `print` which only
      // goes to the browser dev console.
      const args = joinArgs(rest);
      return 'api.printMessage(' + (args[0] || '""') + ');';
    },

    // Visuals
    colour(rest) { return 'api.setColour(self, ' + tokensToExpr(rest) + ');'; },
    color(rest)  { return 'api.setColour(self, ' + tokensToExpr(rest) + ');'; },
    texture(rest){ return 'api.setTexture(self, ' + tokensToExpr(rest) + ');'; },
    size(rest)   { return 'api.setSize(self, ' + tokensToExpr(rest) + ');'; },
    width(rest)  { return 'api.setWidth(self, ' + tokensToExpr(rest) + ');'; },
    height(rest) { return 'api.setHeight(self, ' + tokensToExpr(rest) + ');'; },
    scale(rest)  { return 'api.setScale(self, ' + tokensToExpr(rest) + ');'; },
    rotate(rest) { return 'api.rotate(self, ' + tokensToExpr(rest) + ');'; },
    angle(rest)  { return 'api.setRotation(self, ' + tokensToExpr(rest) + ');'; },
    opacity(rest){ return 'api.setOpacity(self, ' + tokensToExpr(rest) + ');'; },
    fade(rest) {
      // fade FROM TO DURATION
      const args = joinArgs(rest);
      return 'api.fade(self, ' + (args[0]||'1') + ', ' + (args[1]||'0') + ', ' + (args[2]||'0.5') + ');';
    },
    show()       { return 'api.setVisible(self, true);'; },
    hide()       { return 'api.setVisible(self, false);'; },
    layer(rest)  { return 'api.setLayer(self, ' + tokensToExpr(rest) + ');'; },
    label(rest)  { return 'api.setLabel(self, ' + tokensToExpr(rest) + ');'; },
    tag(rest)    { return 'api.setTag(self, ' + tokensToExpr(rest) + ');'; },

    // Physics
    gravity(rest){ return 'api.setGravity(self, ' + tokensToExpr(rest) + ');'; },
    friction(rest){ return 'api.setFriction(self, ' + tokensToExpr(rest) + ');'; },
    solid()      { return 'api.setSolid(self, true);'; },
    ghost()      { return 'api.setSolid(self, false);'; },
    velocity(rest){ // velocity vx vy
      const args = joinArgs(rest);
      return 'api.setVelocity(self, ' + (args[0]||'0') + ', ' + (args[1]||'0') + ');';
    },
    push(rest) {
      // push self by X Y   OR   push player by X Y
      const args = parseByExpr(rest);
      return 'api.push(' + args.target + ', ' + args.dx + ', ' + args.dy + ');';
    },
    bounce(rest) {
      // bounce TARGET STRENGTH
      const args = joinArgs(rest);
      const target = args[0] || 'self';
      const power  = args[1] || '600';
      return 'api.bounce(' + target + ', ' + power + ');';
    },
    jump(rest) {
      const args = joinArgs(rest);
      const target = args[0] || 'self';
      return 'api.jump(' + target + ');';
    },
    damage(rest) {
      // damage TARGET AMOUNT   |   damage AMOUNT (defaults target to self)
      const args = joinArgs(rest);
      const target = args.length >= 2 ? args[0] : 'self';
      const amt = args.length >= 2 ? args[1] : (args[0] || '1');
      return 'api.damage(' + target + ', ' + amt + ');';
    },
    heal(rest) {
      const args = joinArgs(rest);
      const target = args.length >= 2 ? args[0] : 'self';
      const amt = args.length >= 2 ? args[1] : (args[0] || '1');
      return 'api.heal(' + target + ', ' + amt + ');';
    },

    // Movement
    move(rest) {
      // move self by DX DY  |  move self to X Y
      const args = parseByOrToExpr(rest);
      if (args.mode === 'to') return 'api.moveTo(' + args.target + ', ' + args.a + ', ' + args.b + ');';
      return 'api.moveBy(' + args.target + ', ' + args.a + ', ' + args.b + ');';
    },
    goto(rest) {
      const args = joinArgs(rest);
      const target = args.length >= 3 ? args[0] : 'self';
      const x = args.length >= 3 ? args[1] : args[0];
      const y = args.length >= 3 ? args[2] : args[1];
      return 'api.moveTo(' + target + ', ' + x + ', ' + y + ');';
    },
    face(rest) {
      // face 'left' | face 'right' | face player
      return 'api.face(self, ' + tokensToExpr(rest) + ');';
    },
    follow(rest) {
      const args = joinArgs(rest);
      return 'api.follow(self, ' + (args[0]||'player') + ', ' + (args[1]||'80') + ');';
    },
    stop() { return 'api.stop(self);'; },
    freeze(rest) {
      const target = rest.length ? tokensToExpr(rest) : 'self';
      return 'api.freeze(' + target + ');';
    },
    unfreeze(rest) {
      const target = rest.length ? tokensToExpr(rest) : 'self';
      return 'api.unfreeze(' + target + ');';
    },
    lock(rest) {
      const target = rest.length ? tokensToExpr(rest) : 'self';
      return 'api.lock(' + target + ');';
    },
    unlock(rest) {
      const target = rest.length ? tokensToExpr(rest) : 'self';
      return 'api.unlock(' + target + ');';
    },

    // Timing
    wait(rest)  { return 'await api.wait(' + tokensToExpr(rest) + ');'; },
    sleep(rest) { return 'await api.wait(' + tokensToExpr(rest) + ');'; },

    // Lifecycle
    create(rest) {
      // create thing at X Y with size S colour C texture URL script SRC
      return compileCreate(rest);
    },
    spawn(rest)  { return compileCreate(rest); },
    clone()      { return 'api.clone(self);'; },
    delete(rest) {
      const target = rest.length ? tokensToExpr(rest) : 'self';
      return 'api.delete(' + target + ');';
    },
    destroy(rest){ return KEYWORDS.delete(rest); },
    kill(rest) {
      const target = rest.length ? tokensToExpr(rest) : 'player';
      return 'api.kill(' + target + ');';
    },
    respawn(rest){
      const target = rest.length ? tokensToExpr(rest) : 'player';
      return 'api.respawn(' + target + ');';
    },

    // Events
    trigger(rest) {
      // trigger 'name' [payload]
      const args = joinArgs(rest);
      const name = args[0] || '""';
      const payload = args[1] || 'null';
      return 'api.trigger(' + name + ', ' + payload + ');';
    },
    emit(rest)  { return KEYWORDS.trigger(rest); },
    broadcast(rest) {
      const args = joinArgs(rest);
      return 'api.broadcast(' + (args[0]||'""') + ', ' + (args[1]||'null') + ');';
    },

    // Sound / feedback
    sound(rest)  { return 'api.playSound(' + tokensToExpr(rest) + ');'; },
    beep()       { return 'api.beep();'; },
    notify(rest) { return 'api.notify(' + tokensToExpr(rest) + ');'; },
    say(rest)    { return 'api.say(self, ' + tokensToExpr(rest) + ');'; },
    shake(rest)  { return 'api.shake(' + (rest.length?tokensToExpr(rest):'6') + ');'; },
    flash(rest)  { return 'api.flash(' + (rest.length?tokensToExpr(rest):'"#fff"') + ');'; },

    // State
    set(rest) {
      // set score = 10   OR   set flag true
      const args = tokensToExpr(rest);
      const eq = rest.findIndex(t => t.t === 'op' && t.v === '=');
      if (eq !== -1) {
        const key = tokensToExpr(rest.slice(0, eq));
        const val = tokensToExpr(rest.slice(eq + 1));
        return 'state[' + JSON.stringify(key.trim()) + '] = ' + val + ';';
      }
      return 'void(' + args + ');';
    },
    inc(rest) {
      const name = tokensToExpr([rest[0]]);
      const by = rest.length > 1 ? tokensToExpr(rest.slice(1)) : '1';
      return 'state[' + JSON.stringify(name.trim()) + '] = (state[' + JSON.stringify(name.trim()) + ']||0) + ' + by + ';';
    },
    dec(rest) {
      const name = tokensToExpr([rest[0]]);
      const by = rest.length > 1 ? tokensToExpr(rest.slice(1)) : '1';
      return 'state[' + JSON.stringify(name.trim()) + '] = (state[' + JSON.stringify(name.trim()) + ']||0) - ' + by + ';';
    },

    // World
    tile(rest) {
      // tile at X Y = 'platform'   OR   tile clear X Y
      const at = rest.findIndex(t => t.t === 'id' && t.v === 'at');
      const eq = rest.findIndex(t => t.t === 'op' && t.v === '=');
      const clear = rest[0] && rest[0].t === 'id' && rest[0].v === 'clear';
      if (clear) {
        const args = joinArgs(rest.slice(1));
        return 'api.setTile(' + args[0] + ', ' + args[1] + ', null);';
      }
      if (at !== -1 && eq !== -1) {
        const xy = joinArgs(rest.slice(at + 1, eq));
        const type = tokensToExpr(rest.slice(eq + 1));
        return 'api.setTile(' + xy[0] + ', ' + xy[1] + ', ' + type + ');';
      }
      return '/* tile: bad syntax */';
    },
    camera(rest) {
      // camera to X Y | camera follow player | camera zoom N |
      // camera shake N | camera free | camera reset
      if (rest[0] && rest[0].v === 'follow') {
        return 'api.cameraFollow(' + (rest[1]?tokensToExpr(rest.slice(1)):'player') + ');';
      }
      if (rest[0] && rest[0].v === 'to') {
        const args = joinArgs(rest.slice(1));
        return 'api.cameraTo(' + args[0] + ', ' + args[1] + ');';
      }
      if (rest[0] && rest[0].v === 'zoom') {
        return 'api.cameraZoom(' + tokensToExpr(rest.slice(1)) + ');';
      }
      if (rest[0] && rest[0].v === 'shake') {
        return 'api.cameraShake(' + (rest.length>1?tokensToExpr(rest.slice(1)):'10') + ');';
      }
      if (rest[0] && rest[0].v === 'free') {
        return 'api.cameraFree();';
      }
      if (rest[0] && rest[0].v === 'reset') {
        return 'api.cameraReset();';
      }
      return '/* camera: bad syntax */';
    },
    background(rest){ return 'api.setBackground(' + tokensToExpr(rest) + ');'; },
    music(rest)     { return 'api.setMusic(' + tokensToExpr(rest) + ');'; },

    // Utility
    random(rest) {
      const args = joinArgs(rest);
      return 'api.random(' + args.join(', ') + ');';
    },
    ['return'](rest) { return 'return ' + tokensToExpr(rest) + ';'; },
    ['break']() { return 'break;'; },
    ['continue']() { return 'continue;'; },
  };

  // Parse `TARGET by DX DY` shape.
  function parseByExpr(rest) {
    const byIdx = rest.findIndex(t => t.t === 'id' && t.v === 'by');
    let target = 'self', a = '0', b = '0';
    if (byIdx !== -1) {
      target = rest.slice(0, byIdx).length ? tokensToExpr(rest.slice(0, byIdx)) : 'self';
      const args = joinArgs(rest.slice(byIdx + 1));
      a = args[0] || '0';
      b = args[1] || '0';
    } else {
      const args = joinArgs(rest);
      a = args[0] || '0';
      b = args[1] || '0';
    }
    return { target, dx: a, dy: b };
  }

  function parseByOrToExpr(rest) {
    const byIdx = rest.findIndex(t => t.t === 'id' && t.v === 'by');
    const toIdx = rest.findIndex(t => t.t === 'id' && t.v === 'to');
    const idx = byIdx !== -1 ? byIdx : toIdx;
    const mode = byIdx !== -1 ? 'by' : (toIdx !== -1 ? 'to' : 'by');
    if (idx === -1) {
      const args = joinArgs(rest);
      return { mode, target: 'self', a: args[0] || '0', b: args[1] || '0' };
    }
    const target = rest.slice(0, idx).length ? tokensToExpr(rest.slice(0, idx)) : 'self';
    const args = joinArgs(rest.slice(idx + 1));
    return { mode, target, a: args[0] || '0', b: args[1] || '0' };
  }

  // Compile a `create thing at X Y with size ... colour ... texture ... script ...`
  function compileCreate(rest) {
    // First token may be the kind (thing / player / tile). Default: thing.
    let i = 0;
    let kind = 'thing';
    if (rest[0] && rest[0].t === 'id' && ['thing','tile','effect'].includes(rest[0].v)) {
      kind = rest[0].v; i = 1;
    }
    // Consume "at X Y"
    let x = 'self.x', y = 'self.y';
    if (rest[i] && rest[i].v === 'at') {
      i++;
      // read two expressions until 'with' or end.
      const stop = findKeyword(rest, i, ['with', 'colour', 'color', 'size', 'texture', 'script']);
      const args = joinArgs(rest.slice(i, stop === -1 ? rest.length : stop));
      x = args[0] || x;
      y = args[1] || y;
      i = stop === -1 ? rest.length : stop;
    }
    // Optional "with"
    if (rest[i] && rest[i].v === 'with') i++;
    // Parse trailing property list: `size N`, `colour X`, `texture URL`, `script SRC`
    const props = {};
    while (i < rest.length) {
      const key = rest[i] && rest[i].v;
      if (!key) break;
      i++;
      const stop = findKeyword(rest, i, ['size','colour','color','texture','script','with']);
      const val = rest.slice(i, stop === -1 ? rest.length : stop);
      props[key === 'color' ? 'colour' : key] = tokensToExpr(val);
      i = stop === -1 ? rest.length : stop;
    }
    const opts = [];
    opts.push('kind: ' + JSON.stringify(kind));
    opts.push('x: ' + x);
    opts.push('y: ' + y);
    if (props.size)    opts.push('size: '    + props.size);
    if (props.colour)  opts.push('colour: '  + props.colour);
    if (props.texture) opts.push('texture: ' + props.texture);
    if (props.script)  opts.push('script: '  + props.script);
    return 'api.create({ ' + opts.join(', ') + ' });';
  }

  function findKeyword(tokens, start, kws) {
    for (let i = start; i < tokens.length; i++) {
      if (tokens[i].t === 'id' && kws.includes(tokens[i].v)) return i;
    }
    return -1;
  }

  // ── Public API ───────────────────────────────────────────
  global.Pyfork = {
    compile,
    // Build a runnable async function from source. Language: 'pyfork' or 'js'.
    build(source, language) {
      const js = (language === 'js')
        ? wrapJsSource(source)
        : compile(source);
      // The compiled body expects: self, player, world, api, state, ctx
      // eslint-disable-next-line no-new-func
      return new Function('self', 'player', 'world', 'api', 'state', 'ctx',
        '"use strict";\n' +
        'return (async () => {\n' + js + '\n})();'
      );
    },
    KEYWORDS: Object.keys(KEYWORDS),
  };

  // For raw-JS scripts we allow the same handler shape via a helper `H`.
  function wrapJsSource(src) {
    return (
      'const _handlers = { onStart: [], onUpdate: [], events: {}, intervals: [] };\n' +
      'const H = {\n' +
      '  on_start: (fn) => _handlers.onStart.push(fn),\n' +
      '  on_update: (fn) => _handlers.onUpdate.push(fn),\n' +
      '  on: (name, fn) => { (_handlers.events[name] = _handlers.events[name] || []).push(fn); },\n' +
      '  every: (period, fn) => _handlers.intervals.push({ period, fn }),\n' +
      '};\n' +
      src + '\n' +
      'return _handlers;\n'
    );
  }
})(typeof window !== 'undefined' ? window : globalThis);
