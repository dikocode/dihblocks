/**
 * DIHBLOCKS — app.js
 * Complete game engine: fixed-timestep physics, chunk/preload rendering,
 * studio block placement, mobile controls, cross-platform input.
 */
'use strict';

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */
const TILE        = 32;          // pixels per tile
const CHUNK_SIZE  = 16;          // tiles per chunk side
const PHYS_STEP   = 1 / 60;     // fixed physics dt (60 Hz regardless of display)
const GRAVITY     = 0.55;        // px / tick
const JUMP_FORCE  = -13.5;       // px / tick (negative = up)
const MOVE_SPEED  = 4.5;         // px / tick
const FRICTION    = 0.78;        // per-tick multiplier (ground)
const AIR_DRAG    = 0.92;        // per-tick multiplier (air horizontal)
const ICE_FRIC    = 0.98;        // per-tick multiplier (ice ground)
const BOUNCE_VEL  = -18;         // px / tick on bounce tiles
const MAX_FALL    = 22;          // terminal velocity px / tick
const CAM_LERP    = 0.10;        // camera follow smoothing (per tick)
const PLAYER_W    = 24;
const PLAYER_H    = 36;

const TILE_DEFS = {
  platform: { col: '#4a9eff', solid: true,  label: 'Platform' },
  ground:   { col: '#5c8a3c', solid: true,  label: 'Ground'   },
  hazard:   { col: '#e74c3c', solid: false, damage: true, label: 'Hazard' },
  spawn:    { col: '#f5a623', solid: false, label: 'Spawn'    },
  lava:     { col: '#ff6b00', solid: false, damage: true, label: 'Lava'   },
  ice:      { col: '#aef0ff', solid: true,  ice: true,  label: 'Ice'     },
  bounce:   { col: '#c678dd', solid: true,  bounce: true, label: 'Bounce' },
};

/* ═══════════════════════════════════════════════════════════
   MUTABLE GAME STATE  (G)
   ═══════════════════════════════════════════════════════════ */
const G = {
  // world
  tiles:  {},    // "tx,ty" → tileName
  worldW: 120,
  worldH: 60,

  // player physics
  px: 200, py: 100,
  pvx: 0, pvy: 0,
  onGround: false,
  onIce: false,

  // player animation
  facing:  1,
  walkT:   0,
  danceOn: false,
  danceT:  0,

  // fixed-step accumulator
  acc:      0,
  lastTime: 0,

  // camera
  camX: 0, camY: 0,

  // input
  keys: new Set(),

  // mobile joystick
  joyActive: false, joyX: 0, joyY: 0,

  // jump edge-detect (consume once per physics tick)
  jumpQueued: false,

  // RAF handle
  rafId: null, running: false,

  // canvas refs
  canvas: null, ctx: null,

  // appearance (cached from localStorage)
  appearance: null,

  // user session
  user: null,
  currentMapId: null,

  // render settings
  renderMode:  'preloader',   // 'preloader' | 'chunk'
  chunkRadius: 3,
  loadedChunks: {},           // chunkKey → true (chunk mode)

  // star/parallax background offsets
  stars: [],
};

/* ═══════════════════════════════════════════════════════════
   STORAGE HELPERS
   ═══════════════════════════════════════════════════════════ */
