/**
 * DIHBLOCKS — app.js
 * Production 2D real-time multiplayer browser game engine.
 *
 * Architecture:
 *   - StateManager: centralized mutable state
 *   - MapSystem:    load/save/apply maps, baseplate generation
 *   - Player:      local + remote player entity
 *   - Physics:      deterministic tile-based physics
 *   - Renderer:    canvas rendering
 *   - Network:     Supabase realtime with interpolation + delta compression
 *   - Editor:      tile editing + creator studio
 *   - Home:        map browser + world creation
 *   - Chat:        batched messaging with scroll lock
 *   - Scripting:   integration with scripting.js runtimes
 */
'use strict';

/* ══════════════════════════════════════════════════════════
   SUPABASE INIT
   ══════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://blgfhukweibzkasamicm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsZ2ZodWt3ZWliemthc2FtaWNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MjE4NjksImV4cCI6MjEwMDM5Nzg2OX0.i0JQYIC4oahxMNVcJkMYNJVCRu_dkSsqIRpsJKd7Ycc';
const _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

/* ══════════════════════════════════════════════════════════
   CONSTANTS & CONFIG
   ══════════════════════════════════════════════════════════ */
const TILE_SIZE    = 40;
let GRAVITY      = 0.55;
const JUMP_FORCE   = -13.5;
const MOVE_SPEED   = 4.5;
const MAX_FALL_SPD = 18;
const LERP_FACTOR  = 0.18;
const SYNC_RATE_MS = 40;           // 25Hz position broadcast
const CHANNEL_NAME = 'dihblocks-world-v1';
const DANCE_DURATION = 3500;
const INTERP_DELAY_MS = 100;       // remote player interpolation delay
const CHAT_BATCH_MS = 60000;       // batch messages within 60s
const MAX_CHAT_HISTORY = 200;

const TILE_CONFIG = {
  ground:   { color: '#5c8a3c', solid: true,  hazard: false, bounce: false, ice: false },
  platform: { color: '#4a9eff', solid: true,  hazard: false, bounce: false, ice: false },
  hazard:   { color: '#e74c3c', solid: true,  hazard: true,  bounce: false, ice: false },
  spawn:    { color: '#f5a623', solid: false, hazard: false, bounce: false, ice: false },
  lava:     { color: '#ff6b00', solid: false, hazard: true,  bounce: false, ice: false },
  ice:      { color: '#aef0ff', solid: true,  hazard: false, bounce: false, ice: true  },
  bounce:   { color: '#c678dd', solid: true,  hazard: false, bounce: true,  ice: false },
};

/* ══════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════ */
const state = {
  user:      null,
  map:       null,
  tileMap:   {},
  players:   {},
  sessionId: crypto.randomUUID(),
  camera:    { x: 0, y: 0 },
  localPlayer: null,
  channel:   null,
  lastSyncTime: 0,
  editorMode:  false,
  editorTile:  'platform',
  chatOpen:    true,
  pingMs:      0,
  pingStart:   0,
  lastPingTime: 0,
  frame:       0,
  animTime:    0,
  isDragging:  false,
  mouseDown:   false,
  studioMode:  false,
  running:     false,
  lastBroadcast: {},
};

/* ══════════════════════════════════════════════════════════
   MAP SYSTEM
   ══════════════════════════════════════════════════════════ */
function buildBaseplate() {
  const tiles = [];
  const W = 60, H = 30;
  for (let x = 0; x < W; x++) tiles.push({ x, y: H - 1, type: 'ground' });
  tiles.push({ x: 3, y: H - 2, type: 'spawn' });
  return { tiles, width: W * TILE_SIZE, height: H * TILE_SIZE, name: 'Baseplate' };
}

function buildDefaultMap() {
  const tiles = [];
  const W = 60, H = 30;
  for (let x = 0; x < W; x++) tiles.push({ x, y: H - 1, type: 'ground' });
  const platforms = [
    [2,26,8,'platform'],[12,24,5,'platform'],[18,22,5,'platform'],
    [24,20,4,'platform'],[30,18,4,'platform'],[36,16,4,'platform'],
    [42,14,5,'platform'],[48,12,4,'platform'],
    [14,26,1,'hazard'],[15,26,1,'hazard'],
    [20,22,1,'hazard'],
    [26,20,1,'hazard'],[27,20,1,'hazard'],
    [36,22,1,'bounce'],
    [50,10,6,'ice'],
    [20,28,4,'lava'],[21,28,1,'lava'],[22,28,1,'lava'],[23,28,1,'lava'],
    [54,8,5,'platform'],[58,6,4,'platform'],
    [60,4,6,'platform'],
    [0,24,1,'platform'],[0,23,1,'platform'],[0,22,1,'platform'],
  ];
  for (const [sx, sy, len, type] of platforms) {
    for (let i = 0; i < len; i++) tiles.push({ x: sx + i, y: sy, type });
  }
  tiles.push({ x: 3, y: 25, type: 'spawn' });
  return { tiles, width: W * TILE_SIZE, height: H * TILE_SIZE, name: 'Parkour Base' };
}

function rebuildTileMap() {
  state.tileMap = {};
  if (!state.map) return;
  for (const t of state.map.tiles) state.tileMap[`${t.x},${t.y}`] = t;
}

function getSpawnPoint() {
  const spawns = state.map ? state.map.tiles.filter(t => t.type === 'spawn') : [];
  if (spawns.length) {
    const s = spawns[Math.floor(Math.random() * spawns.length)];
    return { x: s.x * TILE_SIZE, y: (s.y - 1) * TILE_SIZE };
  }
  return { x: 3 * TILE_SIZE, y: 24 * TILE_SIZE };
}

function applyMapData(mapData) {
  state.map = {
    tiles:  mapData.tiles || [],
    width:  mapData.width  || 2400,
    height: mapData.height || 1200,
    name:   mapData.name   || 'Unnamed'
  };
  rebuildTileMap();
  if (state.localPlayer) respawn(state.localPlayer);
  App.notify(`🗺 Loaded: ${state.map.name}`);
}

/* ══════════════════════════════════════════════════════════
   UTILS
   ══════════════════════════════════════════════════════════ */
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tileAt(tx, ty) { return state.tileMap[`${tx},${ty}`] || null; }
function solidAt(tx, ty) {
  const t = tileAt(tx, ty);
  return t ? (TILE_CONFIG[t.type]?.solid || false) : false;
}

/* ══════════════════════════════════════════════════════════
   PLAYER CLASS
   ══════════════════════════════════════════════════════════ */
class Player {
  constructor(x, y, username, appearance = {}) {
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.w = 28; this.h = 44;
    this.onGround = false;
    this.username = username;
    this.appearance = {
      headColor: '#f5c842', torsoColor: '#3a8bff', legColor: '#2c3e50',
      armColor: '#f5c842', shirtUrl: '', hatUrl: '', ...appearance
    };
    this.animState = 'idle';
    this.animFrame = 0;
    this.facing = 1;
    this.chatMsg = '';
    this.chatTimer = 0;
    this.danceTimer = 0;
    this.isDancing = false;
    this.deathTimer = 0;
    this.isDead = false;
    this._shirtImg = null; this._hatImg = null;
    this._loadImages();
  }
  _loadImages() {
    if (this.appearance.shirtUrl) {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = this.appearance.shirtUrl;
      img.onload = () => { this._shirtImg = img; };
    }
    if (this.appearance.hatUrl) {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = this.appearance.hatUrl;
      img.onload = () => { this._hatImg = img; };
    }
  }
  updateAppearance(app) {
    this.appearance = { ...this.appearance, ...app };
    this._shirtImg = null; this._hatImg = null;
    this._loadImages();
  }
}

