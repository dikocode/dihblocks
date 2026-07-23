/**
 * DIHBLOCKS — app.js
 * Production 2D real-time multiplayer browser game engine.
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
let TILE_SIZE    = 40;
let GRAVITY      = 0.55;
let JUMP_FORCE   = -13.5;
let MOVE_SPEED   = 4.5;
let MAX_FALL_SPD = 18;
let LERP_FACTOR  = 0.18;
let SYNC_RATE_MS = 40;
let CHANNEL_NAME = 'dihblocks-world-v1';
let DANCE_DURATION = 3500;
let INTERP_DELAY_MS = 100;
let CHAT_BATCH_MS = 60000;
let MAX_CHAT_HISTORY = 200;
let GROUND_FRICTION = 0.78;

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
    this.buffer = [];
    this.renderX = x; this.renderY = y;
    this.lastState = null;
  }
  pushState(snapshot) {
    this.buffer.push(snapshot);
    if (this.buffer.length > 12) this.buffer.shift();
  }
  interpolate(now) {
    const renderTs = now - INTERP_DELAY_MS;
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
  if (p.onGround) p.vx *= onIce ? 0.98 : GROUND_FRICTION;

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