function lsGet(k, def) {
  try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : def; }
  catch { return def; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function hashPw(pw) {
  let h = 5381;
  for (let i = 0; i < pw.length; i++) h = (h * 33 ^ pw.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/* ═══════════════════════════════════════════════════════════
   APPEARANCE HELPERS
   ═══════════════════════════════════════════════════════════ */
const DEFAULT_APP = {
  head: '#f5c842', torso: '#3a8bff', legs: '#2c3e50', arms: '#f5c842',
  shirtUrl: '', hatUrl: '',
};
function getAppearance() { return lsGet('dihblocks_appearance', { ...DEFAULT_APP }); }

/* ═══════════════════════════════════════════════════════════
   MAP GENERATION
   ═══════════════════════════════════════════════════════════ */
function generateDefaultMap() {
  const t = {};
  // Ground layer
  for (let x = 0; x < 120; x++) {
    t[`${x},40`] = 'ground';
    t[`${x},41`] = 'ground';
    t[`${x},42`] = 'ground';
  }
  // Platforms
  const plats = [
    [5,37,5,'platform'],[14,33,5,'platform'],[24,29,6,'platform'],
    [34,35,4,'ice'],    [42,31,5,'platform'],[52,27,7,'platform'],
    [63,33,4,'bounce'], [70,29,5,'platform'],[82,33,6,'ice'],
    [92,28,5,'platform'],[102,33,5,'platform'],
  ];
  for (const [x,y,w,type] of plats) {
    for (let i = 0; i < w; i++) t[`${x+i},${y}`] = type;
  }
  // Hazard row on a platform
  for (let i = 0; i < 3; i++) t[`${55+i},26`] = 'hazard';
  // Lava pool
  for (let i = 0; i < 5; i++) t[`${45+i},38`] = 'lava';
  // Spawn
  t['3,39'] = 'spawn';
  return t;
}

/* ═══════════════════════════════════════════════════════════
   HTML ESCAPE
   ═══════════════════════════════════════════════════════════ */
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ═══════════════════════════════════════════════════════════
   SCREEN SWITCHER
   ═══════════════════════════════════════════════════════════ */
function showScreen(id) {
  ['screen-auth','screen-home','screen-game'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
}

/* ═══════════════════════════════════════════════════════════
   NOTIFICATIONS
   ═══════════════════════════════════════════════════════════ */
function notify(text, ms = 2600) {
  const area = document.getElementById('notification-area');
  if (!area) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  area.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 330); }, ms);
}

/* ═══════════════════════════════════════════════════════════
   CHUNK SYSTEM
   ═══════════════════════════════════════════════════════════ */
function chunkKey(cx, cy)  { return `${cx},${cy}`; }
function tileToChunk(tx, ty) {
  return { cx: Math.floor(tx / CHUNK_SIZE), cy: Math.floor(ty / CHUNK_SIZE) };
}
function refreshChunks() {
  const { cx: pcx, cy: pcy } = tileToChunk(Math.floor(G.px / TILE), Math.floor(G.py / TILE));
  const r = G.chunkRadius;
  for (let cy = pcy - r; cy <= pcy + r; cy++) {
    for (let cx = pcx - r; cx <= pcx + r; cx++) {
      G.loadedChunks[chunkKey(cx, cy)] = true;
    }
  }
}
function isTileVisible(tx, ty) {
  if (G.renderMode !== 'chunk') return true;
  const { cx, cy } = tileToChunk(tx, ty);
  return !!G.loadedChunks[chunkKey(cx, cy)];
}

/* ═══════════════════════════════════════════════════════════
   PHYSICS
   ═══════════════════════════════════════════════════════════ */
function physicsStep() {
  // ── Horizontal input ────────────────────────────────────
  let moveX = 0;
  if (G.keys.has('ArrowLeft')  || G.keys.has('KeyA')) moveX = -1;
  if (G.keys.has('ArrowRight') || G.keys.has('KeyD')) moveX =  1;

  // Mobile joystick horizontal
  if (G.joyActive && Math.abs(G.joyX) > 0.25) moveX = G.joyX > 0 ? 1 : -1;
  // Mobile joystick up → queue jump
  if (G.joyActive && G.joyY < -0.55 && G.onGround) G.jumpQueued = true;

  // Apply horizontal velocity
  if (moveX !== 0) {
    G.pvx = moveX * MOVE_SPEED;
    G.facing = moveX;
    if (G.onGround) G.walkT++;
  } else {
    const fr = G.onIce ? ICE_FRIC : (G.onGround ? FRICTION : AIR_DRAG);
    G.pvx *= fr;
    if (Math.abs(G.pvx) < 0.1) G.pvx = 0;
  }

  // ── Jump ────────────────────────────────────────────────
  const wantJump = G.jumpQueued
    || G.keys.has('Space') || G.keys.has('ArrowUp') || G.keys.has('KeyW');
  G.jumpQueued = false;

  if (wantJump && G.onGround) {
    G.pvy = JUMP_FORCE;
    G.onGround = false;
  }

  // ── Gravity ─────────────────────────────────────────────
  G.pvy += GRAVITY;
  if (G.pvy > MAX_FALL) G.pvy = MAX_FALL;

  // ── Move & collide (split-axis) ──────────────────────────
  G.onGround = false;
  G.onIce    = false;

  G.px += G.pvx;
  resolveX();

  G.py += G.pvy;
  resolveY();

  // ── World bounds ─────────────────────────────────────────
  if (G.px < 0)                    { G.px = 0; G.pvx = 0; }
  if (G.px + PLAYER_W > G.worldW * TILE) { G.px = G.worldW * TILE - PLAYER_W; G.pvx = 0; }
  if (G.py > G.worldH * TILE + 200) respawn();

  // ── Dance animation ──────────────────────────────────────
  if (G.danceOn) G.danceT++; else G.danceT = 0;

  // ── Camera smooth follow ─────────────────────────────────
  if (G.canvas) {
    const tw = G.canvas.clientWidth  || G.canvas.width;
    const th = G.canvas.clientHeight || G.canvas.height;
    G.camX += (G.px + PLAYER_W / 2 - tw / 2 - G.camX) * CAM_LERP;
    G.camY += (G.py + PLAYER_H / 2 - th / 2 - G.camY) * CAM_LERP;
  }

  // ── Chunk refresh ────────────────────────────────────────
  if (G.renderMode === 'chunk') refreshChunks();
}

function resolveX() {
  const l = G.px, r = G.px + PLAYER_W;
  const ty0 = Math.floor(G.py / TILE);
  const ty1 = Math.floor((G.py + PLAYER_H - 1) / TILE);
  const tx0 = Math.floor(l / TILE);
  const tx1 = Math.floor(r / TILE);

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const def = TILE_DEFS[G.tiles[`${tx},${ty}`]];
      if (!def || !def.solid) continue;
      const tl = tx * TILE, tr = tl + TILE;
      if (r > tl && l < tr) {
        if (G.pvx > 0) { G.px = tl - PLAYER_W; G.pvx = 0; }
        else            { G.px = tr;             G.pvx = 0; }
      }
    }
  }
}

function resolveY() {
  const t = G.py, b = G.py + PLAYER_H;
  const l = G.px + 2, r = G.px + PLAYER_W - 2; // shrink horizontally for crisper corners
  const ty0 = Math.floor(t / TILE);
  const ty1 = Math.floor((b - 1) / TILE);
  const tx0 = Math.floor(l / TILE);
  const tx1 = Math.floor(r / TILE);

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const tileType = G.tiles[`${tx},${ty}`];
      const def = TILE_DEFS[tileType];
      if (!def) continue;

      if (def.damage) { respawn(); return; }
      if (!def.solid) continue;

      const tt = ty * TILE, tb = tt + TILE;
      if (b > tt && t < tb) {
        if (G.pvy >= 0) {
          // Landing
          G.py = tt - PLAYER_H;
          if (def.bounce) {
            G.pvy = BOUNCE_VEL;
            notify('Boing!');
          } else {
            G.pvy    = 0;
            G.onGround = true;
            G.onIce    = !!def.ice;
          }
        } else {
          // Head bump
          G.py  = tb;
          G.pvy = 0;
        }
      }
    }
  }
}

function respawn() {
  const entry = Object.entries(G.tiles).find(([, v]) => v === 'spawn');
  if (entry) {
    const [tx, ty] = entry[0].split(',').map(Number);
    G.px = tx * TILE + TILE / 2 - PLAYER_W / 2;
    G.py = ty * TILE - PLAYER_H;
  } else {
    G.px = 200; G.py = 100;
  }
  G.pvx = 0; G.pvy = 0;
  notify('Respawned!');
}

/* ═══════════════════════════════════════════════════════════
   RENDERING
   ═══════════════════════════════════════════════════════════ */