/* Remote player with interpolation buffer */
class RemotePlayer extends Player {
  constructor(x, y, username, appearance) {
    super(x, y, username, appearance);
    this.buffer = []; // { ts, x, y, vx, vy, animState, facing, isDancing }
    this.renderX = x; this.renderY = y;
    this.lastState = null;
  }
  pushState(snapshot) {
    this.buffer.push(snapshot);
    if (this.buffer.length > 12) this.buffer.shift();
  }
  interpolate(now) {
    const renderTs = now - INTERP_DELAY_MS;
    // Find two surrounding states
    let nextIdx = this.buffer.findIndex(s => s.ts >= renderTs);
    if (nextIdx === -1) nextIdx = this.buffer.length - 1;
    if (nextIdx <= 0) {
      if (this.buffer.length) {
        const s = this.buffer[0];
        this.renderX = s.x; this.renderY = s.y;
        this.animState = s.animState; this.facing = s.facing; this.isDancing = s.isDancing;
      }
      return;
    }
    const prev = this.buffer[nextIdx - 1];
    const next = this.buffer[nextIdx];
    const t = (renderTs - prev.ts) / (next.ts - prev.ts);
    const clamped = Math.max(0, Math.min(1, t));
    // Apply dead reckoning using velocity
    const dt = (renderTs - prev.ts) / 1000;
    this.renderX = lerp(prev.x + prev.vx * dt, next.x, clamped);
    this.renderY = lerp(prev.y + prev.vy * dt, next.y, clamped);
    this.animState = next.animState;
    this.facing = next.facing;
    this.isDancing = next.isDancing;
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

/* ══════════════════════════════════════════════════════════
   PHYSICS
   ══════════════════════════════════════════════════════════ */
function resolvePlayerPhysics(p, dt) {
  if (p.isDead) {
    p.deathTimer -= dt;
    if (p.deathTimer <= 0) respawn(p);
    return;
  }
  p.vy += GRAVITY;
  if (p.vy > MAX_FALL_SPD) p.vy = MAX_FALL_SPD;

  p.x += p.vx;
  resolveAxisX(p);
  p.y += p.vy;
  resolveAxisY(p);

  const btx0 = Math.floor(p.x / TILE_SIZE);
  const btx1 = Math.floor((p.x + p.w - 1) / TILE_SIZE);
  const bty  = Math.floor((p.y + p.h) / TILE_SIZE);
  const onIce = (tileAt(btx0, bty)?.type === 'ice') || (tileAt(btx1, bty)?.type === 'ice');
  if (p.onGround) p.vx *= onIce ? 0.98 : 0.78;

  checkHazards(p);

  if (p.y > state.map.height + 200) respawn(p);
  if (p.x < -TILE_SIZE) p.x = -TILE_SIZE;
  if (p.x + p.w > state.map.width + TILE_SIZE) p.x = state.map.width + TILE_SIZE - p.w;
}

function resolveAxisX(p) {
  const tx0 = Math.floor(p.x / TILE_SIZE);
  const tx1 = Math.floor((p.x + p.w - 1) / TILE_SIZE);
  const ty0 = Math.floor(p.y / TILE_SIZE);
  const ty1 = Math.floor((p.y + p.h - 1) / TILE_SIZE);
  for (let ty = ty0; ty <= ty1; ty++) {
    if (solidAt(tx0, ty)) { p.x = (tx0 + 1) * TILE_SIZE; p.vx = 0; }
    if (solidAt(tx1, ty)) { p.x = tx1 * TILE_SIZE - p.w; p.vx = 0; }
  }
}

function resolveAxisY(p) {
  const tx0 = Math.floor(p.x / TILE_SIZE);
  const tx1 = Math.floor((p.x + p.w - 1) / TILE_SIZE);
  const ty0 = Math.floor(p.y / TILE_SIZE);
  const ty1 = Math.floor((p.y + p.h - 1) / TILE_SIZE);
  p.onGround = false;
  if (p.vy < 0) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (solidAt(tx, ty0)) { p.y = (ty0 + 1) * TILE_SIZE; p.vy = 0; }
    }
  }
  if (p.vy >= 0) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (solidAt(tx, ty1)) {
        p.y = ty1 * TILE_SIZE - p.h;
        const t = tileAt(tx, ty1);
        if (t?.type === 'bounce') { p.vy = JUMP_FORCE * 1.4; App.notify('🎉 Bounce!'); }
        else { p.vy = 0; p.onGround = true; }
      }
    }
  }
}

function checkHazards(p) {
  const tx0 = Math.floor((p.x + 4) / TILE_SIZE);
  const tx1 = Math.floor((p.x + p.w - 4) / TILE_SIZE);
  const ty0 = Math.floor((p.y + 4) / TILE_SIZE);
  const ty1 = Math.floor((p.y + p.h - 4) / TILE_SIZE);
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const t = tileAt(tx, ty);
      if (t && TILE_CONFIG[t.type]?.hazard) { die(p); return; }
    }
  }
}

function die(p) {
  if (p.isDead) return;
  p.isDead = true; p.deathTimer = 1200; p.vx = 0; p.vy = -8;
  App.notify('💀 You died!');
}

function respawn(p) {
  p.isDead = false; p.deathTimer = 0;
  const sp = getSpawnPoint();
  p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0;
}

/* ══════════════════════════════════════════════════════════
   INPUT
   ══════════════════════════════════════════════════════════ */
const input = { keys: {}, mobile: { jx: 0, jy: 0, jump: false, dance: false } };

window.addEventListener('keydown', e => {
  const a=document.activeElement;
  const typing=a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable);
  if(!typing){
    input.keys[e.code]=true;
    if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD'].includes(e.code)) e.preventDefault();
    if(e.code==='KeyE') App.dance();
    if(e.code==='KeyT'){e.preventDefault();App.chat.focus();return;}
  }
  if(e.code==='Escape') App.chat.blur();
});
window.addEventListener('keyup', e => { input.keys[e.code] = false; });

function isMobile() { return ('ontouchstart' in window) || navigator.maxTouchPoints > 0; }

/* ══════════════════════════════════════════════════════════
   CANVAS & RENDERER
   ══════════════════════════════════════════════════════════ */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const studioCanvas = document.getElementById('studioCanvas');
const studioCtx = studioCanvas ? studioCanvas.getContext('2d') : null;

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  if (studioCanvas && document.getElementById('studio-canvas-wrap')) {
    const sWrap = document.getElementById('studio-canvas-wrap');
    studioCanvas.width = sWrap.clientWidth;
    studioCanvas.height = sWrap.clientHeight;
  }
}
window.addEventListener('resize', resizeCanvas);

