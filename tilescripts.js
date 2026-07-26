/**
 * TILE SCRIPTS — optional Pyfork/JS scripts attached to regular map tiles.
 *
 * Any tile (platform, ground, hazard, spawn, lava, ice, bounce) can carry an
 * optional `script` + `language`, compiled with the exact same Pyfork engine
 * used for Things (see pyfork.js), just with a smaller API surface suited to
 * a fixed-position grid tile (no free movement/physics fields).
 *
 * Supported hooks: on_start, on_update / every N, on_touch player, on_click,
 * on 'name' (custom events via trigger/broadcast).
 *
 * Tile scripts are stored directly on the tile object (`tile.script`,
 * `tile.language`) so they serialise with the map automatically — no change
 * needed to the map save/load payload shape.
 */
(function (global) {
  'use strict';

  const eventBus = {};       // name -> [{ tile, fn }]
  const compiled = new WeakMap(); // tile -> { handlers, intervalAccum, state }
  let selectedTile = null;   // tile currently open in the editor modal

  function ensureRuntimeFields(tile) {
    if (!tile._scriptState) tile._scriptState = {};
    if (tile._tag == null) tile._tag = tile.tag || '';
    if (tile._labelText == null) tile._labelText = '';
    if (tile._sayText == null) tile._sayText = '';
    if (tile._sayTimer == null) tile._sayTimer = 0;
    if (tile._solidOverride == null) tile._solidOverride = null; // null = use TILE_CONFIG default
    if (tile._touching == null) tile._touching = false;
  }

  function detachFromBus(tile) {
    for (const name of Object.keys(eventBus)) {
      eventBus[name] = eventBus[name].filter(e => e.tile !== tile);
    }
  }

  function compileTile(tile) {
    detachFromBus(tile);
    compiled.delete(tile);
    if (!tile.script || !tile.script.trim()) return { ok: true };
    try {
      const fn = global.Pyfork.build(tile.script, tile.language || 'pyfork');
      const api = makeApiFor(tile);
      const player = getPlayerProxy();
      const world = getWorldProxy();
      ensureRuntimeFields(tile);
      const p = fn(tile, player, world, api, tile._scriptState, null);
      p.then(handlers => {
        const entry = {
          handlers: handlers || { onStart: [], onUpdate: [], events: {}, intervals: [] },
          intervalAccum: [],
        };
        entry.intervalAccum = (entry.handlers.intervals || []).map(() => 0);
        compiled.set(tile, entry);
        for (const name of Object.keys(entry.handlers.events || {})) {
          for (const h of entry.handlers.events[name]) {
            (eventBus[name] = eventBus[name] || []).push({ tile, fn: h });
          }
        }
        for (const s of (entry.handlers.onStart || [])) {
          Promise.resolve(s.call(tile)).catch(err => console.warn('[Tile on_start]', err));
        }
      }).catch(err => console.error('[Tile compile async]', err));
      return { ok: true };
    } catch (err) {
      console.error('[Tile compile]', err);
      return { ok: false, error: err.message };
    }
  }

  // ── Runtime API exposed to tile scripts (subset of Things' API — no
  //    free-form position/physics since tiles are grid-locked) ──
  function makeApiFor(tile) {
    return {
      print: (...args) => console.log('[Tile ' + tile.type + ']', ...args),
      printMessage: (msg) => {
        if (global.App && App.console && typeof App.console.print === 'function') {
          App.console.print(tile.type, msg, false);
        } else {
          console.log('[Tile ' + tile.type + ']', msg);
        }
      },
      notify: (msg) => (global.App && App.notify ? App.notify(String(msg)) : console.log(msg)),
      say: (t, msg) => { t._sayText = String(msg); t._sayTimer = 2200; },
      setLabel: (t, txt) => { t._labelText = String(txt == null ? '' : txt); },
      setTag: (t, tag) => { t._tag = String(tag == null ? '' : tag); },

      setSolid: (t, v) => { t._solidOverride = !!v; },
      unsetSolidOverride: (t) => { t._solidOverride = null; },

      damage: (target, amt) => {
        if (target && typeof target.hp === 'number') target.hp -= Number(amt) || 0;
      },
      heal: (target, amt) => {
        if (target && typeof target.hp === 'number') target.hp += Number(amt) || 0;
      },

      trigger: (name, payload) => fireEvent(name, payload),
      broadcast: (name, payload) => fireEvent(name, payload),

      sound: () => {},
      playSound: () => {},
      beep: () => { try { new Audio().play && null; } catch (e) {} },

      setBackground: (name) => {
        if (global.state && global.state.map) {
          global.state.map.background = global.state.map.background || {};
          global.state.map.background.name = String(name);
        }
      },
      cameraFollow: (target) => {
        if (!global.state) return;
        state.camera.mode = 'target';
        state.camera.targetRef = (target && typeof target === 'object') ? target : null;
        if (!state.camera.targetRef) state.camera.mode = 'follow';
      },
      cameraTo: (x, y) => {
        if (!global.state) return;
        state.camera.mode = 'target';
        state.camera.targetRef = null;
        state.camera.targetX = Number(x) || 0;
        state.camera.targetY = Number(y) || 0;
      },
      cameraZoom: (z) => {
        if (!global.state) return;
        state.camera.zoom = Math.max(0.2, Math.min(4, Number(z) || 1));
      },
      cameraShake: (mag) => {
        if (!global.state) return;
        state.camera.shakeMag = Math.max(0, Number(mag) || 10);
        state.camera.shakeUntil = state.animTime + 400;
      },
      cameraFree: () => { if (global.state) state.camera.mode = 'free'; },
      cameraReset: () => {
        if (!global.state) return;
        state.camera.mode = 'follow';
        state.camera.targetRef = null;
        state.camera.zoom = 1;
      },

      distance: (a, b) => Math.hypot((a.x||0)-(b.x||0), (a.y||0)-(b.y||0)),
      angleTo: (a, b) => Math.atan2((b.y||0)-(a.y||0), (b.x||0)-(a.x||0)),
      clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
      random: (a, b) => (b == null ? Math.random() * a : a + Math.random() * (b - a)),

      wait: (secs) => new Promise(res => setTimeout(res, Math.max(0, Number(secs) || 0) * 1000)),
    };
  }

  function fireEvent(name, evt) {
    const listeners = eventBus[name] || [];
    for (const l of listeners) {
      try {
        Promise.resolve(l.fn.call(l.tile, evt || {})).catch(err =>
          console.warn('[Tile event:' + name + ']', err));
      } catch (err) {
        console.warn('[Tile event fire]', err);
      }
    }
  }

  let _playerProxy = null;
  function getPlayerProxy() {
    if (_playerProxy) return _playerProxy;
    _playerProxy = new Proxy({}, {
      get(_, key) { const p = global.state && state.localPlayer; return p ? p[key] : undefined; },
      set(_, key, value) { const p = global.state && state.localPlayer; if (p) p[key] = value; return true; },
    });
    return _playerProxy;
  }
  function getWorldProxy() {
    return {
      get width()  { return global.state ? state.map.width  : 0; },
      get height() { return global.state ? state.map.height : 0; },
      get tiles()  { return global.state ? state.map.tiles.slice() : []; },
    };
  }

  // ── Game-loop integration ────────────────────────────────
  function update(dt) {
    for (const t of (global.state ? state.map.tiles : [])) {
      const entry = compiled.get(t);
      if (!entry) continue;
      for (const u of (entry.handlers.onUpdate || [])) {
        Promise.resolve(u.call(t, dt)).catch(err => console.warn('[Tile on_update]', err));
      }
      const intervals = entry.handlers.intervals || [];
      for (let i = 0; i < intervals.length; i++) {
        entry.intervalAccum[i] = (entry.intervalAccum[i] || 0) + dt;
        if (entry.intervalAccum[i] >= intervals[i].period) {
          entry.intervalAccum[i] = 0;
          Promise.resolve(intervals[i].fn.call(t)).catch(err => console.warn('[Tile every]', err));
        }
      }
      if (t._sayTimer > 0) {
        t._sayTimer -= dt * 1000;
        if (t._sayTimer <= 0) t._sayText = '';
      }
    }
  }

  // Called from checkHazards-style AABB loop in app.js with the tiles the
  // player currently overlaps, once per frame.
  function updateTouch(overlappingTiles) {
    const overlappingSet = new Set(overlappingTiles);
    for (const t of (global.state ? state.map.tiles : [])) {
      if (!compiled.has(t)) continue;
      const isTouching = overlappingSet.has(t);
      if (isTouching && !t._touching) {
        t._touching = true;
        fireEvent('touch', { target: getPlayerProxy(), filter: 'player', tile: t });
      } else if (!isTouching && t._touching) {
        t._touching = false;
      }
    }
  }

  function fireClick(tile) {
    fireEvent('click', { tile });
  }

  // Is this tile's solidity overridden by a script? Returns null if no override.
  function solidOverride(tile) {
    return (tile && tile._solidOverride != null) ? tile._solidOverride : null;
  }

  function hasScript(tile) {
    return !!(tile && tile.script && tile.script.trim());
  }

  // ── Editor modal (reuses the #thing-editor-modal DOM if present, else
  //    falls back gracefully — see index.html for the tile-script-modal) ──
  function openEditorFor(tile) {
    selectedTile = tile;
    ensureRuntimeFields(tile);
    const modal = document.getElementById('tile-script-modal');
    if (!modal) return;
    document.getElementById('tile-script-title').textContent = 'Script: ' + tile.type + ' tile (' + tile.x + ', ' + tile.y + ')';
    document.getElementById('tile-script-source').value = tile.script || '';
    for (const r of document.querySelectorAll('input[name="tile-script-lang"]')) {
      r.checked = (r.value === (tile.language || 'pyfork'));
    }
    modal.classList.remove('hidden');
  }

  function closeEditor() {
    selectedTile = null;
    const modal = document.getElementById('tile-script-modal');
    if (modal) modal.classList.add('hidden');
  }

  function saveCurrent() {
    if (!selectedTile) return;
    selectedTile.script = document.getElementById('tile-script-source').value;
    for (const r of document.querySelectorAll('input[name="tile-script-lang"]')) {
      if (r.checked) selectedTile.language = r.value;
    }
    const res = compileTile(selectedTile);
    if (!res.ok) {
      if (global.App && App.notify) App.notify('Script error: ' + res.error);
      return;
    }
    if (global.App && App.notify) App.notify('📜 Tile script saved');
    if (global.App && App.explorer && App.explorer.open) App.explorer.refresh();
    closeEditor();
  }

  function clearCurrent() {
    if (!selectedTile) return;
    selectedTile.script = '';
    detachFromBus(selectedTile);
    compiled.delete(selectedTile);
    if (global.App && App.notify) App.notify('🗑 Tile script cleared');
    if (global.App && App.explorer && App.explorer.open) App.explorer.refresh();
    closeEditor();
  }

  // Recompile every tile that has a script — called after a map loads.
  function recompileAll() {
    if (!global.state) return;
    for (const name of Object.keys(eventBus)) eventBus[name] = [];
    for (const t of state.map.tiles) {
      if (hasScript(t)) { ensureRuntimeFields(t); compileTile(t); }
    }
  }

  global.TileScripts = {
    update, updateTouch, fireClick,
    solidOverride, hasScript,
    openEditorFor, closeEditor, saveCurrent, clearCurrent,
    recompileAll,
  };
})(typeof window !== 'undefined' ? window : globalThis);