function drawPlayer(ctx, sx, sy, app, facing, walkT, onGround, danceT) {
  ctx.save();
  const hw = PLAYER_W / 2, hh = PLAYER_H / 2;

  // Animation
  const legSwing = onGround ? Math.sin(walkT * 0.26) * 5 : 0;
  const armSwing = onGround ? Math.sin(walkT * 0.26 + Math.PI) * 4 : 0;
  let bodyBob = 0, bodyTilt = 0;
  if (danceT > 0) {
    bodyBob  = Math.sin(danceT * 0.18) * 3;
    bodyTilt = Math.sin(danceT * 0.12) * 0.18;
  }

  ctx.translate(Math.round(sx + hw), Math.round(sy + hh + bodyBob));
  ctx.rotate(bodyTilt * facing);
  if (facing < 0) ctx.scale(-1, 1);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(0, hh + 1, hw, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs
  ctx.fillStyle = app.legs;
  ctx.fillRect(-hw / 2 - 1 + legSwing,  hh - 13, hw - 2, 13);  // L
  ctx.fillRect(1 - legSwing,             hh - 13, hw - 2, 13);  // R

  // Torso
  ctx.fillStyle = app.torso;
  ctx.fillRect(-hw + 2, -4, PLAYER_W - 4, 18);

  // Torso highlight
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(-hw + 2, -4, PLAYER_W - 4, 3);

  // Arms
  ctx.fillStyle = app.arms;
  ctx.fillRect(-hw - 4, -1 + armSwing,  5, 11);  // L arm
  ctx.fillRect( hw - 1, -1 - armSwing,  5, 11);  // R arm

  // Head
  ctx.fillStyle = app.head;
  ctx.fillRect(-hw + 2, -hh, PLAYER_W - 4, hh - 2);

  // Head highlight
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(-hw + 2, -hh, PLAYER_W - 4, 3);

  // Eyes
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(-5, -hh + 7, 4, 4);
  ctx.fillRect( 2, -hh + 7, 4, 4);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(-5, -hh + 7, 2, 2);
  ctx.fillRect( 2, -hh + 7, 2, 2);

  ctx.restore();
}

function drawPlayerPreview(ctx, cx, cy, app, facing) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
  bg.addColorStop(0, '#0f1020');
  bg.addColorStop(1, '#1a1c2e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // Ground line
  ctx.fillStyle = '#2a2d45';
  ctx.fillRect(0, cy + 2, ctx.canvas.width, 3);
  // Player
  drawPlayer(ctx, cx - PLAYER_W / 2, cy - PLAYER_H, app, facing, 0, true, 0);
}

function initStars(w, h) {
  G.stars = [];
  for (let i = 0; i < 80; i++) {
    G.stars.push({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.5 + 0.3, s: Math.random() * 0.3 + 0.1 });
  }
}

function render() {
  const canvas = G.canvas;
  const ctx    = G.ctx;
  if (!canvas || !ctx) return;

  const cw = canvas.width;
  const ch = canvas.height;

  // ── Sky ─────────────────────────────────────────────────
  const sky = ctx.createLinearGradient(0, 0, 0, ch);
  sky.addColorStop(0, '#050510');
  sky.addColorStop(1, '#0c1230');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, cw, ch);

  // ── Stars (parallax layer) ───────────────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (const s of G.stars) {
    const sx = ((s.x - G.camX * s.s) % cw + cw) % cw;
    const sy = ((s.y - G.camY * s.s * 0.3) % ch + ch) % ch;
    ctx.beginPath();
    ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  const cx = Math.round(G.camX);
  const cy = Math.round(G.camY);

  // ── Visible tile range ───────────────────────────────────
  const tx0 = Math.floor(cx / TILE);
  const ty0 = Math.floor(cy / TILE);
  const tx1 = tx0 + Math.ceil(cw / TILE) + 1;
  const ty1 = ty0 + Math.ceil(ch / TILE) + 1;

  // ── Tiles ────────────────────────────────────────────────
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const tile = G.tiles[`${tx},${ty}`];
      if (!tile || tile === 'spawn') continue;
      if (!isTileVisible(tx, ty)) continue;

      const def = TILE_DEFS[tile];
      if (!def) continue;

      const sx = tx * TILE - cx;
      const sy = ty * TILE - cy;

      ctx.fillStyle = def.col;
      ctx.fillRect(sx, sy, TILE, TILE);

      // Top highlight
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(sx, sy, TILE, 2);
      // Bottom shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(sx, sy + TILE - 2, TILE, 2);
      // Right edge
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(sx + TILE - 1, sy, 1, TILE);

      // Spawn marker
      if (tile === 'spawn') {
        ctx.strokeStyle = 'rgba(245,166,35,0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
      }

      // Lava shimmer
      if (tile === 'lava') {
        ctx.fillStyle = `rgba(255,140,0,${0.15 + 0.1 * Math.sin(Date.now() / 300 + tx)})`;
        ctx.fillRect(sx, sy, TILE, TILE);
      }
    }
  }

  // ── Player ───────────────────────────────────────────────
  const psx = Math.round(G.px - cx);
  const psy = Math.round(G.py - cy);
  drawPlayer(ctx, psx, psy, G.appearance || getAppearance(), G.facing, G.walkT, G.onGround, G.danceT);
}

/* ═══════════════════════════════════════════════════════════
   FIXED-TIMESTEP GAME LOOP
   Physics runs at exactly 60 Hz regardless of display refresh rate.
   Works identically on 60 Hz, 120 Hz, and 144 Hz monitors.
   ═══════════════════════════════════════════════════════════ */
function gameLoop(timestamp) {
  if (!G.running) return;

  // Delta time in seconds
  if (!G.lastTime) G.lastTime = timestamp;
  let dt = (timestamp - G.lastTime) / 1000;
  G.lastTime = timestamp;

  // Cap dt to prevent spiral-of-death after tab is unfocused
  dt = Math.min(dt, 0.10);
  G.acc += dt;

  // Run physics at exactly 60 Hz — one tick per 1/60 s
  while (G.acc >= PHYS_STEP) {
    physicsStep();
    G.acc -= PHYS_STEP;
  }

  // Resize canvas to match CSS layout
  const canvas = G.canvas;
  if (canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth  * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
      G.ctx.scale(dpr, dpr);
      initStars(canvas.clientWidth, canvas.clientHeight);
    }
  }

  render();

  G.rafId = requestAnimationFrame(gameLoop);
}