function drawCharacter(ctx, player, screenX, screenY, dt, isLocal) {
  const t = player.animTime || state.animTime;
  const a = player.appearance;
  const f = player.facing;
  const W = player.w, H = player.h;
  const HEAD_R = 10, TORSO_H = 16, LEG_H = 12, ARM_H = 12, ARM_W = 6, LEG_W = 8;
  const cx = screenX + W / 2;
  const cy = screenY;

  ctx.save();
  if (player.isDead) ctx.globalAlpha = 0.4 + Math.sin(Date.now() * 0.02) * 0.3;
  let bobY = 0;
  if (player.isDancing) bobY = Math.sin(t * 0.008) * 5;

  let walkPhase = 0;
  if (player.animState === 'walk') walkPhase = Math.sin(t * 0.012) * 0.6;
  if (player.isDancing) {
    walkPhase = Math.sin(t * 0.006) * 1.0;
    drawArm(ctx, cx, cy + HEAD_R * 2 + TORSO_H * 0.2 + bobY, f, -1, Math.PI / 3 + Math.sin(t * 0.007) * 0.8, a.armColor, ARM_W, ARM_H);
    drawArm(ctx, cx, cy + HEAD_R * 2 + TORSO_H * 0.2 + bobY, f, 1, Math.PI / 3 + Math.cos(t * 0.007) * 0.8, a.armColor, ARM_W, ARM_H);
  } else {
    drawArm(ctx, cx, cy + HEAD_R * 2 + TORSO_H * 0.2 + bobY, f, -1, -walkPhase * 0.7, a.armColor, ARM_W, ARM_H);
    drawArm(ctx, cx, cy + HEAD_R * 2 + TORSO_H * 0.2 + bobY, f, 1, walkPhase * 0.7, a.armColor, ARM_W, ARM_H);
  }

  const legY = cy + HEAD_R * 2 + TORSO_H + bobY;
  if (player.animState === 'jump') {
    drawLeg(ctx, cx, legY, -1, -0.4, a.legColor, LEG_W, LEG_H);
    drawLeg(ctx, cx, legY, 1, 0.4, a.legColor, LEG_W, LEG_H);
  } else if (player.isDancing) {
    drawLeg(ctx, cx, legY, -1, Math.sin(t * 0.009) * 0.8, a.legColor, LEG_W, LEG_H);
    drawLeg(ctx, cx, legY, 1, Math.sin(t * 0.009 + Math.PI) * 0.8, a.legColor, LEG_W, LEG_H);
  } else {
    drawLeg(ctx, cx, legY, -1, walkPhase, a.legColor, LEG_W, LEG_H);
    drawLeg(ctx, cx, legY, 1, -walkPhase, a.legColor, LEG_W, LEG_H);
  }

  const torsoY = cy + HEAD_R * 2 + bobY;
  ctx.fillStyle = a.torsoColor;
  const torsoX = cx - W / 2 + 4;
  const torsoW = W - 8;
  ctx.beginPath(); ctx.roundRect(torsoX, torsoY, torsoW, TORSO_H, 3); ctx.fill();
  if (player._shirtImg) ctx.drawImage(player._shirtImg, torsoX, torsoY, torsoW, TORSO_H);

  const headCY = cy + HEAD_R + bobY;
  ctx.fillStyle = a.headColor;
  ctx.beginPath(); ctx.arc(cx, headCY, HEAD_R, 0, Math.PI * 2); ctx.fill();
  const eyeOffX = f * 3;
  ctx.fillStyle = '#222';
  ctx.beginPath(); ctx.arc(cx + eyeOffX - 2, headCY - 1, 2, 0, Math.PI * 2); ctx.arc(cx + eyeOffX + 3, headCY - 1, 2, 0, Math.PI * 2); ctx.fill();
  if (player.isDancing) {
    ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx + eyeOffX, headCY + 3, 4, 0, Math.PI); ctx.stroke();
  }

  if (player._hatImg) ctx.drawImage(player._hatImg, cx - 14, cy - 12 + bobY, 28, 18);
  else { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(cx - 10, cy + bobY - 2, 20, 4); }

  if (player.chatMsg && player.chatTimer > 0) drawSpeechBubble(ctx, cx, cy + bobY - 16, player.chatMsg);

  ctx.font = 'bold 9px Segoe UI, sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = isLocal ? '#f5a623' : '#eaeaea';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
  ctx.fillText(player.username, cx, cy - 4 + bobY);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawArm(ctx, cx, cy, facing, side, angle, color, aw, ah) {
  ctx.save();
  const ox = cx + side * 14;
  ctx.translate(ox, cy);
  ctx.rotate(angle + (side < 0 ? -0.1 : 0.1));
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.roundRect(-aw / 2, 0, aw, ah, 3); ctx.fill();
  ctx.restore();
}
function drawLeg(ctx, cx, cy, side, angle, color, lw, lh) {
  ctx.save();
  const ox = cx + side * 8;
  ctx.translate(ox, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.roundRect(-lw / 2, 0, lw, lh, 3); ctx.fill();
  ctx.restore();
}
function drawSpeechBubble(ctx, x, y, text) {
  const pad = 6;
  ctx.font = 'bold 10px Segoe UI, sans-serif'; ctx.textAlign = 'center';
  const tw = ctx.measureText(text).width;
  const bw = tw + pad * 2; const bh = 18;
  const bx = x - bw / 2; const by = y - bh - 8;
  ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 6); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 5, by + bh); ctx.lineTo(x, by + bh + 5); ctx.lineTo(x + 5, by + bh); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#222'; ctx.fillText(text, x, by + bh - 5);
}

function drawTile(ctx, tile, sx, sy) {
  const cfg = TILE_CONFIG[tile.type] || TILE_CONFIG.platform;
  const S = TILE_SIZE;
  if (tile.type === 'hazard') {
    ctx.fillStyle = '#c0392b'; ctx.fillRect(sx, sy + S * 0.5, S, S * 0.5);
    ctx.fillStyle = '#e74c3c'; const count = 3; const sw = S / count;
    for (let i = 0; i < count; i++) {
      ctx.beginPath(); ctx.moveTo(sx + i * sw, sy + S * 0.5); ctx.lineTo(sx + i * sw + sw / 2, sy); ctx.lineTo(sx + i * sw + sw, sy + S * 0.5); ctx.closePath(); ctx.fill();
    }
    return;
  }
  if (tile.type === 'spawn') {
    ctx.strokeStyle = '#f5a623'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]); ctx.strokeRect(sx + 2, sy + 2, S - 4, S - 4); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(245,166,35,0.15)'; ctx.fillRect(sx + 2, sy + 2, S - 4, S - 4);
    ctx.fillStyle = '#f5a623'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('⚑', sx + S / 2, sy + S / 2 + 6);
    return;
  }
  if (tile.type === 'lava') {
    const t = Date.now() * 0.003;
    const g = ctx.createLinearGradient(sx, sy, sx, sy + S);
    g.addColorStop(0, `hsl(${20 + Math.sin(t) * 10}, 100%, 55%)`);
    g.addColorStop(1, `hsl(${5 + Math.cos(t) * 5}, 100%, 35%)`);
    ctx.fillStyle = g; ctx.fillRect(sx, sy, S, S);
    ctx.fillStyle = 'rgba(255,180,0,0.5)';
    ctx.beginPath();
    for (let i = 0; i <= S; i += 4) {
      const wY = Math.sin((i + Date.now() * 0.005) * 0.3) * 3;
      if (i === 0) ctx.moveTo(sx, sy + wY + 4); else ctx.lineTo(sx + i, sy + wY + 4);
    }
    ctx.lineTo(sx + S, sy); ctx.lineTo(sx, sy); ctx.closePath(); ctx.fill();
    return;
  }
  if (tile.type === 'bounce') {
    ctx.fillStyle = '#9b59b6'; ctx.fillRect(sx, sy, S, S);
    ctx.fillStyle = '#c678dd'; const bh = Math.abs(Math.sin(Date.now() * 0.005)) * 6;
    ctx.fillRect(sx + 4, sy + S - 8 - bh, S - 8, 8 + bh);
    return;
  }
  if (tile.type === 'ice') {
    ctx.fillStyle = '#cdf0fa'; ctx.fillRect(sx, sy, S, S);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(sx + 2, sy + 2, S - 4, 5); ctx.fillRect(sx + 2, sy + 2, 5, S - 4);
    return;
  }
  ctx.fillStyle = cfg.color; ctx.fillRect(sx, sy, S, S);
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(sx, sy, S, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(sx, sy + S - 4, S, 4);
  ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 0.5; ctx.strokeRect(sx, sy, S, S);
}

