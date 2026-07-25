/**
 * THINGS — scripted textured objects for Dihblocks.
 *
 * A "Thing" is a positional object with:
 *   - a texture (image URL or data URL) and a fallback colour
 *   - a physics mode: static | dynamic | ghost
 *   - a script written in Pyfork (Python-like) or plain JS that hooks into
 *     game events (on_start, on_update / every N, on_touch player, on_click,
 *     on 'name', on_key W, ...)
 *
 * Things live inside state.map (as `state.map.things`-ish) and are serialised
 * with the map so that saving/loading a level keeps them intact.
 *
 * File upload guard: any texture upload larger than 500 MB is rejected.
 */
(function (global) {
  'use strict';

  const MAX_FILE_BYTES = 512 * 1024; // 512 KB
  const GRAVITY_DEFAULT = 1600;

  // Runtime list of Things.
  const things = [];
  let selectedThing = null; // Thing currently open in the editor modal.
  let selectedIsNew = false; // true if selectedThing was just created and not yet saved.
  const eventBus = {};      // name -> [{ thing, fn }]

  // ── Data model ───────────────────────────────────────────
  function makeThing(spec = {}) {
    return {
      id: spec.id || ('th_' + Math.random().toString(36).slice(2, 10)),
      name: spec.name || 'Thing',
      x: spec.x || 0,
      y: spec.y || 0,
      vx: 0, vy: 0,
      size: spec.size || 40,
      width: spec.width || spec.size || 40,
      height: spec.height || spec.size || 40,
      colour: spec.colour || '#e94560',
      texture: spec.texture || '',
      physics: spec.physics || 'static',
      language: spec.language || 'pyfork',
      script: spec.script || '',
      tag: spec.tag || '',
      hp: spec.hp != null ? spec.hp : 100,
      maxHp: spec.maxHp != null ? spec.maxHp : 100,
      // runtime only:
      _img: null,
      _handlers: null,
      _state: {},
      _rotation: 0,
      _opacity: 1,
      _visible: true,
      _sayText: '',
      _sayTimer: 0,
      _labelText: '',
      _intervalAccum: [], // per interval accumulator
      _dead: false,
      _flashUntil: 0,
      _facing: 1,
      _gravity: null,      // override per-thing
      _friction: 0.85,
      _layer: 0,
      _frozen: false,
      _locked: false,
    };
  }

  function loadImageInto(thing) {
    if (!thing.texture) { thing._img = null; return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { thing._img = img; };
    img.onerror = () => { thing._img = null; };
    img.src = thing.texture;
  }

  // Compile + attach handlers.
  function compileThing(thing) {
    thing._handlers = null;
    thing._intervalAccum = [];
    if (!thing.script.trim()) return { ok: true };
    try {
      const fn = global.Pyfork.build(thing.script, thing.language);
      // Build the API for this thing.
      const api = makeApiFor(thing);
      const player = getPlayerProxy();
      const world = getWorldProxy();
      // Run once to collect handlers. `await` any top-level init.
      const p = fn(thing, player, world, api, thing._state, /*ctx*/ null);
      // p is a Promise resolving to _handlers.
      p.then(handlers => {
        thing._handlers = handlers || { onStart: [], onUpdate: [], events: {}, intervals: [] };
        thing._intervalAccum = (thing._handlers.intervals || []).map(() => 0);
        // Wire named event handlers into the global bus.
        for (const name of Object.keys(thing._handlers.events || {})) {
          for (const h of thing._handlers.events[name]) {
            (eventBus[name] = eventBus[name] || []).push({ thing, fn: h });
          }
        }
        // Fire on_start.
        for (const s of (thing._handlers.onStart || [])) {
          Promise.resolve(s.call(thing)).catch(err => console.warn('[Thing on_start]', err));
        }
      }).catch(err => {
        console.error('[Thing compile async]', err);
      });
      return { ok: true };
    } catch (err) {
      console.error('[Thing compile]', err);
      return { ok: false, error: err.message };
    }
  }

  function detachThingFromBus(thing) {
    for (const name of Object.keys(eventBus)) {
      eventBus[name] = eventBus[name].filter(e => e.thing !== thing);
    }
  }

  // ── Runtime API exposed to scripts ───────────────────────
  function makeApiFor(owner) {
    return {
      print: (...args) => console.log('[' + owner.name + ']', ...args),
      notify: (msg) => (global.App && App.notify ? App.notify(String(msg)) : console.log(msg)),
      say: (t, msg) => { t._sayText = String(msg); t._sayTimer = 2200; },

      setColour: (t, c) => { t.colour = String(c); },
      setTexture: (t, url) => { t.texture = String(url); loadImageInto(t); },
      setSize: (t, s) => { t.size = Number(s) || t.size; t.width = t.size; t.height = t.size; },
      setWidth: (t, w) => { t.width = Number(w) || t.width; },
      setHeight: (t, h) => { t.height = Number(h) || t.height; },
      setScale: (t, s) => {
        const f = Number(s) || 1;
        t.size = t.size * f; t.width = t.width * f; t.height = t.height * f;
      },
      rotate: (t, deg) => { t._rotation = (t._rotation + (Number(deg)||0)) % 360; },
      setRotation: (t, deg) => { t._rotation = Number(deg) || 0; },
      setOpacity: (t, o) => { t._opacity = Math.max(0, Math.min(1, Number(o))); },
      fade: (t, from, to, dur) => {
        const start = performance.now();
        const a = Number(from), b = Number(to), d = Math.max(1, Number(dur)*1000 || 500);
        const step = () => {
          const p = Math.min(1, (performance.now() - start) / d);
          t._opacity = a + (b - a) * p;
          if (p < 1 && !t._dead) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      },
      setVisible: (t, v) => { t._visible = !!v; },
      setLayer: (t, z) => { t._layer = Number(z) || 0; },
      setLabel: (t, txt) => { t._labelText = String(txt == null ? '' : txt); },
      setTag: (t, tag) => { t.tag = String(tag == null ? '' : tag); },

      setGravity: (t, g) => { t._gravity = Number(g); },
      setFriction: (t, f) => { t._friction = Math.max(0, Math.min(1, Number(f))); },
      setSolid: (t, v) => { t.physics = v ? (t.physics === 'ghost' ? 'static' : t.physics) : 'ghost'; },
      setVelocity: (t, vx, vy) => { t.vx = Number(vx)||0; t.vy = Number(vy)||0; },
      push: (target, dx, dy) => {
        if (!target) return;
        target.vx = (target.vx||0) + Number(dx||0);
        target.vy = (target.vy||0) + Number(dy||0);
      },
      bounce: (target, power) => {
        if (!target) return;
        target.vy = -Math.abs(Number(power)||600);
      },
      jump: (target) => {
        if (!target) return;
        target.vy = -650;
      },

      moveBy: (t, dx, dy) => { if (!t) return; t.x += Number(dx)||0; t.y += Number(dy)||0; },
      moveTo: (t, x, y) => { if (!t) return; t.x = Number(x)||0; t.y = Number(y)||0; },
      face: (t, dir) => {
        if (dir === 'left' || dir === -1) t._facing = -1;
        else if (dir === 'right' || dir === 1) t._facing = 1;
        else if (dir && typeof dir === 'object' && 'x' in dir) t._facing = dir.x > t.x ? 1 : -1;
      },
      follow: (t, target, speed) => {
        if (!t || !target) return;
        const s = Number(speed)||80;
        const dx = target.x - t.x, dy = target.y - t.y;
        const d = Math.hypot(dx, dy) || 1;
        t.vx = (dx/d) * s;
        t.vy = (dy/d) * s;
      },
      stop: (t) => { if (t) { t.vx = 0; t.vy = 0; } },
      freeze: (t) => { if (t) { t._frozen = true; t.vx = 0; t.vy = 0; } },
      unfreeze: (t) => { if (t) t._frozen = false; },
      lock: (t) => { if (t) t._locked = true; },
      unlock: (t) => { if (t) t._locked = false; },

      // Health / damage
      damage: (t, amt) => {
        if (!t) return;
        t.hp = Math.max(0, (t.hp == null ? 100 : t.hp) - (Number(amt) || 0));
        if (t.hp <= 0) fireEvent('death', { thing: t });
      },
      heal: (t, amt) => {
        if (!t) return;
        const max = t.maxHp == null ? 100 : t.maxHp;
        t.hp = Math.min(max, (t.hp == null ? 100 : t.hp) + (Number(amt) || 0));
      },
      setHp: (t, v) => { if (t) t.hp = Number(v) || 0; },

      // Geometry helpers
      distance: (a, b) => {
        if (!a || !b) return 0;
        return Math.hypot((a.x||0) - (b.x||0), (a.y||0) - (b.y||0));
      },
      angleTo: (a, b) => {
        if (!a || !b) return 0;
        return Math.atan2((b.y||0) - (a.y||0), (b.x||0) - (a.x||0)) * 180 / Math.PI;
      },
      clamp: (v, lo, hi) => Math.max(Number(lo), Math.min(Number(hi), Number(v))),

      wait: (sec) => new Promise(r => setTimeout(r, Math.max(0, Number(sec)*1000))),

      create: (opts) => {
        const t = makeThing(opts);
        if (opts && opts.script) { t.script = String(opts.script); }
        things.push(t);
        loadImageInto(t);
        compileThing(t);
        return t;
      },
      clone: (t) => {
        if (!t) return null;
        const c = makeThing({ ...t, id: undefined, x: t.x + 20, y: t.y - 20 });
        c.script = t.script; c.language = t.language;
        things.push(c);
        loadImageInto(c);
        compileThing(c);
        return c;
      },
      delete: (t) => {
        if (!t) return;
        t._dead = true;
        detachThingFromBus(t);
      },
      kill: (target) => {
        if (!target) return;
        if (target === getPlayerProxy() && global.state && state.localPlayer) {
          state.localPlayer.isDead = true;
          state.localPlayer.deathTimer = 1200;
          state.localPlayer.vy = -480;
        }
      },
      respawn: (target) => {
        if (target === getPlayerProxy() && global.state && state.localPlayer) {
          // The game's respawn() is defined at module scope in app.js; expose via App.
          if (typeof global.respawn === 'function') global.respawn(state.localPlayer);
        }
      },

      trigger: (name, payload) => fireEvent(String(name), { name, payload }),
      broadcast: (name, payload) => fireEvent(String(name), { name, payload }),
      on: (owner, name, fn) => {
        (eventBus[name] = eventBus[name] || []).push({ thing: owner, fn });
      },
      every: (owner, period, fn) => {
        if (!owner._handlers) owner._handlers = { onStart: [], onUpdate: [], events: {}, intervals: [] };
        owner._handlers.intervals.push({ period, fn });
        owner._intervalAccum.push(0);
      },

      iter: (n) => {
        // range-like helper for `for i in range(n)` or `for x in list`
        if (typeof n === 'number') { const a = []; for (let i=0;i<n;i++) a.push(i); return a; }
        if (Array.isArray(n)) return n;
        return [];
      },
      random: (a, b) => {
        if (a === undefined) return Math.random();
        if (b === undefined) return Math.random() * Number(a);
        return Number(a) + Math.random() * (Number(b) - Number(a));
      },
      playSound: (url) => {
        try { const a = new Audio(String(url)); a.volume = 0.6; a.play().catch(()=>{}); } catch {}
      },
      beep: () => {
        try {
          const AC = global.AudioContext || global.webkitAudioContext;
          if (!AC) return;
          const ctx = new AC();
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.value = 660; g.gain.value = 0.05;
          o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 120);
        } catch {}
      },
      shake: (mag) => {
        if (!global.state) return;
        state.camera.x += (Math.random() - 0.5) * (Number(mag)||6) * 2;
        state.camera.y += (Math.random() - 0.5) * (Number(mag)||6) * 2;
      },
      flash: (color) => {
        // Full-screen flash for 200 ms — draw during render pass.
        Things._flash = { color: String(color||'#fff'), until: performance.now() + 200 };
      },
      setTile: (x, y, type) => {
        if (!global.state) return;
        const key = x + ',' + y;
        state.map.tiles = state.map.tiles.filter(t => !(t.x === x && t.y === y));
        if (type) {
          const nt = { x, y, type };
          state.map.tiles.push(nt);
          if (typeof global.rebuildTileMap === 'function') rebuildTileMap();
        } else {
          if (typeof global.rebuildTileMap === 'function') rebuildTileMap();
        }
      },
      cameraFollow: (target) => {
        if (!global.state || !target) return;
        state.camera.x = target.x - innerWidth/2;
        state.camera.y = target.y - innerHeight/2;
      },
      cameraTo: (x, y) => {
        if (!global.state) return;
        state.camera.x = Number(x)||0;
        state.camera.y = Number(y)||0;
      },
      setBackground: (c) => { Things._bg = String(c||''); },
      setMusic: (url) => {
        try {
          if (Things._music) Things._music.pause();
          const a = new Audio(String(url));
          a.loop = true; a.volume = 0.4;
          a.play().catch(()=>{});
          Things._music = a;
        } catch {}
      },
    };
  }

  function fireEvent(name, evt) {
    const listeners = eventBus[name] || [];
    for (const l of listeners) {
      if (l.thing && l.thing._dead) continue;
      try {
        Promise.resolve(l.fn.call(l.thing, evt || {})).catch(err =>
          console.warn('[Thing event:' + name + ']', err));
      } catch (err) {
        console.warn('[Thing event fire]', err);
      }
    }
  }

  // Player proxy: a live-view of state.localPlayer that Things can read/mutate.
  let _playerProxy = null;
  function getPlayerProxy() {
    if (_playerProxy) return _playerProxy;
    _playerProxy = new Proxy({}, {
      get(_, key) {
        const p = global.state && state.localPlayer;
        if (!p) return undefined;
        return p[key];
      },
      set(_, key, value) {
        const p = global.state && state.localPlayer;
        if (!p) return true;
        p[key] = value;
        return true;
      },
    });
    return _playerProxy;
  }
  function getWorldProxy() {
    return {
      get width()  { return global.state ? state.map.width  : 0; },
      get height() { return global.state ? state.map.height : 0; },
      get things() { return things.slice(); },
      get tiles()  { return global.state ? state.map.tiles.slice() : []; },
    };
  }

  // ── Game-loop integration ────────────────────────────────
  function update(dt, localPlayer) {
    for (const t of things) {
      if (t._dead) continue;

      // Dynamic physics.
      if (t.physics === 'dynamic') {
        const g = (t._gravity != null) ? t._gravity : GRAVITY_DEFAULT;
        t.vy += g * dt;
        t.x += t.vx * dt;
        t.y += t.vy * dt;
        // Very rough tile collision — sit on solid tiles below.
        if (global.state && global.solidAt) {
          const TS = global.TILE_SIZE || 40;
          const bx = Math.floor((t.x + t.size/2) / TS);
          const by = Math.floor((t.y + t.size) / TS);
          if (global.solidAt(bx, by)) {
            t.y = by * TS - t.size;
            t.vy = 0;
            t.vx *= t._friction;
          }
        }
      } else if (t.physics === 'static') {
        t.x += t.vx * dt; t.y += t.vy * dt;
        t.vx *= 0.9; t.vy *= 0.9;
      }

      // Player touch detection (AABB).
      if (localPlayer && !localPlayer.isDead) {
        const p = localPlayer;
        if (p.x < t.x + t.size && p.x + p.w > t.x &&
            p.y < t.y + t.size && p.y + p.h > t.y) {
          if (!t._touching) {
            t._touching = true;
            fireEvent('touch', { target: getPlayerProxy(), filter: 'player', thing: t });
            // Also invoke handlers scoped to this specific thing.
            const local = (t._handlers && t._handlers.events && t._handlers.events.touch) || [];
            for (const fn of local) Promise.resolve(fn.call(t, { target: getPlayerProxy(), filter: 'player', thing: t })).catch(()=>{});
          }
        } else {
          t._touching = false;
        }
      }

      // Intervals.
      if (t._handlers && t._handlers.intervals) {
        for (let i = 0; i < t._handlers.intervals.length; i++) {
          const iv = t._handlers.intervals[i];
          t._intervalAccum[i] = (t._intervalAccum[i] || 0) + dt;
          if (t._intervalAccum[i] >= Number(iv.period)) {
            t._intervalAccum[i] = 0;
            Promise.resolve(iv.fn.call(t)).catch(err => console.warn('[Thing every]', err));
          }
        }
        // onUpdate hooks
        for (const fn of (t._handlers.onUpdate || [])) {
          Promise.resolve(fn.call(t, dt)).catch(err => console.warn('[Thing on_update]', err));
        }
      }

      if (t._sayTimer > 0) t._sayTimer -= dt * 1000;
    }

    // Reap dead.
    for (let i = things.length - 1; i >= 0; i--) if (things[i]._dead) things.splice(i, 1);
  }

  function render(ctx) {
    // World-space is already applied by app.js render (ctx is translated).
    for (const t of things) {
      if (!t._visible) continue;
      ctx.save();
      ctx.globalAlpha = t._opacity;
      const cx = t.x + t.size/2, cy = t.y + t.size/2;
      if (t._rotation) {
        ctx.translate(cx, cy);
        ctx.rotate(t._rotation * Math.PI / 180);
        ctx.translate(-cx, -cy);
      }
      if (t._img) {
        ctx.drawImage(t._img, t.x, t.y, t.size, t.size);
      } else {
        ctx.fillStyle = t.colour;
        ctx.fillRect(t.x, t.y, t.size, t.size);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.strokeRect(t.x + 0.5, t.y + 0.5, t.size - 1, t.size - 1);
      }
      // Speech.
      if (t._sayTimer > 0 && t._sayText) {
        ctx.font = '12px system-ui, sans-serif';
        const w = ctx.measureText(t._sayText).width + 12;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(t.x + t.size/2 - w/2, t.y - 22, w, 18);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(t._sayText, t.x + t.size/2, t.y - 8);
      }
      ctx.restore();
    }

    // Global flash overlay.
    if (Things._flash && performance.now() < Things._flash.until) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = Things._flash.color;
      // draw in world coords covering camera view
      if (global.state) {
        ctx.fillRect(state.camera.x, state.camera.y, innerWidth, innerHeight);
      }
      ctx.restore();
    }
  }

  // Delete a Thing at world coords (used by editor right-click).
  function deleteAt(wx, wy) {
    for (let i = things.length - 1; i >= 0; i--) {
      const t = things[i];
      if (wx >= t.x && wx <= t.x + t.size && wy >= t.y && wy <= t.y + t.size) {
        detachThingFromBus(t);
        things.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // ── Editor modal ─────────────────────────────────────────
  // Find an existing Thing whose bounding box contains the world point (wx, wy).
  function findThingAtPoint(wx, wy) {
    // Iterate in reverse so the most-recently-added (topmost) Thing wins.
    for (let i = things.length - 1; i >= 0; i--) {
      const t = things[i];
      const half = t.size / 2;
      if (wx >= t.x - half && wx <= t.x + half &&
          wy >= t.y - half && wy <= t.y + half) {
        return t;
      }
    }
    return null;
  }

  function openEditorAt(wx, wy) {
    // Reuse an existing Thing at this spot instead of always creating a new
    // one — otherwise every re-edit silently spawned a duplicate blank Thing
    // on top of the original, and the script you edited/saved landed on the
    // throwaway duplicate rather than the Thing actually on the map.
    const existing = findThingAtPoint(wx, wy);
    selectedThing = existing || makeThing({ x: wx, y: wy, name: 'Thing ' + (things.length + 1) });
    selectedIsNew = !existing;
    if (!existing) things.push(selectedThing);
    populateEditor(selectedThing);
    document.getElementById('modal-thing').classList.remove('hidden');
  }

  function populateEditor(t) {
    const $ = id => document.getElementById(id);
    $('thing-name').value = t.name;
    $('thing-size').value = t.size;
    $('thing-tex-url').value = t.texture;
    $('thing-color').value = t.colour;
    $('thing-physics').value = t.physics;
    $('thing-script').value = t.script;
    for (const r of document.querySelectorAll('input[name="thing-lang"]')) {
      r.checked = (r.value === t.language);
    }
    $('thing-error').classList.add('hidden');
    $('thing-compiled').style.display = 'none';

    $('thing-tex-file').onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > MAX_FILE_BYTES) {
        showError('File too large (' + fmtBytes(f.size) + '). Maximum is 512 KB.');
        e.target.value = '';
        return;
      }
      const url = await fileToDataUrl(f);
      $('thing-tex-url').value = url;
    };
  }

  function closeEditor() {
    // Cancelling a brand-new (never-saved) Thing should discard it, not
    // leave an invisible/blank Thing sitting on the map.
    if (selectedIsNew && selectedThing) {
      const i = things.indexOf(selectedThing);
      if (i !== -1) things.splice(i, 1);
      detachThingFromBus(selectedThing);
    }
    document.getElementById('modal-thing').classList.add('hidden');
    selectedThing = null;
    selectedIsNew = false;
  }

  function saveCurrent() {
    if (!selectedThing) return;
    const $ = id => document.getElementById(id);
    selectedThing.name = $('thing-name').value.trim() || 'Thing';
    selectedThing.size = Math.max(8, Math.min(512, Number($('thing-size').value) || 40));
    selectedThing.texture = $('thing-tex-url').value.trim();
    selectedThing.colour = $('thing-color').value;
    selectedThing.physics = $('thing-physics').value;
    selectedThing.script = $('thing-script').value;
    for (const r of document.querySelectorAll('input[name="thing-lang"]')) {
      if (r.checked) selectedThing.language = r.value;
    }
    detachThingFromBus(selectedThing);
    loadImageInto(selectedThing);
    const res = compileThing(selectedThing);
    if (!res.ok) { showError('Script error: ' + res.error); return; }
    selectedIsNew = false; // saved successfully, so it's no longer "new/unsaved"
    closeEditor();
    if (global.App && App.notify) App.notify('✨ Thing saved');
  }

  function deleteCurrent() {
    if (!selectedThing) return;
    const i = things.indexOf(selectedThing);
    if (i !== -1) things.splice(i, 1);
    detachThingFromBus(selectedThing);
    selectedIsNew = false; // already removed above; closeEditor shouldn't remove it again
    closeEditor();
  }

  function showCompiled() {
    if (!selectedThing) return;
    const $ = id => document.getElementById(id);
    let lang = 'pyfork';
    for (const r of document.querySelectorAll('input[name="thing-lang"]')) if (r.checked) lang = r.value;
    let js;
    try {
      js = (lang === 'js')
        ? $('thing-script').value
        : global.Pyfork.compile($('thing-script').value);
    } catch (err) {
      showError('Compile error: ' + err.message); return;
    }
    const el = $('thing-compiled');
    el.textContent = js;
    el.style.display = 'block';
  }

  function showError(msg) {
    const el = document.getElementById('thing-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    if (n < 1024*1024*1024) return (n/1024/1024).toFixed(1) + ' MB';
    return (n/1024/1024/1024).toFixed(2) + ' GB';
  }

  function fileToDataUrl(f) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });
  }

  // ── Persistence (called from app.js applyMapData / saveCurrentMap) ──
  function serialize() {
    return things.map(t => ({
      id: t.id, name: t.name, x: t.x, y: t.y, size: t.size,
      width: t.width, height: t.height,
      colour: t.colour, texture: t.texture, physics: t.physics,
      language: t.language, script: t.script,
      tag: t.tag, hp: t.hp, maxHp: t.maxHp,
    }));
  }

  function loadAll(list) {
    // Detach all.
    for (const t of things) detachThingFromBus(t);
    things.length = 0;
    for (const spec of (list || [])) {
      const t = makeThing(spec);
      things.push(t);
      loadImageInto(t);
      compileThing(t);
    }
  }

  // Utility hook other code can call.
  function forEach(fn) { for (const t of things) if (!t._dead) fn(t); }

  // ── Public ───────────────────────────────────────────────
  global.Things = {
    MAX_FILE_BYTES,
    update, render,
    openEditorAt, closeEditor, saveCurrent, deleteCurrent, showCompiled,
    deleteAt,
    serialize, loadAll,
    forEach,
    trigger: fireEvent,
    _flash: null,
    _bg: null,
    _music: null,
  };
})(typeof window !== 'undefined' ? window : globalThis);