/* ═══════════════════════════════════════════════════════════
   INPUT HANDLING
   ═══════════════════════════════════════════════════════════ */
function onKeyDown(e) {
  G.keys.add(e.code);

  // Jump: queue on first press
  if ((e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') && G.onGround) {
    G.jumpQueued = true;
  }
  if (e.code === 'Space') e.preventDefault();

  // Dance toggle
  if (e.code === 'KeyE') G.danceOn = true;

  // Chat focus shortcut
  if (e.code === 'KeyT') {
    const chatInput = document.getElementById('chat-input');
    if (chatInput && !chatInput.matches(':focus')) {
      const panel = document.getElementById('side-panel');
      if (panel && panel.classList.contains('collapsed')) panel.classList.remove('collapsed');
      chatInput.focus();
      e.preventDefault();
    }
  }
}

function onKeyUp(e) {
  G.keys.delete(e.code);
  if (e.code === 'KeyE') G.danceOn = false;
}

/* ═══════════════════════════════════════════════════════════
   APP NAMESPACE
   ═══════════════════════════════════════════════════════════ */
const App = {};

/* ─── Auth ──────────────────────────────────────────────── */
App.auth = {
  showTab(tab) {
    document.getElementById('form-login').classList.toggle('hidden',    tab !== 'login');
    document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
    document.getElementById('tab-login').classList.toggle('active',    tab === 'login');
    document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  },

  login() {
    const u  = document.getElementById('login-username').value.trim();
    const pw = document.getElementById('login-password').value;
    const err = document.getElementById('login-error');
    err.classList.add('hidden');
    if (!u || !pw) { err.textContent = 'Please fill all fields.'; err.classList.remove('hidden'); return; }

    const users = lsGet('dihblocks_users', {});
    const rec   = users[u.toLowerCase()];
    if (!rec || rec.passwordHash !== hashPw(pw)) {
      err.textContent = 'Invalid username or password.';
      err.classList.remove('hidden');
      return;
    }
    this._start(rec.username);
  },

  register() {
    const u   = document.getElementById('reg-username').value.trim();
    const pw  = document.getElementById('reg-password').value;
    const pw2 = document.getElementById('reg-confirm').value;
    const err = document.getElementById('reg-error');
    const ok  = document.getElementById('reg-success');
    err.classList.add('hidden'); ok.classList.add('hidden');

    if (!u || !pw || !pw2) { err.textContent = 'Please fill all fields.'; err.classList.remove('hidden'); return; }
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(u)) { err.textContent = 'Username: 3–24 chars, letters/numbers/_.'; err.classList.remove('hidden'); return; }
    if (pw.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.classList.remove('hidden'); return; }
    if (pw !== pw2)    { err.textContent = 'Passwords do not match.'; err.classList.remove('hidden'); return; }

    const users = lsGet('dihblocks_users', {});
    if (users[u.toLowerCase()]) { err.textContent = 'Username already taken.'; err.classList.remove('hidden'); return; }

    users[u.toLowerCase()] = { username: u, passwordHash: hashPw(pw) };
    lsSet('dihblocks_users', users);
    ok.textContent = 'Account created! Signing you in…';
    ok.classList.remove('hidden');
    setTimeout(() => this._start(u), 900);
  },

  guestLogin() {
    const name = 'Guest' + (Math.floor(Math.random() * 9000) + 1000);
    this._start(name, true);
  },

  logout() {
    lsSet('dihblocks_session', null);
    G.user = null;
    App._stopGame();
    showScreen('screen-auth');
  },

  _start(username, guest = false) {
    lsSet('dihblocks_session', { username, guest });
    G.user = { username, guest };
    document.getElementById('home-username').textContent    = username;
    document.getElementById('topbar-username').textContent  = username;
    showScreen('screen-home');
    App.home.refresh();
  },
};

/* ─── Home ──────────────────────────────────────────────── */
App.home = {
  _tab: 'all',

  createNewMap() {
    const id = 'map_' + Date.now();
    const map = {
      id, title: 'Untitled World',
      creator: G.user?.username || 'Guest',
      tiles: generateDefaultMap(),
      worldW: 120, worldH: 60,
      createdAt: Date.now(),
    };
    const maps = lsGet('dihblocks_maps', []);
    maps.unshift(map);
    lsSet('dihblocks_maps', maps);
    App.maps.enterMap(map);
  },

  refresh() {
    const all = lsGet('dihblocks_maps', []);
    this._render(this._tab === 'mine' ? all.filter(m => m.creator === G.user?.username) : all);
  },
  refreshMaps() { this.refresh(); },

  setTab(tab, el) {
    this._tab = tab;
    document.querySelectorAll('.home-tab').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    this.refresh();
  },

  searchMaps() {
    const q = document.getElementById('home-search').value.toLowerCase();
    const all = lsGet('dihblocks_maps', []);
    this._render(q ? all.filter(m =>
      m.title.toLowerCase().includes(q) || m.creator.toLowerCase().includes(q)
    ) : all);
  },

  _render(maps) {
    const grid = document.getElementById('map-grid');
    if (!maps.length) {
      grid.innerHTML = '<div class="empty-state">No worlds yet — create one!</div>';
      return;
    }
    grid.innerHTML = maps.map(m => {
      const ms = esc(JSON.stringify(m));
      const mine = m.creator === G.user?.username;
      return `<div class="map-card">
        <h4>${esc(m.title)}</h4>
        <div class="meta">
          <div class="creator">By <strong>${esc(m.creator)}</strong></div>
          <div>${new Date(m.createdAt).toLocaleDateString()}</div>
        </div>
        <div class="map-card-actions">
          <button class="btn btn-primary btn-sm" onclick='App.maps.enterMapJson(${ms})'>▶ Play</button>
          ${mine ? `<button class="btn btn-ghost btn-sm" onclick="App.maps.deleteMap('${m.id}')">Delete</button>` : ''}
        </div>
      </div>`;
    }).join('');
  },

  returnToBrowser() {
    App._stopGame();
    showScreen('screen-home');
    this.refresh();
  },
};