function renderFrame(localP, renderCtx = state.studioMode ? studioCtx : ctx, renderCanvas = state.studioMode ? studioCanvas : canvas) {
  renderCtx.clearRect(0, 0, renderCanvas.width, renderCanvas.height);
  const sky = renderCtx.createLinearGradient(0, 0, 0, renderCanvas.height);
  sky.addColorStop(0, '#1a1a3e'); sky.addColorStop(1, '#0f2060');
  renderCtx.fillStyle = sky; renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);

  renderCtx.fillStyle = 'rgba(255,255,255,0.6)';
  const sr = 137.5 + state.camera.x * 0.02;
  for (let i = 0; i < 60; i++) {
    const sx = (i * sr * 1.7) % renderCanvas.width;
    const sy = (i * sr * 2.3) % renderCanvas.height;
    const br = (Math.sin(state.animTime * 0.001 + i) * 0.5 + 0.5);
    renderCtx.globalAlpha = br * 0.5;
    renderCtx.fillRect(sx, sy, 1.5, 1.5);
  }
  renderCtx.globalAlpha = 1;

  renderCtx.save();
  renderCtx.translate(-state.camera.x, -state.camera.y);

  const vx0 = Math.floor(state.camera.x / TILE_SIZE) - 1;
  const vx1 = Math.ceil((state.camera.x + renderCanvas.width) / TILE_SIZE) + 1;
  const vy0 = Math.floor(state.camera.y / TILE_SIZE) - 1;
  const vy1 = Math.ceil((state.camera.y + renderCanvas.height) / TILE_SIZE) + 1;
  if (state.map) {
    for (const t of state.map.tiles) {
      if (t.x < vx0 || t.x > vx1 || t.y < vy0 || t.y > vy1) continue;
      drawTile(renderCtx, t, t.x * TILE_SIZE, t.y * TILE_SIZE);
    }
  }
  if (state.editorMode) {
    renderCtx.strokeStyle = 'rgba(255,255,255,0.06)'; renderCtx.lineWidth = 0.5;
    for (let gx = vx0; gx <= vx1; gx++) { renderCtx.beginPath(); renderCtx.moveTo(gx * TILE_SIZE, vy0 * TILE_SIZE); renderCtx.lineTo(gx * TILE_SIZE, vy1 * TILE_SIZE); renderCtx.stroke(); }
    for (let gy = vy0; gy <= vy1; gy++) { renderCtx.beginPath(); renderCtx.moveTo(vx0 * TILE_SIZE, gy * TILE_SIZE); renderCtx.lineTo(vx1 * TILE_SIZE, gy * TILE_SIZE); renderCtx.stroke(); }
  }

  for (const rp of Object.values(state.players)) {
    drawCharacter(renderCtx, rp, rp.renderX, rp.renderY, 1 / 60, false);
  }
  if (localP) drawCharacter(renderCtx, localP, localP.x, localP.y, 1 / 60, true);

  renderCtx.shadowColor = '#f5a623'; renderCtx.shadowBlur = 10;
  renderCtx.fillStyle = 'transparent';
  if (localP) renderCtx.fillRect(localP.x, localP.y, localP.w, localP.h);
  renderCtx.shadowBlur = 0;
  renderCtx.restore();

  if (renderCtx === ctx && state.editorMode) {
    renderCtx.fillStyle = 'rgba(233,69,96,0.18)'; renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
    renderCtx.font = 'bold 14px Segoe UI, sans-serif'; renderCtx.fillStyle = '#e94560'; renderCtx.textAlign = 'left';
    renderCtx.fillText('🛠 EDITOR MODE — Click to place • Right-click to erase', 12, renderCanvas.height - 12);
  }
}

/* ══════════════════════════════════════════════════════════
   MAIN LOOP
   ══════════════════════════════════════════════════════════ */
let lastTime = 0;
let rafId = null;
function gameLoop(ts) {
  const dt = Math.min(ts - lastTime, 50);
  lastTime = ts;
  state.animTime += dt;
  state.frame++;

  const p = state.localPlayer;
  if (!p) { if (state.running) rafId = requestAnimationFrame(gameLoop); return; }

  if (!state.editorMode) {
    const left  = input.keys['ArrowLeft']  || input.keys['KeyA'] || input.mobile.jx < -0.3;
    const right = input.keys['ArrowRight'] || input.keys['KeyD'] || input.mobile.jx > 0.3;
    const jumpK = input.keys['Space']      || input.keys['ArrowUp'] || input.keys['KeyW'];
    const jumpM = input.mobile.jump;

    if (left)  { p.vx = -MOVE_SPEED; p.facing = -1; }
    if (right) { p.vx =  MOVE_SPEED; p.facing = 1; }
    if ((jumpK || jumpM) && p.onGround && !p.isDead) {
      p.vy = JUMP_FORCE; p.onGround = false;
      if (scriptEngine) scriptEngine.onGameEvent('jump');
    }

    if (input.mobile.dance && !p.isDancing) { p.isDancing = true; p.danceTimer = DANCE_DURATION; }
    if (p.isDancing) {
      p.danceTimer -= dt;
      if (p.danceTimer <= 0) { p.isDancing = false; p.danceTimer = 0; }
    }

    if (p.isDancing) p.animState = 'dance';
    else if (!p.onGround) p.animState = 'jump';
    else if (Math.abs(p.vx) > 0.3) p.animState = 'walk';
    else p.animState = 'idle';
    p.animTime = state.animTime;

    resolvePlayerPhysics(p, dt);
    if (p.chatTimer > 0) p.chatTimer -= dt;
  }

  for (const rp of Object.values(state.players)) {
    rp.interpolate(ts);
    rp.animTime = state.animTime;
    if (rp.chatTimer > 0) rp.chatTimer -= dt;
  }

  const camTargetX = p.x + p.w / 2 - canvas.width / 2;
  const camTargetY = p.y + p.h / 2 - canvas.height / 2;
  state.camera.x += (camTargetX - state.camera.x) * 0.12;
  state.camera.y += (camTargetY - state.camera.y) * 0.12;
  if (state.map) {
    state.camera.x = Math.max(0, Math.min(state.camera.x, state.map.width - canvas.width));
    state.camera.y = Math.max(0, Math.min(state.camera.y, state.map.height - canvas.height));
  }

  renderFrame(p);

  if (scriptEngine) scriptEngine.onGameEvent('tick');

  if (ts - state.lastSyncTime > SYNC_RATE_MS && state.channel) {
    state.lastSyncTime = ts;
    broadcastState(p, ts);
  }
  if (ts - state.lastPingTime > 5000 && state.channel) {
    state.lastPingTime = ts;
    state.pingStart = performance.now();
    state.channel.send({ type: 'broadcast', event: 'ping', payload: { id: state.sessionId } });
  }
  if (state.running) rafId = requestAnimationFrame(gameLoop);
}

function stopGame() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (state.channel) { state.channel.unsubscribe(); state.channel = null; }
  state.localPlayer = null;
  state.players = {};
  state.mouseDown = false;
  state.isDragging = false;
  state.lastBroadcast = {};
  state.lastSyncTime = 0;
  state.lastPingTime = 0;
  state.pingMs = 0;
  state.pingStart = 0;
  state.running = false;
  chat.messages = [];
  const box = document.getElementById('chat-messages');
  if (box) box.innerHTML = '';
}

/* ══════════════════════════════════════════════════════════
   NETWORKING
   ══════════════════════════════════════════════════════════ */
function initRealtime() {
  const ch = _supabase.channel(CHANNEL_NAME, {
    config: { broadcast: { self: false }, presence: { key: state.sessionId } }
  });

  ch.on('broadcast', { event: 'state' }, ({ payload }) => {
    if (!payload || payload.id === state.sessionId) return;
    const id = payload.id;
    const now = performance.now();
    if (!state.players[id]) {
      const rp = new RemotePlayer(payload.x, payload.y, payload.username, payload.appearance);
      rp.pushState({ ts: now, x: payload.x, y: payload.y, vx: payload.vx || 0, vy: payload.vy || 0, animState: payload.animState || 'idle', facing: payload.facing || 1, isDancing: payload.isDancing || false });
      state.players[id] = rp;
      App.chat.addSystem(`${payload.username} joined the world!`);
      updatePlayerList();
    } else {
      const rp = state.players[id];
      rp.pushState({ ts: now, x: payload.x, y: payload.y, vx: payload.vx || 0, vy: payload.vy || 0, animState: payload.animState || 'idle', facing: payload.facing || 1, isDancing: payload.isDancing || false });
      if (payload.appearance) rp.updateAppearance(payload.appearance);
    }
  });

  ch.on('broadcast', { event: 'chat' }, ({ payload }) => {
    if (!payload || payload.id === state.sessionId) return;
    App.chat.addMessage(payload.username, payload.msg, payload.id, payload.ts);
    const rp = state.players[payload.id];
    if (rp) { rp.chatMsg = payload.msg.slice(0, 32); rp.chatTimer = 4000; }
  });

  ch.on('broadcast', { event: 'ping' }, ({ payload }) => {
    if (payload?.id === state.sessionId) {
      state.pingMs = Math.round(performance.now() - state.pingStart);
      const el = document.getElementById('ping-display');
      el.textContent = `● ${state.pingMs}ms`;
      el.style.color = state.pingMs < 80 ? '#2ecc71' : state.pingMs < 200 ? '#f5a623' : '#e74c3c';
    }
  });

  ch.on('broadcast', { event: 'map_change' }, ({ payload }) => {
    if (!payload || payload.id === state.sessionId) return;
    applyMapData(payload.mapData);
    App.notify('🗺 Map changed by ' + payload.username);
  });

  ch.on('presence', { event: 'join' }, () => updatePlayerList());
  ch.on('presence', { event: 'leave' }, ({ leftPresences }) => {
    for (const p of leftPresences) {
      const id = p.presenceKey;
      if (state.players[id]) {
        App.chat.addSystem(`${state.players[id].username} left`);
        delete state.players[id];
      }
    }
    updatePlayerList();
  });

  ch.subscribe(async status => {
    if (status === 'SUBSCRIBED') {
      await ch.track({ username: state.user.username, sessionId: state.sessionId });
      broadcastState(state.localPlayer, performance.now());
    }
  });
  state.channel = ch;
}

function broadcastState(p, ts) {
  if (!state.channel || !p) return;
  const payload = {
    id: state.sessionId,
    username: state.user.username,
    x: Math.round(p.x),
    y: Math.round(p.y),
    vx: Math.round(p.vx * 100) / 100,
    vy: Math.round(p.vy * 100) / 100,
    animState: p.animState,
    facing: p.facing,
    isDancing: p.isDancing,
    appearance: p.appearance,
    ts: Math.round(ts),
  };
  // Delta compression: only send if changed
  const last = state.lastBroadcast;
  if (last.x === payload.x && last.y === payload.y && last.vx === payload.vx && last.vy === payload.vy &&
      last.animState === payload.animState && last.facing === payload.facing && last.isDancing === payload.isDancing) return;
  state.lastBroadcast = payload;
  state.channel.send({ type: 'broadcast', event: 'state', payload });
}

function updatePlayerList() {
  const list = document.getElementById('player-list');
  const self = { username: state.user?.username, appearance: state.localPlayer?.appearance };
  const all = [self, ...Object.values(state.players)];
  list.innerHTML = all.map(p => {
    const c = p?.appearance?.torsoColor || '#4a9eff';
    return `<div class="player-list-item"><div class="player-avatar-dot" style="background:${c}"></div><span>${escapeHtml(p?.username || 'Unknown')}</span></div>`;
  }).join('');
  const cnt = Object.keys(state.players).length + 1;
  document.getElementById('player-count').textContent = `${cnt} player${cnt !== 1 ? 's' : ''}`;
  document.getElementById('stat-players').textContent = String(cnt);
}

/* ══════════════════════════════════════════════════════════
   EDITOR
   ══════════════════════════════════════════════════════════ */
function editorCanvasClick(e, isRight, targetCanvas = canvas) {
  if (!state.editorMode) return;
  const rect = targetCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left + state.camera.x;
  const my = e.clientY - rect.top + state.camera.y;
  const tx = Math.floor(mx / TILE_SIZE);
  const ty = Math.floor(my / TILE_SIZE);
  const key = `${tx},${ty}`;
  if (isRight || state.editorTile === 'erase') {
    state.map.tiles = state.map.tiles.filter(t => !(t.x === tx && t.y === ty));
    delete state.tileMap[key];
  } else {
    state.map.tiles = state.map.tiles.filter(t => !(t.x === tx && t.y === ty));
    const newTile = { x: tx, y: ty, type: state.editorTile };
    state.map.tiles.push(newTile);
    state.tileMap[key] = newTile;
  }
  App.studio.updateStats();
}

let editorListenersAttached = false;
function initEditorListeners() {
  if (editorListenersAttached) return;
  editorListenersAttached = true;
  [canvas, studioCanvas].forEach(target => {
    if (!target) return;
    target.addEventListener('mousedown', e => {
      state.mouseDown = true; state.isDragging = false;
      if (e.button === 0 && state.editorMode) editorCanvasClick(e, false, target);
      if (e.button === 2 && state.editorMode) editorCanvasClick(e, true, target);
    });
    target.addEventListener('mousemove', e => {
      if (state.mouseDown && state.editorMode) { state.isDragging = true; editorCanvasClick(e, e.buttons === 2, target); }
    });
    target.addEventListener('mouseup', () => { state.mouseDown = false; });
    target.addEventListener('contextmenu', e => { e.preventDefault(); });
  });
}

/* ══════════════════════════════════════════════════════════
   MOBILE JOYSTICK
   ══════════════════════════════════════════════════════════ */