/* ─── Maps ──────────────────────────────────────────────── */
App.maps = {
  enterMapJson(map) {
    this.enterMap(map);
  },

  enterMap(map) {
    G.currentMapId = map.id;
    G.tiles  = map.tiles ? { ...map.tiles } : generateDefaultMap();
    G.worldW = map.worldW || 120;
    G.worldH = map.worldH || 60;

    document.getElementById('studio-map-title').value = map.title || 'Untitled World';
    document.getElementById('map-title').value        = map.title || 'Untitled World';

    // Spawn player at spawn tile (or default)
    const se = Object.entries(G.tiles).find(([, v]) => v === 'spawn');
    if (se) {
      const [tx, ty] = se[0].split(',').map(Number);
      G.px = tx * TILE + TILE / 2 - PLAYER_W / 2;
      G.py = ty * TILE - PLAYER_H;
    } else {
      G.px = 200; G.py = 100;
    }
    G.pvx = 0; G.pvy = 0;

    // Close studio if open
    document.getElementById('creator-studio').classList.add('hidden');
    App.editor._inStudio = false;
    document.getElementById('mode-badge').textContent = 'PLAY';

    showScreen('screen-game');

    // Load render settings
    const s = lsGet('dihblocks_settings', {});
    G.renderMode  = s.renderMode  || 'preloader';
    G.chunkRadius = s.chunkRadius || 3;
    document.getElementById('render-badge').textContent =
      G.renderMode === 'chunk' ? 'CHUNK' : 'PRELOAD';

    if (G.renderMode === 'chunk') {
      G.loadedChunks = {};
      refreshChunks();
    }

    App._startGame();
    App.chat.init();
    App.mobile.init();
    App.studio._updateStats();
  },

  saveCurrentMap() {
    const title  = document.getElementById('map-title').value.trim() || 'Untitled World';
    const errEl  = document.getElementById('save-map-error');
    const okEl   = document.getElementById('save-map-success');
    errEl.classList.add('hidden'); okEl.classList.add('hidden');

    const id  = G.currentMapId || ('map_' + Date.now());
    G.currentMapId = id;

    const map = {
      id, title,
      creator: G.user?.username || 'Guest',
      tiles:   { ...G.tiles },
      worldW:  G.worldW, worldH: G.worldH,
      createdAt: Date.now(),
    };

    const maps = lsGet('dihblocks_maps', []);
    const idx  = maps.findIndex(m => m.id === id);
    if (idx >= 0) maps[idx] = map; else maps.unshift(map);
    lsSet('dihblocks_maps', maps);

    document.getElementById('studio-map-title').value = title;
    document.getElementById('map-title').value        = title;

    okEl.textContent = '✓ World published!';
    okEl.classList.remove('hidden');
    notify('World saved!');
    setTimeout(() => App.modals.close('savemap'), 1300);
  },

  deleteMap(id) {
    if (!confirm('Delete this world? This cannot be undone.')) return;
    const maps = lsGet('dihblocks_maps', []).filter(m => m.id !== id);
    lsSet('dihblocks_maps', maps);
    App.home.refresh();
  },
};

/* ─── Editor ────────────────────────────────────────────── */
App.editor = {
  _selectedTile: 'platform',
  _inStudio: false,

  toggle() {
    this._inStudio = !this._inStudio;
    const studioEl = document.getElementById('creator-studio');
    studioEl.classList.toggle('hidden', !this._inStudio);
    document.getElementById('mode-badge').textContent = this._inStudio ? 'STUDIO' : 'PLAY';

    if (this._inStudio) {
      App.studio.openCanvas();
    }
  },

  selectTile(tile, el) {
    this._selectedTile = tile;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('selected'));
    el.classList.add('selected');
    const label = tile === 'erase' ? 'Eraser' : (TILE_DEFS[tile]?.label || tile);
    const inspEl = document.getElementById('inspector-selection');
    if (inspEl) inspEl.textContent = label;
    const selLabel = document.getElementById('selected-tile-label');
    if (selLabel) selLabel.textContent = label;
  },

  clearMap() {
    if (!confirm('Clear all tiles? This cannot be undone.')) return;
    G.tiles = {};
    App.studio._updateStats();
    notify('Map cleared');
  },
};