const joystick = { active: false, startX: 0, startY: 0 };
let joystickInitialized = false;
function initJoystick() {
  if (joystickInitialized) return;
  joystickInitialized = true;
  if (!isMobile()) return;
  document.getElementById('mobile-controls').classList.add('active');
  const zone = document.getElementById('joystick-zone');
  const thumb = document.getElementById('joystick-thumb');
  const MAX = 45;
  zone.addEventListener('touchstart', e => { e.preventDefault(); joystick.active = true; const t = e.touches[0]; const r = zone.getBoundingClientRect(); joystick.startX = r.left + r.width / 2; joystick.startY = r.top + r.height / 2; }, { passive: false });
  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!joystick.active) return;
    const t = e.touches[0];
    let dx = t.clientX - joystick.startX; let dy = t.clientY - joystick.startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > MAX) { dx = dx / dist * MAX; dy = dy / dist * MAX; }
    thumb.style.left = `${50 + dx / MAX * 50}%`; thumb.style.top = `${50 + dy / MAX * 50}%`;
    input.mobile.jx = dx / MAX; input.mobile.jy = dy / MAX;
  }, { passive: false });
  const reset = e => { e.preventDefault(); joystick.active = false; input.mobile.jx = 0; input.mobile.jy = 0; thumb.style.left = '50%'; thumb.style.top = '50%'; };
  zone.addEventListener('touchend', reset, { passive: false });
  zone.addEventListener('touchcancel', reset, { passive: false });
}

/* ══════════════════════════════════════════════════════════
   CHAT
   ══════════════════════════════════════════════════════════ */
const chat = {
  messages: [],
  nearBottom: true,
  addMessage(username, msg, senderId, ts = Date.now()) {
    const box = document.getElementById('chat-messages');
    const last = this.messages[this.messages.length - 1];
    const sameAuthor = last && last.senderId === senderId && (ts - last.ts) < CHAT_BATCH_MS;
    if (sameAuthor && !last.system) {
      last.lines.push(escapeHtml(msg));
      last.ts = ts;
      last.el.querySelector('.batch-lines').innerHTML = last.lines.map(m => `<div class="chat-msg">${m}</div>`).join('');
    } else {
      const el = document.createElement('div');
      el.className = 'chat-batch';
      const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `<div class="batch-header"><span>${escapeHtml(username)}</span><span class="batch-time">${time}</span></div><div class="batch-lines"><div class="chat-msg">${escapeHtml(msg)}</div></div>`;
      box.appendChild(el);
      this.messages.push({ senderId, username, lines: [escapeHtml(msg)], ts, system: false, el });
    }
    this.trimHistory(box);
    if (this.nearBottom) box.scrollTop = box.scrollHeight;
  },
  addSystem(msg) {
    const box = document.getElementById('chat-messages');
    const el = document.createElement('div');
    el.className = 'chat-msg system';
    el.textContent = msg;
    box.appendChild(el);
    this.messages.push({ senderId: 'system', lines: [msg], ts: Date.now(), system: true, el });
    this.trimHistory(box);
    if (this.nearBottom) box.scrollTop = box.scrollHeight;
  },
  trimHistory(box) {
    while (this.messages.length > MAX_CHAT_HISTORY) {
      const first = this.messages.shift();
      if (first.el && first.el.parentNode) first.el.parentNode.removeChild(first.el);
    }
  },
  send() {
    const inputEl = document.getElementById('chat-input');
    const msg = inputEl.value.trim();
    if (!msg) return;
    inputEl.value = '';
    const p = state.localPlayer;
    if (p) { p.chatMsg = msg.slice(0, 32); p.chatTimer = 4000; }
    const ts = Date.now();
    this.addMessage(state.user.username, msg, state.sessionId, ts);
    if (state.channel) {
      state.channel.send({ type: 'broadcast', event: 'chat', payload: { id: state.sessionId, username: state.user.username, msg, ts } });
    }
  },
  focus() {
    const inputEl = document.getElementById('chat-input');
    const panel = document.getElementById('side-panel');
    panel.classList.remove('collapsed');
    state.chatOpen = true;
    inputEl.focus();
  },
  blur() {
    document.getElementById('chat-input').blur();
  }
};

/* Scroll lock detection */
(function initChatScroll() {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  box.addEventListener('scroll', () => {
    const threshold = 24;
    chat.nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
  });
})();

/* ══════════════════════════════════════════════════════════
   SCRIPTING INTEGRATION
   ══════════════════════════════════════════════════════════ */
let scriptEngine = null;
function initScripting() {
  const api = {
    move: (x, y) => {
      if (state.localPlayer) { state.localPlayer.x += Number(x || 0); state.localPlayer.y += Number(y || 0); }
    },
    rotate: (deg) => { /* reserved for objects */ App.notify(`Rotated ${deg}°`); },
    color: (c) => {
      if (state.localPlayer) state.localPlayer.updateAppearance({ torsoColor: c });
    },
    size: (w, h) => { if (state.localPlayer) { state.localPlayer.w = Number(w || 28); state.localPlayer.h = Number(h || 44); } },
    create: (type, x, y) => App.notify(`Created ${type} at ${x},${y}`),
    destroy: (id) => App.notify(`Destroyed ${id}`),
    say: (msg) => { chat.addMessage('Script', msg, 'script'); },
    playSound: (name) => App.notify(`🔊 ${name}`),
    stopSound: (name) => {},
    custom: (name, args) => App.notify(`Custom: ${name}(${args.join(',')})`),
    image: {
      load: (url) => { if (state.localPlayer) state.localPlayer.updateAppearance({ shirtUrl: url }); },
      filter: (name) => App.notify(`Image filter: ${name}`),
    },
    game: {
      getPlayer: () => state.localPlayer,
      getMap: () => state.map,
    },
    ui: {
      createPanel: (html) => {
        const el = document.createElement('div');
        el.className = 'toast'; el.innerHTML = html;
        document.getElementById('notification-area').appendChild(el);
        setTimeout(() => el.remove(), 5000);
      },
    },
    onLog: (msg) => App.studio.logConsole(msg, 'info'),
    onError: (msg) => App.studio.logConsole(msg, 'error'),
  };
  scriptEngine = new ScriptEngine(api);
}

/* ══════════════════════════════════════════════════════════
   APP CONTROLLER
   ══════════════════════════════════════════════════════════ */