/* ─── Studio ────────────────────────────────────────────── */
App.studio = {
  _camX: 0, _camY: 0,
  _painting: false,
  _dragging: false,
  _dragStart: null,
  _scriptLang: 'dihlang',
  _scriptSources: { dihlang: '', python: '', js: '' },
  _scriptEngine: null,
  _canvas: null, _ctx: null,
  _rafId: null,

  switchLeftTab(tab, el) {
    document.querySelectorAll('#studio-left .panel-tab').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('left-tab-tools').classList.toggle('hidden', tab !== 'tools');
    document.getElementById('left-tab-assets').classList.toggle('hidden', tab !== 'assets');
  },

  switchRightTab(tab, el) {
    document.querySelectorAll('#studio-right .panel-tab').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('right-tab-inspector').classList.toggle('hidden', tab !== 'inspector');
    document.getElementById('right-tab-scripts').classList.toggle('hidden',   tab !== 'scripts');
  },

  switchScriptTab(tab, el) {
    document.querySelectorAll('.script-tab').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    this._scriptLang = tab;
    document.getElementById('script-editor').value = this._scriptSources[tab] || '';
  },

  saveScriptSource() {
    this._scriptSources[this._scriptLang] = document.getElementById('script-editor').value;
  },

  spawnAsset(type) {
    const tx = Math.floor(this._camX / TILE) + 5;
    const ty = Math.floor(this._camY / TILE) + 5;
    G.tiles[`${tx},${ty}`] = type === 'crate' ? 'platform' : 'ground';
    this._updateStats();
    notify(`${type.charAt(0).toUpperCase() + type.slice(1)} placed`);
  },

  runScript() {
    const source  = document.getElementById('script-editor').value;
    const consEl  = document.getElementById('script-console');
    consEl.innerHTML = '';

    if (!this._scriptEngine) {
      const api = {
        move:      (x, y) => { G.px += x; G.py += y; },
        rotate:    () => {},
        color:     () => {},
        size:      () => {},
        create:    () => {},
        destroy:   () => {},
        say:       (msg) => App.chat.addMessage({ author: 'Script', text: String(msg) }),
        playSound: () => {},
        stopSound: () => {},
        gravity:   () => {},
        jumpForce: () => {},
        moveSpeed: () => {},
        friction:  () => {},
        custom:    () => {},
        onError:   (msg) => { consEl.innerHTML += `<div class="log-error">${esc(msg)}</div>`; consEl.scrollTop = 99999; },
        onLog:     (msg) => { consEl.innerHTML += `<div class="log-info">${esc(msg)}</div>`;  consEl.scrollTop = 99999; },
      };
      this._scriptEngine = new window.ScriptEngine(api);
    }
    this._scriptEngine.run(this._scriptLang, source);
  },

  stopScript() {
    if (this._scriptEngine) this._scriptEngine.stop();
    const c = document.getElementById('script-console');
    if (c) c.innerHTML += '<div class="log-info">Stopped.</div>';
  },

  _updateStats() {
    const all = Object.values(G.tiles);
    document.getElementById('stat-tiles').textContent  = all.length;
    document.getElementById('stat-spawns').textContent = all.filter(t => t === 'spawn').length;
    document.getElementById('stat-players').textContent = 1;
  },

  /* ── Canvas initialisation ── */
  openCanvas() {
    const canvas = document.getElementById('studioCanvas');
    if (!canvas) return;

    // Center camera on player
    this._camX = G.px - (canvas.clientWidth  || 640) / 2;
    this._camY = G.py - (canvas.clientHeight || 400) / 2;

    if (this._canvas) {
      // Already set up — just restart render loop
      cancelAnimationFrame(this._rafId);
      this._loop();
      return;
    }

    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');
    this._bindEvents(canvas);
    this._loop();
  },

  /* ── Unified coordinate conversion ── */
  _canvasPos(e) {
    const rect   = this._canvas.getBoundingClientRect();
    const scaleX = this._canvas.width  / rect.width;
    const scaleY = this._canvas.height / rect.height;
    const raw    = e.touches ? (e.touches[0] || e.changedTouches[0]) : e;
    return {
      x: (raw.clientX - rect.left) * scaleX,
      y: (raw.clientY - rect.top)  * scaleY,
    };
  },

  /* ── Place or erase a tile at screen coords ── */
  _paint(sx, sy) {
    const tx = Math.floor((sx / (window.devicePixelRatio || 1) + this._camX) / TILE);
    const ty = Math.floor((sy / (window.devicePixelRatio || 1) + this._camY) / TILE);
    const key = `${tx},${ty}`;
    if (App.editor._selectedTile === 'erase') {
      delete G.tiles[key];
    } else {
      G.tiles[key] = App.editor._selectedTile;
    }
    this._updateStats();
  },

  /* ── Bind all mouse + touch events for placement, deletion, pan ── */
  _bindEvents(canvas) {
    // ── Mouse events ──────────────────────────────────────
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (e.button === 2) {
        // Right-click = pan
        this._dragging  = true;
        this._dragStart = { x: e.clientX, y: e.clientY, cx: this._camX, cy: this._camY };
        return;
      }
      this._painting = true;
      const p = this._canvasPos(e);
      this._paint(p.x, p.y);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this._dragging && this._dragStart) {
        const dx = e.clientX - this._dragStart.x;
        const dy = e.clientY - this._dragStart.y;
        this._camX = this._dragStart.cx - dx;
        this._camY = this._dragStart.cy - dy;
        return;
      }
      if (!this._painting) return;
      const p = this._canvasPos(e);
      this._paint(p.x, p.y);
    });

    const endMouse = () => { this._painting = false; this._dragging = false; this._dragStart = null; };
    canvas.addEventListener('mouseup',    endMouse);
    canvas.addEventListener('mouseleave', endMouse);
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    // Scroll wheel = zoom camera (simple pan simulation)
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._camX += e.deltaX * 0.8;
      this._camY += e.deltaY * 0.8;
    }, { passive: false });

    // ── Touch events (mobile block placement + pan) ────────
    let touchId = null, pinchStartDist = 0, pinchStartCam = null;

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        // Two-finger pinch → pan mode
        this._painting = false;
        const t1 = e.touches[0], t2 = e.touches[1];
        pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        pinchStartCam = { cx: this._camX, cy: this._camY };
        touchId = null;
        return;
      }
      const t = e.changedTouches[0];
      touchId = t.identifier;
      this._painting = true;
      const p = this._canvasPos(e);
      this._paint(p.x, p.y);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 2 && pinchStartCam) {
        // Pan with two fingers (average midpoint delta)
        const t1 = e.touches[0], t2 = e.touches[1];
        const mx = (t1.clientX + t2.clientX) / 2;
        const my = (t1.clientY + t2.clientY) / 2;
        const rect = canvas.getBoundingClientRect();
        const ox = (pinchStartCam.cx + rect.width  / 2);
        const oy = (pinchStartCam.cy + rect.height / 2);
        this._camX = ox - rect.width  / 2 + (rect.left - mx + rect.width  / 2);
        this._camY = oy - rect.height / 2 + (rect.top  - my + rect.height / 2);
        return;
      }
      if (!this._painting) return;
      for (const t of e.changedTouches) {
        if (t.identifier === touchId) {
          const p = this._canvasPos(e);
          this._paint(p.x, p.y);
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === touchId) { this._painting = false; touchId = null; }
      }
      if (e.touches.length < 2) { pinchStartDist = 0; pinchStartCam = null; }
    }, { passive: false });
  },

  /* ── Studio render loop ── */
  _loop() {
    if (!App.editor._inStudio) return;
    const canvas = this._canvas;
    const ctx    = this._ctx;
    if (!canvas || !ctx) return;

    // DPR-aware resize
    const dpr = window.devicePixelRatio || 1;
    const w   = Math.round(canvas.clientWidth  * dpr);
    const h   = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.scale(dpr, dpr);

    // Grid dots
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    const gx0 = Math.floor(this._camX / TILE) * TILE - this._camX;
    const gy0 = Math.floor(this._camY / TILE) * TILE - this._camY;
    for (let x = gx0; x < cw; x += TILE) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
    }
    for (let y = gy0; y < ch; y += TILE) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
    }

    // Tiles
    const tx0 = Math.floor(this._camX / TILE);
    const ty0 = Math.floor(this._camY / TILE);
    const tx1 = tx0 + Math.ceil(cw / TILE) + 1;
    const ty1 = ty0 + Math.ceil(ch / TILE) + 1;

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = G.tiles[`${tx},${ty}`];
        if (!tile) continue;
        const def = TILE_DEFS[tile];
        if (!def) continue;
        const sx = tx * TILE - this._camX;
        const sy = ty * TILE - this._camY;
        ctx.fillStyle = def.col;
        ctx.fillRect(sx, sy, TILE, TILE);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(sx, sy, TILE, 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);

        // Spawn indicator
        if (tile === 'spawn') {
          ctx.strokeStyle = 'rgba(245,166,35,0.85)';
          ctx.lineWidth = 2;
          ctx.strokeRect(sx + 2, sy + 2, TILE - 4, TILE - 4);
          ctx.fillStyle = 'rgba(245,166,35,0.2)';
          ctx.fillRect(sx + 2, sy + 2, TILE - 4, TILE - 4);
        }
      }
    }

    // Player position indicator
    const psx = G.px - this._camX;
    const psy = G.py - this._camY;
    if (psx > -80 && psx < cw + 80 && psy > -80 && psy < ch + 80) {
      ctx.strokeStyle = 'rgba(255,255,100,0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(psx, psy, PLAYER_W, PLAYER_H);
      ctx.fillStyle = 'rgba(255,255,100,0.6)';
      ctx.font = '10px sans-serif';
      ctx.fillText('You', psx, psy - 4);
    }

    ctx.restore();

    this._rafId = requestAnimationFrame(() => this._loop());
  },
};