const App = {
  auth: {
    showTab(tab) {
      document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
      document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
      document.getElementById('tab-login').classList.toggle('active', tab === 'login');
      document.getElementById('tab-register').classList.toggle('active', tab === 'register');
    },
    async login() {
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      const btn = document.getElementById('login-btn');
      errEl.classList.add('hidden');
      if (!username || !password) { errEl.textContent = 'Please fill in all fields.'; errEl.classList.remove('hidden'); return; }
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const hash = await sha256(password);
        const { data, error } = await _supabase.from('users').select('id, username, appearance').eq('username', username).eq('password_hash', hash).single();
        if (error || !data) throw new Error('Invalid username or password.');
        state.user = { id: data.id, username: data.username, appearance: data.appearance || {} };
        App.showHome();
      } catch (err) {
        errEl.textContent = err.message || 'Login failed.'; errEl.classList.remove('hidden');
      } finally { btn.disabled = false; btn.textContent = 'Sign In'; }
    },
    async register() {
      const username = document.getElementById('reg-username').value.trim();
      const password = document.getElementById('reg-password').value;
      const confirm = document.getElementById('reg-confirm').value;
      const errEl = document.getElementById('reg-error');
      const sucEl = document.getElementById('reg-success');
      const btn = document.getElementById('register-btn');
      errEl.classList.add('hidden'); sucEl.classList.add('hidden');
      if (!username || !password || !confirm) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('hidden'); return; }
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { errEl.textContent = 'Username: 3–24 characters, letters/numbers/underscore only.'; errEl.classList.remove('hidden'); return; }
      if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.classList.remove('hidden'); return; }
      if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.classList.remove('hidden'); return; }
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        const hash = await sha256(password);
        const { error } = await _supabase.from('users').insert({ username, password_hash: hash, appearance: {} });
        if (error) {
          if (error.message?.includes('unique') || error.code === '23505') throw new Error('Username already taken.');
          throw new Error(error.message || 'Registration failed.');
        }
        sucEl.textContent = '✓ Account created! You can now sign in.'; sucEl.classList.remove('hidden');
        setTimeout(() => App.auth.showTab('login'), 2000);
      } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
      finally { btn.disabled = false; btn.textContent = 'Create Account'; }
    },
    logout() {
      stopGame();
      state.user = null;
      document.getElementById('screen-game').classList.add('hidden');
      document.getElementById('screen-home').classList.add('hidden');
      document.getElementById('screen-auth').classList.remove('hidden');
      App.editor.exitStudio();
    },
  },

  showHome() {
    document.getElementById('screen-auth').classList.add('hidden');
    document.getElementById('screen-game').classList.add('hidden');
    document.getElementById('screen-home').classList.remove('hidden');
    document.getElementById('home-username').textContent = state.user.username;
    App.home.refreshMaps();
  },

  home: {
    maps: [],
    tab: 'all',
    query: '',
    async refreshMaps() {
      const grid = document.getElementById('map-grid');
      grid.innerHTML = '<div class="empty-state">Loading worlds…</div>';
      const { data, error } = await _supabase.from('games').select('*').order('created_at', { ascending: false }).limit(100);
      if (error || !data) { grid.innerHTML = '<div class="empty-state">Failed to load worlds.</div>'; return; }
      this.maps = data;
      this.renderMaps();
    },
    renderMaps() {
      const grid = document.getElementById('map-grid');
      const q = this.query.toLowerCase();
      const filtered = this.maps.filter(m => {
        const matches = (m.title || '').toLowerCase().includes(q) || (m.creator || '').toLowerCase().includes(q);
        return this.tab === 'mine' ? (matches && m.creator === state.user.username) : matches;
      });
      if (!filtered.length) { grid.innerHTML = '<div class="empty-state">No worlds found.</div>'; return; }
      grid.innerHTML = filtered.map(m => `
        <div class="map-card">
          <div>
            <h4>${escapeHtml(m.title || 'Untitled')}</h4>
            <div class="meta">by ${escapeHtml(m.creator)} • ${new Date(m.created_at).toLocaleDateString()}</div>
          </div>
          <div class="map-card-actions">
            <button class="btn btn-primary btn-sm" onclick="App.home.loadMap('${m.id}')">▶ Play</button>
          </div>
        </div>`).join('');
    },
    setTab(tab, btn) {
      App.home.tab = tab;
      document.querySelectorAll('.home-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      App.home.renderMaps();
    },
    searchMaps() {
      this.query = document.getElementById('home-search').value;
      this.renderMaps();
    },
    async loadMap(id) {
      const { data, error } = await _supabase.from('games').select('*').eq('id', id).single();
      if (error || !data) { App.notify('Failed to load world.'); return; }
      applyMapData(data.data);
      App.startGame(data.title || data.data.name || 'Unnamed');
    },
    createNewMap() {
      applyMapData(buildBaseplate());
      App.startGame('New Baseplate');
    },
    returnToBrowser() {
      stopGame();
      App.editor.exitStudio();
      App.showHome();
    },
  },

  startGame(mapName) {
    stopGame();
    state.running = true;
    document.getElementById('screen-home').classList.add('hidden');
    document.getElementById('screen-game').classList.remove('hidden');
    document.getElementById('topbar-username').textContent = state.user.username;
    document.getElementById('studio-map-title').value = mapName || state.map.name || 'Untitled';

    resizeCanvas();
    rebuildTileMap();

    const sp = getSpawnPoint();
    state.localPlayer = new Player(sp.x, sp.y, state.user.username, state.user.appearance);
    state.camera = { x: sp.x - canvas.width / 2, y: sp.y - canvas.height / 2 };
    state.lastBroadcast = {};

    initRealtime();
    updatePlayerList();
    App.studio.updateStats();

    rafId = requestAnimationFrame(ts => { lastTime = ts; rafId = requestAnimationFrame(gameLoop); });
    App.notify(`Welcome, ${state.user.username}! 🎮`);
  },

  dance() {
    const p = state.localPlayer;
    if (!p || p.isDead) return;
    p.isDancing = true; p.danceTimer = DANCE_DURATION;
    App.notify('🕺 Feeling Lucky!');
  },

  chat,
  toggleChat() {
    const panel = document.getElementById('side-panel');
    panel.classList.toggle('collapsed');
    state.chatOpen = !panel.classList.contains('collapsed');
  },

  notify(msg) {
    const area = document.getElementById('notification-area');
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    area.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  },

  editor: {
    toggle() {
      state.studioMode = !state.studioMode;
      state.editorMode = state.studioMode;
      document.getElementById('creator-studio').classList.toggle('hidden', !state.studioMode);
      document.getElementById('mode-badge').textContent = state.studioMode ? 'EDITOR' : 'PLAY';
      document.getElementById('mode-badge').style.background = state.studioMode ? '#e74c3c' : 'var(--accent)';
      resizeCanvas();
      App.studio.updateStats();
      App.notify(state.studioMode ? '🛠 Creator Studio ON' : '🎮 Play mode ON');
    },
    exitStudio() {
      state.studioMode = false; state.editorMode = false;
      document.getElementById('creator-studio').classList.add('hidden');
      document.getElementById('mode-badge').textContent = 'PLAY';
      document.getElementById('mode-badge').style.background = 'var(--accent)';
    },
    selectTile(type, btn) {
      state.editorTile = type;
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('selected'));
      if (btn) btn.classList.add('selected');
    },
    clearMap() {
      if (!confirm('Clear all tiles? This cannot be undone.')) return;
      state.map.tiles = [];
      rebuildTileMap();
      App.notify('🗑 Map cleared');
      App.studio.updateStats();
    },
  },

  mobile: {
    jumpStart()  { input.mobile.jump = true; },
    jumpEnd()    { input.mobile.jump = false; },
    danceStart() { input.mobile.dance = true; App.dance(); },
    danceEnd()   { input.mobile.dance = false; },
  },

  modals: {
    open(id) { document.getElementById(`modal-${id}`).classList.remove('hidden'); },
    close(id) { document.getElementById(`modal-${id}`).classList.add('hidden'); },
    openCustomizer() {
      const app = state.localPlayer?.appearance || {};
      document.getElementById('color-head').value   = app.headColor  || '#f5c842';
      document.getElementById('color-torso').value  = app.torsoColor || '#3a8bff';
      document.getElementById('color-legs').value   = app.legColor   || '#2c3e50';
      document.getElementById('color-arms').value   = app.armColor   || '#f5c842';
      document.getElementById('shirt-url').value    = app.shirtUrl   || '';
      document.getElementById('hat-url').value      = app.hatUrl     || '';
      document.getElementById('color-head-hex').value  = app.headColor  || '#f5c842';
      document.getElementById('color-torso-hex').value = app.torsoColor || '#3a8bff';
      document.getElementById('color-legs-hex').value  = app.legColor   || '#2c3e50';
      document.getElementById('color-arms-hex').value  = app.armColor   || '#f5c842';
      App.modals.open('customizer');
      App.modals.updatePreview();
    },
    syncColor(part) {
      const hex = document.getElementById(`color-${part}-hex`).value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) { document.getElementById(`color-${part}`).value = hex; App.modals.updatePreview(); }
    },
    updatePreview() {
      const previewApp = {
        headColor: document.getElementById('color-head').value,
        torsoColor: document.getElementById('color-torso').value,
        legColor: document.getElementById('color-legs').value,
        armColor: document.getElementById('color-arms').value,
        shirtUrl: document.getElementById('shirt-url').value,
        hatUrl: document.getElementById('hat-url').value,
      };
      document.getElementById('color-head-hex').value = previewApp.headColor;
      document.getElementById('color-torso-hex').value = previewApp.torsoColor;
      document.getElementById('color-legs-hex').value = previewApp.legColor;
      document.getElementById('color-arms-hex').value = previewApp.armColor;
      const pv = document.getElementById('customizer-canvas');
      const pvCtx = pv.getContext('2d');
      pvCtx.clearRect(0, 0, pv.width, pv.height);
      pvCtx.fillStyle = '#1a1a2e'; pvCtx.fillRect(0, 0, pv.width, pv.height);
      const dummy = { appearance: previewApp, animState: 'idle', animTime: state.animTime, isDancing: false, chatMsg: '', chatTimer: 0, _shirtImg: null, _hatImg: null, facing: 1, isDead: false, w: 28, h: 44, username: state.user?.username || 'You' };
      drawCharacter(pvCtx, dummy, pv.width / 2 - 14, pv.height / 2 - 22, 1 / 60, true);
    },
    saveAppearance() {
      const app = {
        headColor: document.getElementById('color-head').value,
        torsoColor: document.getElementById('color-torso').value,
        legColor: document.getElementById('color-legs').value,
        armColor: document.getElementById('color-arms').value,
        shirtUrl: document.getElementById('shirt-url').value,
        hatUrl: document.getElementById('hat-url').value,
      };
      if (state.localPlayer) state.localPlayer.updateAppearance(app);
      _supabase.from('users').update({ appearance: app }).eq('id', state.user.id).then(({ error }) => { if (error) console.error('Save appearance error:', error); });
      App.modals.close('customizer');
      App.notify('🎨 Appearance saved!');
      updatePlayerList();
    },
    openSaveMap() {
      if (!state.editorMode) { App.notify('Enable editor mode first!'); return; }
      document.getElementById('map-title').value = document.getElementById('studio-map-title').value || '';
      document.getElementById('save-map-error').classList.add('hidden');
      document.getElementById('save-map-success').classList.add('hidden');
      App.modals.open('savemap');
    },
  },

  maps: {
    async saveCurrentMap() {
      const title = document.getElementById('map-title').value.trim() || document.getElementById('studio-map-title').value.trim();
      const errEl = document.getElementById('save-map-error');
      const sucEl = document.getElementById('save-map-success');
      errEl.classList.add('hidden'); sucEl.classList.add('hidden');
      if (!title) { errEl.textContent = 'Please enter a world title.'; errEl.classList.remove('hidden'); return; }
      const mapData = {
        tiles: state.map.tiles, width: state.map.width, height: state.map.height, name: title
      };
      const { error } = await _supabase.from('games').insert({ title, creator: state.user.username, data: mapData });
      if (error) { errEl.textContent = 'Save failed: ' + (error.message || 'unknown error'); errEl.classList.remove('hidden'); return; }
      sucEl.textContent = '✓ World published successfully!'; sucEl.classList.remove('hidden');
      App.notify('✅ World published: ' + title);
      if (state.channel) state.channel.send({ type: 'broadcast', event: 'map_change', payload: { id: state.sessionId, username: state.user.username, mapData } });
      setTimeout(() => App.modals.close('savemap'), 1800);
    },
  },

  studio: {
    leftTab: 'tools',
    rightTab: 'inspector',
    scriptTab: 'dihlang',
    switchLeftTab(tab, btn) { App.studio.leftTab = tab; document.querySelectorAll('#studio-left .panel-tab').forEach(b => b.classList.remove('active')); btn.classList.add('active'); document.getElementById('left-tab-tools').classList.toggle('hidden', tab !== 'tools'); document.getElementById('left-tab-assets').classList.toggle('hidden', tab !== 'assets'); },
    switchRightTab(tab, btn) { App.studio.rightTab = tab; document.querySelectorAll('#studio-right .panel-tab').forEach(b => b.classList.remove('active')); btn.classList.add('active'); document.getElementById('right-tab-inspector').classList.toggle('hidden', tab !== 'inspector'); document.getElementById('right-tab-scripts').classList.toggle('hidden', tab !== 'scripts'); },
    switchScriptTab(tab, btn) { App.studio.scriptTab = tab; document.querySelectorAll('.script-tab').forEach(b => b.classList.remove('active')); btn.classList.add('active'); document.getElementById('script-editor').value = scriptEngine.currentSource[tab] || ''; },
    updateStats() {
      if (!state.map) return;
      document.getElementById('stat-tiles').textContent = String(state.map.tiles.length);
      document.getElementById('stat-spawns').textContent = String(state.map.tiles.filter(t => t.type === 'spawn').length);
      updatePlayerList();
    },
    spawnAsset(type) { App.notify(`Spawned ${type} (placeholder)`); },
    runScript() {
      if (!scriptEngine) initScripting();
      const source = document.getElementById('script-editor').value;
      scriptEngine.run(App.studio.scriptTab, source).catch(e => App.studio.logConsole(String(e), 'error'));
    },
    stopScript() { if (scriptEngine) scriptEngine.stop(); App.studio.logConsole('Script stopped.', 'info'); },
    saveScriptSource() {
      if (!scriptEngine) return;
      scriptEngine.currentSource[App.studio.scriptTab] = document.getElementById('script-editor').value;
    },
    logConsole(msg, level = 'info') {
      const box = document.getElementById('script-console');
      const el = document.createElement('div');
      el.className = `log-${level}`; el.textContent = `> ${msg}`;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    },
  },
};

// Bind chat send on Enter
document.addEventListener('DOMContentLoaded', () => {
  const chatInput = document.getElementById('chat-input');
  if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') chat.send(); });
  initScripting();
  initEditorListeners();
  initJoystick();
});

/* ══════════════════════════════════════════════════════════
   BOOTSTRAP
   ══════════════════════════════════════════════════════════ */
(async function init() {
  await new Promise(r => setTimeout(r, 800));
  try { await _supabase.from('users').select('id').limit(1); } catch (e) { console.warn('Supabase connection check:', e); }
  document.getElementById('loading-overlay').style.opacity = '0';
  document.getElementById('loading-overlay').style.transition = 'opacity .4s';
  setTimeout(() => {
    document.getElementById('loading-overlay').style.display = 'none';
    document.getElementById('screen-auth').classList.remove('hidden');
  }, 400);
})();