/* ─── Modals ────────────────────────────────────────────── */
App.modals = {
  openCustomizer() {
    const app = getAppearance();
    document.getElementById('color-head').value       = app.head;
    document.getElementById('color-head-hex').value   = app.head;
    document.getElementById('color-torso').value      = app.torso;
    document.getElementById('color-torso-hex').value  = app.torso;
    document.getElementById('color-legs').value       = app.legs;
    document.getElementById('color-legs-hex').value   = app.legs;
    document.getElementById('color-arms').value       = app.arms;
    document.getElementById('color-arms-hex').value   = app.arms;
    document.getElementById('shirt-url').value        = app.shirtUrl || '';
    document.getElementById('hat-url').value          = app.hatUrl   || '';
    this.updatePreview();
    document.getElementById('modal-customizer').classList.remove('hidden');
  },

  openSaveMap() {
    const title = document.getElementById('studio-map-title').value || '';
    document.getElementById('map-title').value = title;
    document.getElementById('save-map-error').classList.add('hidden');
    document.getElementById('save-map-success').classList.add('hidden');
    document.getElementById('modal-savemap').classList.remove('hidden');
  },

  openSettings() {
    const s = lsGet('dihblocks_settings', {});
    const mode = s.renderMode || G.renderMode || 'preloader';
    document.getElementById('settings-render-mode').value   = mode;
    document.getElementById('settings-chunk-radius').value  = s.chunkRadius || G.chunkRadius || 3;
    this._updateSettingsUI(mode);
    document.getElementById('modal-settings').classList.remove('hidden');
  },

  onRenderModeChange() {
    const mode = document.getElementById('settings-render-mode').value;
    this._updateSettingsUI(mode);
  },

  _updateSettingsUI(mode) {
    const chunkPanel = document.getElementById('chunk-settings-panel');
    const desc       = document.getElementById('render-mode-desc');
    if (mode === 'chunk') {
      chunkPanel.style.display = 'block';
      desc.textContent = 'Dynamically loads chunks around the player. Better memory usage on large maps or lower-end devices.';
    } else {
      chunkPanel.style.display = 'none';
      desc.textContent = 'Loads the entire map into memory when you join. Best performance on most devices.';
    }
  },

  saveSettings() {
    const mode   = document.getElementById('settings-render-mode').value;
    const radius = parseInt(document.getElementById('settings-chunk-radius').value) || 3;
    lsSet('dihblocks_settings', { renderMode: mode, chunkRadius: Math.max(2, Math.min(8, radius)) });
    G.renderMode  = mode;
    G.chunkRadius = Math.max(2, Math.min(8, radius));
    if (mode === 'chunk') { G.loadedChunks = {}; refreshChunks(); }
    document.getElementById('render-badge').textContent = mode === 'chunk' ? 'CHUNK' : 'PRELOAD';
    this.close('settings');
    notify(`Render mode: ${mode === 'chunk' ? 'Chunk Loader' : 'Pre-loader'}`);
  },

  close(name) {
    document.getElementById(`modal-${name}`).classList.add('hidden');
  },

  updatePreview() {
    const app    = this._readForm();
    const canvas = document.getElementById('customizer-canvas');
    if (!canvas) return;
    drawPlayerPreview(canvas.getContext('2d'), 60, 110, app, 1);
  },

  syncColor(part) {
    const hex = document.getElementById(`color-${part}-hex`).value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      document.getElementById(`color-${part}`).value = hex;
      this.updatePreview();
    }
  },

  saveAppearance() {
    const app = this._readForm();
    lsSet('dihblocks_appearance', app);
    G.appearance = app;
    this.close('customizer');
    notify('Appearance saved!');
  },

  _readForm() {
    return {
      head:     document.getElementById('color-head').value,
      torso:    document.getElementById('color-torso').value,
      legs:     document.getElementById('color-legs').value,
      arms:     document.getElementById('color-arms').value,
      shirtUrl: document.getElementById('shirt-url').value,
      hatUrl:   document.getElementById('hat-url').value,
    };
  },
};

/* ─── Chat ──────────────────────────────────────────────── */
App.chat = {
  init() {
    const el = document.getElementById('chat-messages');
    if (el) el.innerHTML = '';
    this.addMessage({ text: 'Welcome to Dihblocks! Use T to chat.', system: true });

    const input = document.getElementById('chat-input');
    if (input && !input._bound) {
      input._bound = true;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); App.chat.send(); }
        e.stopPropagation();
      });
    }
  },

  send() {
    const input = document.getElementById('chat-input');
    const text  = (input?.value || '').trim();
    if (!text) return;
    input.value = '';
    this.addMessage({ author: G.user?.username || 'Guest', text });
  },

  addMessage(msg) {
    const el  = document.getElementById('chat-messages');
    if (!el) return;
    const div = document.createElement('div');
    div.className = 'chat-msg' + (msg.system ? ' system' : '');
    if (msg.system) {
      div.textContent = msg.text;
    } else {
      div.innerHTML = `<span class="msg-author">${esc(msg.author || '?')}:</span>${esc(msg.text)}`;
    }
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  },
};

/* ─── Mobile ────────────────────────────────────────────── */
App.mobile = {
  _touchId: null,
  _isMobile: false,

  init() {
    this._isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const ctrl = document.getElementById('mobile-controls');
    if (ctrl) ctrl.classList.toggle('active', this._isMobile);
    if (this._isMobile) this._setupJoystick();
  },

  jumpStart()  { G.jumpQueued = true; },
  jumpEnd()    { },
  danceStart() { G.danceOn = true; },
  danceEnd()   { G.danceOn = false; },

  _setupJoystick() {
    const base  = document.getElementById('joystick-base');
    const thumb = document.getElementById('joystick-thumb');
    if (!base || !thumb || base._bound) return;
    base._bound = true;

    const move = (clientX, clientY) => {
      const rect = base.getBoundingClientRect();
      const bx   = rect.left + rect.width  / 2;
      const by   = rect.top  + rect.height / 2;
      const dx   = clientX - bx;
      const dy   = clientY - by;
      const dist = Math.hypot(dx, dy);
      const maxR = rect.width / 2 - 26;
      const r    = Math.min(dist, maxR);
      const ang  = Math.atan2(dy, dx);
      const ox   = Math.cos(ang) * r;
      const oy   = Math.sin(ang) * r;
      thumb.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;
      G.joyActive = dist > 12;
      G.joyX      = dist > 12 ? dx / maxR : 0;
      G.joyY      = dist > 12 ? dy / maxR : 0;
    };

    const end = () => {
      thumb.style.transform = 'translate(-50%,-50%)';
      G.joyActive = false; G.joyX = 0; G.joyY = 0;
      this._touchId = null;
    };

    base.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this._touchId = t.identifier;
      move(t.clientX, t.clientY);
    }, { passive: false });

    base.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this._touchId) move(t.clientX, t.clientY);
      }
    }, { passive: false });

    base.addEventListener('touchend',    (e) => { e.preventDefault(); end(); }, { passive: false });
    base.addEventListener('touchcancel', (e) => { e.preventDefault(); end(); }, { passive: false });
  },
};

/* ─── Chat toggle ───────────────────────────────────────── */
App.toggleChat = function() {
  const panel = document.getElementById('side-panel');
  if (panel) panel.classList.toggle('collapsed');
};

/* ═══════════════════════════════════════════════════════════
   GAME START / STOP
   ═══════════════════════════════════════════════════════════ */
App._startGame = function() {
  App._stopGame();
  G.canvas = document.getElementById('gameCanvas');
  G.ctx    = G.canvas.getContext('2d');
  G.running    = true;
  G.lastTime   = 0;
  G.acc        = 0;
  G.appearance = getAppearance();
  initStars(G.canvas.clientWidth || 800, G.canvas.clientHeight || 500);

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup',   onKeyUp);

  G.rafId = requestAnimationFrame(gameLoop);
};

App._stopGame = function() {
  G.running = false;
  if (G.rafId) { cancelAnimationFrame(G.rafId); G.rafId = null; }
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup',   onKeyUp);

  // Stop studio loop
  if (App.studio._rafId) { cancelAnimationFrame(App.studio._rafId); App.studio._rafId = null; }
  App.editor._inStudio = false;
};

/* ═══════════════════════════════════════════════════════════
   BOOT / INIT
   ═══════════════════════════════════════════════════════════ */
function boot() {
  // Load persisted settings
  const s = lsGet('dihblocks_settings', {});
  G.renderMode  = s.renderMode  || 'preloader';
  G.chunkRadius = s.chunkRadius || 3;

  // Animate loading bar
  const bar  = document.getElementById('loader-bar');
  const txt  = document.getElementById('loader-text');
  const msgs = ['Initializing engine…', 'Loading world assets…', 'Preparing physics…', 'Almost ready…'];
  let prog = 0, mi = 0;

  const timer = setInterval(() => {
    prog += Math.random() * 18 + 8;
    if (prog >= 100) prog = 100;
    bar.style.width = prog + '%';
    if (mi < msgs.length && prog > (mi + 1) * 25) txt.textContent = msgs[mi++] || 'Ready!';

    if (prog >= 100) {
      clearInterval(timer);
      setTimeout(() => {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) { overlay.style.transition = 'opacity .4s'; overlay.style.opacity = '0'; setTimeout(() => overlay.style.display = 'none', 420); }

        const sess = lsGet('dihblocks_session', null);
        if (sess && sess.username) {
          G.user = sess;
          document.getElementById('home-username').textContent   = sess.username;
          document.getElementById('topbar-username').textContent = sess.username;
          showScreen('screen-home');
          App.home.refresh();
        } else {
          showScreen('screen-auth');
        }
      }, 300);
    }
  }, 100);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/* Expose globally so inline HTML onclick handlers work */
window.App = App;
