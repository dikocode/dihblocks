/**
 * DIHBLOCKS — app.js
 * Production-ready 2D Real-Time Multiplayer Browser Game Engine
 * ─────────────────────────────────────────────────────────────
 * Stack: Supabase (custom auth + realtime), HTML5 Canvas, rAF physics loop
 *
 * DB Schema required in Supabase:
 *
 *   CREATE TABLE public.users (
 *     id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *     username     TEXT UNIQUE NOT NULL,
 *     password_hash TEXT NOT NULL,
 *     appearance   JSONB DEFAULT '{}'::jsonb
 *   );
 *   -- RLS: enable, add policy: "allow all for anon" (or use service role)
 *   ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "users_all" ON public.users FOR ALL TO anon USING (true) WITH CHECK (true);
 *
 *   CREATE TABLE public.games (
 *     id      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *     title   TEXT NOT NULL,
 *     creator TEXT NOT NULL,
 *     data    JSONB NOT NULL,
 *     created_at TIMESTAMPTZ DEFAULT now()
 *   );
 *   ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "games_all" ON public.games FOR ALL TO anon USING (true) WITH CHECK (true);
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   SUPABASE INIT
══════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://blgfhukweibzkasamicm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsZ2ZodWt3ZWliemthc2FtaWNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MjE4NjksImV4cCI6MjEwMDM5Nzg2OX0.i0JQYIC4oahxMNVcJkMYNJVCRu_dkSsqIRpsJKd7Ycc';
// Note: Replace SUPABASE_KEY above with your actual anon/public key from Supabase dashboard
// The key above uses the publishable key format provided. If auth fails, update with eyJ... JWT from project settings.
const _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

/* ══════════════════════════════════════════════════════════
   CONSTANTS & CONFIG
══════════════════════════════════════════════════════════ */
const TILE_SIZE    = 40;
// Gameplay values are expressed per second so movement feels consistent at
// different display refresh rates. A jump of about 2–3 tiles should feel
// responsive rather than floaty.
const BASE_FRAME_RATE = 60;
const GRAVITY      = 2200; // px/s² — strong enough for a quick landing
const JUMP_FORCE   = -650; // px/s — about 96 px / 2.4 tiles of jump height
const MOVE_SPEED   = 4.5 * BASE_FRAME_RATE;
const MAX_FALL_SPD = 950;  // px/s — prevents an excessively slow terminal fall
const WALK_CYCLE_SPEED = 0.006; // animation radians per millisecond
const CAMERA_LERP_RATE = 8;
const REMOTE_LERP_RATE = 12;
const SYNC_RATE_MS = 50;   // 20Hz position broadcast
const CHANNEL_NAME = 'dihblocks-world-v1';
const DANCE_DURATION = 3500; // ms

/* ══════════════════════════════════════════════════════════
   SHA-256 HELPER (password hashing)
══════════════════════════════════════════════════════════ */
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ══════════════════════════════════════════════════════════
   DEFAULT MAP (Parkour Base Game)
══════════════════════════════════════════════════════════ */
function buildDefaultMap() {
  const tiles = [];
  const W = 60, H = 30;
  // Floor
  for (let x = 0; x < W; x++) tiles.push({ x, y: H-1, type: 'ground' });
  // Platforms — parkour course
  const platforms = [
    // Starter area
    [2,26,8,'platform'],[12,24,5,'platform'],[18,22,5,'platform'],
    [24,20,4,'platform'],[30,18,4,'platform'],[36,16,4,'platform'],
    [42,14,5,'platform'],[48,12,4,'platform'],
    // Hazard sections
    [14,26,1,'hazard'],[15,26,1,'hazard'],
    [20,22,1,'hazard'],
    [26,20,1,'hazard'],[27,20,1,'hazard'],
    // Bounce pad
    [36,22,1,'bounce'],
    // Ice section
    [50,10,6,'ice'],
    // Lava pit
    [20,28,4,'lava'],[21,28,1,'lava'],[22,28,1,'lava'],[23,28,1,'lava'],
    // Upper platforms
    [54,8,5,'platform'],[58,6,4,'platform'],
    // Goal area
    [60,4,6,'platform'],
    // Side walls
    [0,24,1,'platform'],[0,23,1,'platform'],[0,22,1,'platform'],
  ];
  for (const [sx, sy, len, type] of platforms) {
    for (let i = 0; i < len; i++) tiles.push({ x: sx+i, y: sy, type });
  }
  // Spawn
  tiles.push({ x: 3, y: 25, type: 'spawn' });
  return { tiles, width: W * TILE_SIZE, height: H * TILE_SIZE, name: 'Parkour Base' };
}

/* ══════════════════════════════════════════════════════════
   TILE CONFIG
══════════════════════════════════════════════════════════ */
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
   GAME STATE
══════════════════════════════════════════════════════════ */
const state = {
  user:      null,   // { id, username, appearance }
  map:       buildDefaultMap(),
  tileMap:   {},     // "x,y" → tile
  players:   {},     // sessionId → RemotePlayer
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
  editorZoom:  1,
  isPanning:   false,
  panLastX:    0,
  panLastY:    0,
  editorTouch: {
    active: false,
    distance: 0,
    centerX: 0,
    centerY: 0,
  },
};

/* ── Build tile lookup ──────────────────────────────────── */
function rebuildTileMap() {
  state.tileMap = {};
  for (const t of state.map.tiles) state.tileMap[`${t.x},${t.y}`] = t;
}

/* ══════════════════════════════════════════════════════════
   PLAYER CLASS
══════════════════════════════════════════════════════════ */
class Player {
  constructor(x, y, username, appearance = {}) {
    this.x  = x; this.y  = y;
    this.vx = 0; this.vy = 0;
    this.w  = 28; this.h = 44;
    this.onGround   = false;
    this.username   = username;
    this.appearance = {
      headColor:  '#f5c842',
      torsoColor: '#3a8bff',
      legColor:   '#2c3e50',
      armColor:   '#f5c842',
      shirtUrl:   '',
      hatUrl:     '',
      ...appearance,
    };
    this.animState  = 'idle';   // idle | walk | jump | dance
    this.animFrame  = 0;
    this.facing     = 1;       // 1=right, -1=left
    this.chatMsg    = '';
    this.chatTimer  = 0;
    this.danceTimer = 0;
    this.isDancing  = false;
    this.deathTimer = 0;
    this.isDead     = false;
    // preloaded images
    this._shirtImg  = null;
    this._hatImg    = null;
    this._loadImages();
  }
  _loadImages() {
    if (this.appearance.shirtUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = this.appearance.shirtUrl;
      img.onload = () => { this._shirtImg = img; };
    }
    if (this.appearance.hatUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = this.appearance.hatUrl;
      img.onload = () => { this._hatImg = img; };
    }
  }
  updateAppearance(app) {
    this.appearance = { ...this.appearance, ...app };
    this._shirtImg = null; this._hatImg = null;
    this._loadImages();
  }
}

/* ══════════════════════════════════════════════════════════
   INPUT SYSTEM
══════════════════════════════════════════════════════════ */
const input = {
  keys: {},
  mobile: { jx: 0, jy: 0, jump: false, dance: false },
};

function isTypingTarget(element = document.activeElement) {
  return Boolean(element && (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.isContentEditable
  ));
}

function isGameControlKey(code) {
  return [
    'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE'
  ].includes(code);
}

window.addEventListener('keydown', e => {
  // Never let gameplay or editor shortcuts interfere with text entry.
  if (isTypingTarget()) return;

  input.keys[e.code] = true;

  const gameIsActive = Boolean(state.localPlayer && !state.editorMode);
  const editorUsesSpace = state.editorMode && e.code === 'Space';
  if ((gameIsActive && isGameControlKey(e.code)) || editorUsesSpace) {
    e.preventDefault();
  }
  if (e.code === 'KeyE' && gameIsActive && !e.repeat) App.dance();
});
window.addEventListener('keyup', e => {
  // Clear the key even if focus moved into chat while it was held.
  input.keys[e.code] = false;
});
window.addEventListener('blur', () => { input.keys = {}; });

function isMobile() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

/* ══════════════════════════════════════════════════════════
   CANVAS & RENDERER
══════════════════════════════════════════════════════════ */
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}
window.addEventListener('resize', resizeCanvas);

/* ── Character Renderer ─────────────────────────────────── */
function drawCharacter(ctx, player, screenX, screenY, dt, isLocal) {
  const t  = player.animTime || state.animTime;
  const a  = player.appearance;
  const f  = player.facing;
  const W  = player.w;
  const H  = player.h;

  // Sizing
  const HEAD_R  = 10;
  const TORSO_H = 16;
  const LEG_H   = 12;
  const ARM_H   = 12;
  const ARM_W   = 6;
  const LEG_W   = 8;

  // cx/cy = center top of character
  const cx = screenX + W/2;
  const cy = screenY;

  ctx.save();

  // Death flash
  if (player.isDead) {
    ctx.globalAlpha = 0.4 + Math.sin(state.animTime * 0.02) * 0.3;
  }

  // Dance bobbing
  let bobY = 0;
  if (player.isDancing) {
    bobY = Math.sin(t * 0.008) * 5;
  }

  // ── Compute limb angles based on anim state ──
  let walkPhase = 0;
  if (player.animState === 'walk') walkPhase = Math.sin(t * WALK_CYCLE_SPEED) * 0.6;
  if (player.isDancing) {
    walkPhase = Math.sin(t * 0.006) * 1.0;
    const twist = Math.sin(t * 0.005) * 0.4;
    // arms up/out in dance
    drawArm(ctx, cx, cy + HEAD_R*2 + TORSO_H*0.2 + bobY,  f, -1, Math.PI/3 + Math.sin(t*0.007)*0.8, a.armColor, ARM_W, ARM_H);
    drawArm(ctx, cx, cy + HEAD_R*2 + TORSO_H*0.2 + bobY,  f,  1, Math.PI/3 + Math.cos(t*0.007)*0.8, a.armColor, ARM_W, ARM_H);
  } else if (player.animState === 'jump') {
    // Airborne pose: arms up/out and legs tucked so jumping is visibly
    // different from both the idle and walking poses.
    const jumpSway = Math.sin(t * 0.004) * 0.08;
    drawArm(ctx, cx, cy + HEAD_R*2 + TORSO_H*0.2 + bobY, f, -1,
      -0.75 + jumpSway, a.armColor, ARM_W, ARM_H);
    drawArm(ctx, cx, cy + HEAD_R*2 + TORSO_H*0.2 + bobY, f,  1,
       0.75 - jumpSway, a.armColor, ARM_W, ARM_H);
  } else {
    // Normal arms
    drawArm(ctx, cx, cy + HEAD_R*2 + TORSO_H*0.2 + bobY,  f, -1, -walkPhase * 0.7, a.armColor, ARM_W, ARM_H);
    drawArm(ctx, cx, cy + HEAD_R*2 + TORSO_H*0.2 + bobY,  f,  1,  walkPhase * 0.7, a.armColor, ARM_W, ARM_H);
  }

  // ── Legs ──
  const legY = cy + HEAD_R*2 + TORSO_H + bobY;
  if (player.animState === 'jump') {
    const jumpLegSway = Math.sin(t * 0.004) * 0.08;
    drawLeg(ctx, cx, legY, -1, -0.55 - jumpLegSway, a.legColor, LEG_W, LEG_H);
    drawLeg(ctx, cx, legY,  1,  0.55 + jumpLegSway, a.legColor, LEG_W, LEG_H);
  } else if (player.isDancing) {
    drawLeg(ctx, cx, legY, -1, Math.sin(t*0.009) * 0.8, a.legColor, LEG_W, LEG_H);
    drawLeg(ctx, cx, legY,  1, Math.sin(t*0.009 + Math.PI) * 0.8, a.legColor, LEG_W, LEG_H);
  } else {
    drawLeg(ctx, cx, legY, -1,  walkPhase, a.legColor, LEG_W, LEG_H);
    drawLeg(ctx, cx, legY,  1, -walkPhase, a.legColor, LEG_W, LEG_H);
  }

  // ── Torso ──
  const torsoY = cy + HEAD_R*2 + bobY;
  ctx.fillStyle = a.torsoColor;
  const torsoX = cx - W/2 + 4;
  const torsoW = W - 8;
  ctx.beginPath();
  ctx.roundRect(torsoX, torsoY, torsoW, TORSO_H, 3);
  ctx.fill();
  // Shirt image overlay
  if (player._shirtImg) {
    ctx.drawImage(player._shirtImg, torsoX, torsoY, torsoW, TORSO_H);
  }

  // ── Head ──
  const headCY = cy + HEAD_R + bobY;
  ctx.fillStyle = a.headColor;
  ctx.beginPath();
  ctx.arc(cx, headCY, HEAD_R, 0, Math.PI*2);
  ctx.fill();
  // Eyes
  const eyeOffX = f * 3;
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(cx + eyeOffX - 2, headCY - 1, 2, 0, Math.PI*2);
  ctx.arc(cx + eyeOffX + 3, headCY - 1, 2, 0, Math.PI*2);
  ctx.fill();
  // Smile when dancing
  if (player.isDancing) {
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx + eyeOffX, headCY + 3, 4, 0, Math.PI);
    ctx.stroke();
  }

  // ── Hat ──
  if (player._hatImg) {
    ctx.drawImage(player._hatImg, cx - 14, cy - 12 + bobY, 28, 18);
  } else {
    // Default hat shape (small block on head)
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(cx - 10, cy + bobY - 2, 20, 4);
  }

  // ── Chat bubble ──
  if (player.chatMsg && player.chatTimer > 0) {
    drawSpeechBubble(ctx, cx, cy + bobY - 16, player.chatMsg);
  }

  // ── Username ──
  ctx.font = 'bold 9px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = isLocal ? '#f5a623' : '#eaeaea';
  ctx.shadowColor = '#000';
  ctx.shadowBlur  = 4;
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
  ctx.beginPath();
  ctx.roundRect(-aw/2, 0, aw, ah, 3);
  ctx.fill();
  ctx.restore();
}

function drawLeg(ctx, cx, cy, side, angle, color, lw, lh) {
  ctx.save();
  const ox = cx + side * 8;
  ctx.translate(ox, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-lw/2, 0, lw, lh, 3);
  ctx.fill();
  ctx.restore();
}

function drawSpeechBubble(ctx, x, y, text) {
  const pad = 6;
  ctx.font = 'bold 10px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  const tw = ctx.measureText(text).width;
  const bw = tw + pad*2;
  const bh = 18;
  const bx = x - bw/2;
  const by = y - bh - 8;

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 6);
  ctx.fill();
  ctx.stroke();
  // Tail
  ctx.beginPath();
  ctx.moveTo(x - 5, by + bh);
  ctx.lineTo(x,     by + bh + 5);
  ctx.lineTo(x + 5, by + bh);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  // Text
  ctx.fillStyle = '#222';
  ctx.fillText(text, x, by + bh - 5);
}

/* ── Tile Renderer ──────────────────────────────────────── */
function drawTile(ctx, tile, sx, sy) {
  const cfg = TILE_CONFIG[tile.type] || TILE_CONFIG.platform;
  const S   = TILE_SIZE;

  if (tile.type === 'hazard') {
    // Spikes
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(sx, sy + S*0.5, S, S*0.5);
    ctx.fillStyle = '#e74c3c';
    const count = 3;
    const sw = S / count;
    for (let i = 0; i < count; i++) {
      ctx.beginPath();
      ctx.moveTo(sx + i*sw,       sy + S*0.5);
      ctx.lineTo(sx + i*sw + sw/2, sy);
      ctx.lineTo(sx + i*sw + sw,  sy + S*0.5);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }

  if (tile.type === 'spawn') {
    // Spawn marker
    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth = 2;
    ctx.setLineDash([4,4]);
    ctx.strokeRect(sx+2, sy+2, S-4, S-4);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(245,166,35,0.15)';
    ctx.fillRect(sx+2, sy+2, S-4, S-4);
    ctx.fillStyle = '#f5a623';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⚑', sx + S/2, sy + S/2 + 6);
    return;
  }

  if (tile.type === 'lava') {
    const t = state.animTime * 0.003;
    const g = ctx.createLinearGradient(sx, sy, sx, sy+S);
    g.addColorStop(0, `hsl(${20+Math.sin(t)*10}, 100%, 55%)`);
    g.addColorStop(1, `hsl(${5+Math.cos(t)*5},  100%, 35%)`);
    ctx.fillStyle = g;
    ctx.fillRect(sx, sy, S, S);
    // Wave effect
    ctx.fillStyle = 'rgba(255,180,0,0.5)';
    ctx.beginPath();
    for (let i = 0; i <= S; i += 4) {
      const wY = Math.sin((i + state.animTime * 0.005) * 0.3) * 3;
      if (i === 0) ctx.moveTo(sx, sy + wY + 4);
      else ctx.lineTo(sx+i, sy + wY + 4);
    }
    ctx.lineTo(sx+S, sy);
    ctx.lineTo(sx, sy);
    ctx.closePath();
    ctx.fill();
    return;
  }

  if (tile.type === 'bounce') {
    ctx.fillStyle = '#9b59b6';
    ctx.fillRect(sx, sy, S, S);
    ctx.fillStyle = '#c678dd';
     const bh = Math.abs(Math.sin(state.animTime * 0.005)) * 6;
    ctx.fillRect(sx+4, sy+S-8-bh, S-8, 8+bh);
    return;
  }

  if (tile.type === 'ice') {
    ctx.fillStyle = '#cdf0fa';
    ctx.fillRect(sx, sy, S, S);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(sx+2, sy+2, S-4, 5);
    ctx.fillRect(sx+2, sy+2, 5, S-4);
    return;
  }

  // ground / platform
  ctx.fillStyle = cfg.color;
  ctx.fillRect(sx, sy, S, S);
  // top highlight
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(sx, sy, S, 4);
  // bottom shadow
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(sx, sy+S-4, S, 4);
  // Grid lines
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(sx, sy, S, S);
}

/* ══════════════════════════════════════════════════════════
   PHYSICS ENGINE
══════════════════════════════════════════════════════════ */
function getSpawnPoint() {
  const spawns = state.map.tiles.filter(t => t.type === 'spawn');
  if (spawns.length > 0) {
    const s = spawns[Math.floor(Math.random() * spawns.length)];
    return { x: s.x * TILE_SIZE, y: (s.y - 1) * TILE_SIZE };
  }
  return { x: 3 * TILE_SIZE, y: 24 * TILE_SIZE };
}

function tileAt(tx, ty) {
  return state.tileMap[`${tx},${ty}`] || null;
}

function solidAt(tx, ty) {
  const t = tileAt(tx, ty);
  if (!t) return false;
  return TILE_CONFIG[t.type]?.solid || false;
}

function resolvePlayerPhysics(p, dt) {
  if (p.isDead) {
    p.deathTimer -= dt * 1000;
    if (p.deathTimer <= 0) respawn(p);
    return;
  }

  // Apply gravity
  p.vy += GRAVITY * dt;
  if (p.vy > MAX_FALL_SPD) p.vy = MAX_FALL_SPD;

  // Move X
  p.x += p.vx * dt;
  resolveAxisX(p);

  // Move Y
  p.y += p.vy * dt;
  resolveAxisY(p);

  // Ice friction (reduce vx slowly on ice)
  const btx0 = Math.floor(p.x / TILE_SIZE);
  const btx1 = Math.floor((p.x + p.w - 1) / TILE_SIZE);
  const bty  = Math.floor((p.y + p.h) / TILE_SIZE);
  const leftBelow = tileAt(btx0, bty);
  const rightBelow = tileAt(btx1, bty);
  const onIce = (leftBelow?.type === 'ice') || (rightBelow?.type === 'ice');
  if (p.onGround) {
    const friction = onIce ? 0.98 : 0.78;
    p.vx *= Math.pow(friction, dt * BASE_FRAME_RATE);
  }

  // Hazard / lava check
  checkHazards(p);

  // World bounds
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
    if (solidAt(tx0, ty)) {
      p.x = (tx0 + 1) * TILE_SIZE;
      p.vx = 0;
    }
    if (solidAt(tx1, ty)) {
      p.x = tx1 * TILE_SIZE - p.w;
      p.vx = 0;
    }
  }
}

function resolveAxisY(p) {
  const tx0 = Math.floor(p.x / TILE_SIZE);
  const tx1 = Math.floor((p.x + p.w - 1) / TILE_SIZE);
  const ty0 = Math.floor(p.y / TILE_SIZE);
  const ty1 = Math.floor((p.y + p.h - 1) / TILE_SIZE);

  p.onGround = false;

  // Ceiling
  if (p.vy < 0) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (solidAt(tx, ty0)) {
        p.y = (ty0 + 1) * TILE_SIZE;
        p.vy = 0;
      }
    }
  }
  // Floor
  if (p.vy >= 0) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (solidAt(tx, ty1)) {
        p.y = ty1 * TILE_SIZE - p.h;
        const t = tileAt(tx, ty1);
        if (t?.type === 'bounce') {
          p.vy = JUMP_FORCE * 1.4;
          App.notify('🎉 Bounce!');
        } else {
          p.vy = 0;
          p.onGround = true;
        }
      }
    }
  }
}

function checkHazards(p) {
  const tx0 = Math.floor((p.x+4) / TILE_SIZE);
  const tx1 = Math.floor((p.x+p.w-4) / TILE_SIZE);
  const ty0 = Math.floor((p.y+4) / TILE_SIZE);
  const ty1 = Math.floor((p.y+p.h-4) / TILE_SIZE);
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const t = tileAt(tx, ty);
      if (t && TILE_CONFIG[t.type]?.hazard) {
        die(p);
        return;
      }
    }
  }
}

function die(p) {
  if (p.isDead) return;
  p.isDead    = true;
  p.deathTimer = 1200;
  p.vx = 0; p.vy = -8 * BASE_FRAME_RATE;
  App.notify('💀 You died!');
}

function respawn(p) {
  p.isDead = false;
  p.deathTimer = 0;
  const sp = getSpawnPoint();
  p.x = sp.x; p.y = sp.y;
  p.vx = 0;   p.vy = 0;
}

function getEditorViewportSize() {
  const zoom = state.editorMode ? state.editorZoom : 1;
  return {
    width: canvas.width / zoom,
    height: canvas.height / zoom,
  };
}

function clampCamera() {
  const { width, height } = getEditorViewportSize();
  const maxX = Math.max(0, state.map.width - width);
  const maxY = Math.max(0, state.map.height - height);
  state.camera.x = Math.max(0, Math.min(state.camera.x, maxX));
  state.camera.y = Math.max(0, Math.min(state.camera.y, maxY));
}

function setEditorZoom(nextZoom, anchorX = canvas.width / 2, anchorY = canvas.height / 2) {
  const oldZoom = state.editorZoom;
  const newZoom = Math.max(0.25, Math.min(4, nextZoom));
  if (newZoom === oldZoom) return;

  // Preserve the world point currently under the pointer.
  const worldX = state.camera.x + anchorX / oldZoom;
  const worldY = state.camera.y + anchorY / oldZoom;
  state.editorZoom = newZoom;
  state.camera.x = worldX - anchorX / newZoom;
  state.camera.y = worldY - anchorY / newZoom;
  clampCamera();
  updateEditorZoomLabel();
}

function resetEditorView() {
  state.editorZoom = 1;
  state.camera.x = 0;
  state.camera.y = 0;
  clampCamera();
  updateEditorZoomLabel();
}

function centerEditorView() {
  const { width, height } = getEditorViewportSize();
  state.camera.x = (state.map.width - width) / 2;
  state.camera.y = (state.map.height - height) / 2;
  clampCamera();
}

function updateEditorZoomLabel() {
  const label = document.getElementById('editor-zoom-label');
  if (label) label.textContent = `${Math.round(state.editorZoom * 100)}%`;
}

/* ══════════════════════════════════════════════════════════
   MAIN GAME LOOP
══════════════════════════════════════════════════════════ */
let lastTime = 0;
function gameLoop(ts) {
  const deltaTime = lastTime === 0
    ? 0
    : Math.min(Math.max((ts - lastTime) / 1000, 0), 0.1);
  lastTime = ts;
  // Keep the existing animation time unit (milliseconds) while deriving it
  // from the frame-rate-independent delta.
  state.animTime += deltaTime * 1000;
  state.frame++;

  const p = state.localPlayer;
  if (!p) { requestAnimationFrame(gameLoop); return; }

  // ── Input ──
  if (!state.editorMode) {
    const left  = input.keys['ArrowLeft']  || input.keys['KeyA'] || input.mobile.jx < -0.3;
    const right = input.keys['ArrowRight'] || input.keys['KeyD'] || input.mobile.jx >  0.3;
    const jumpK = input.keys['Space']      || input.keys['ArrowUp'] || input.keys['KeyW'];
    const jumpM = input.mobile.jump;

    if (left)  { p.vx = -MOVE_SPEED; p.facing = -1; }
    if (right) { p.vx =  MOVE_SPEED; p.facing =  1; }
    if ((jumpK || jumpM) && p.onGround && !p.isDead) {
      p.vy = JUMP_FORCE;
      p.onGround = false;
    }

    // Dance toggle via keyboard (E)
    if (input.mobile.dance && !p.isDancing) {
      p.isDancing  = true;
      p.danceTimer = DANCE_DURATION;
    }

    // Dance timer countdown
    if (p.isDancing) {
      p.danceTimer -= deltaTime * 1000;
      if (p.danceTimer <= 0) { p.isDancing = false; p.danceTimer = 0; }
    }

    // Animation state
    if (p.isDancing)      p.animState = 'dance';
    else if (!p.onGround) p.animState = 'jump';
    else if (Math.abs(p.vx) > 0.3) p.animState = 'walk';
    else p.animState = 'idle';

    p.animTime = state.animTime;

    // Physics
    resolvePlayerPhysics(p, deltaTime);

    // Chat timer
    if (p.chatTimer > 0) p.chatTimer -= deltaTime * 1000;
  }

  // ── Remote players lerp + anim ──
  const remoteLerp = 1 - Math.exp(-REMOTE_LERP_RATE * deltaTime);
  for (const rp of Object.values(state.players)) {
    rp.x += (rp.targetX - rp.x) * remoteLerp;
    rp.y += (rp.targetY - rp.y) * remoteLerp;
    rp.animTime = state.animTime;
    if (rp.chatTimer > 0) rp.chatTimer -= deltaTime * 1000;
  }

  // ── Camera ──
  if (!state.editorMode) {
    const camTargetX = p.x + p.w/2 - canvas.width/2;
    const camTargetY = p.y + p.h/2 - canvas.height/2;
    const cameraLerp = 1 - Math.exp(-CAMERA_LERP_RATE * deltaTime);
    state.camera.x += (camTargetX - state.camera.x) * cameraLerp;
    state.camera.y += (camTargetY - state.camera.y) * cameraLerp;
  }
  clampCamera();

  // ── Render ──
  renderFrame(p);

  // ── Network sync ──
  if (ts - state.lastSyncTime > SYNC_RATE_MS && state.channel) {
    state.lastSyncTime = ts;
    broadcastState(p);
  }

  // ── Ping every 5s ──
  if (ts - state.lastPingTime > 5000 && state.channel) {
    state.lastPingTime = ts;
    state.pingStart    = ts;
    state.channel.send({ type:'broadcast', event:'ping', payload:{ id: state.sessionId } });
  }

  requestAnimationFrame(gameLoop);
}

function renderFrame(localP) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, '#1a1a3e');
  sky.addColorStop(1, '#0f2060');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Parallax stars
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  const sr = 137.5 + state.camera.x * 0.02;
  for (let i = 0; i < 60; i++) {
    const sx = ((i*sr*1.7) % canvas.width);
    const sy = ((i*sr*2.3) % canvas.height);
    const br = (Math.sin(state.animTime*0.001 + i) * 0.5 + 0.5);
    ctx.globalAlpha = br * 0.5;
    ctx.fillRect(sx, sy, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;

  const zoom = state.editorMode ? state.editorZoom : 1;
  const viewWidth = canvas.width / zoom;
  const viewHeight = canvas.height / zoom;

  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(-state.camera.x, -state.camera.y);

  // ── Tiles ──
  const vx0 = Math.floor(state.camera.x / TILE_SIZE) - 1;
  const vx1 = Math.ceil((state.camera.x + viewWidth) / TILE_SIZE) + 1;
  const vy0 = Math.floor(state.camera.y / TILE_SIZE) - 1;
  const vy1 = Math.ceil((state.camera.y + viewHeight) / TILE_SIZE) + 1;

  for (const t of state.map.tiles) {
    if (t.x < vx0 || t.x > vx1 || t.y < vy0 || t.y > vy1) continue;
    drawTile(ctx, t, t.x * TILE_SIZE, t.y * TILE_SIZE);
  }

  // Editor grid overlay
  if (state.editorMode) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    for (let gx = vx0; gx <= vx1; gx++) {
      ctx.beginPath();
      ctx.moveTo(gx*TILE_SIZE, vy0*TILE_SIZE);
      ctx.lineTo(gx*TILE_SIZE, vy1*TILE_SIZE);
      ctx.stroke();
    }
    for (let gy = vy0; gy <= vy1; gy++) {
      ctx.beginPath();
      ctx.moveTo(vx0*TILE_SIZE, gy*TILE_SIZE);
      ctx.lineTo(vx1*TILE_SIZE, gy*TILE_SIZE);
      ctx.stroke();
    }
  }

  // ── Remote players ──
  for (const rp of Object.values(state.players)) {
    drawCharacter(ctx, rp, rp.x, rp.y, 1/60, false);
  }

  // ── Local player ──
  drawCharacter(ctx, localP, localP.x, localP.y, 1/60, true);

  // ── Local player glow ──
  ctx.shadowColor = '#f5a623';
  ctx.shadowBlur  = 10;
  ctx.fillStyle   = 'transparent';
  ctx.fillRect(localP.x, localP.y, localP.w, localP.h);
  ctx.shadowBlur  = 0;

  ctx.restore();

  // ── HUD ──
  if (state.editorMode) {
    ctx.fillStyle = 'rgba(233,69,96,0.18)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 14px Segoe UI, sans-serif';
    ctx.fillStyle = '#e94560';
    ctx.textAlign = 'left';
    ctx.fillText('🛠 EDITOR MODE — Click to place • Right-click to erase • Space + drag to pan', 12 / zoom, (canvas.height - 12) / zoom);
  }
}

/* ══════════════════════════════════════════════════════════
   REALTIME NETWORKING
══════════════════════════════════════════════════════════ */
function initRealtime() {
  const ch = _supabase.channel(CHANNEL_NAME, {
    config: { broadcast: { self: false }, presence: { key: state.sessionId } }
  });

  ch.on('broadcast', { event: 'state' }, ({ payload }) => {
    if (!payload || payload.id === state.sessionId) return;
    const id = payload.id;
    if (!state.players[id]) {
      // New remote player
      const rp = new Player(payload.x, payload.y, payload.username, payload.appearance);
      rp.targetX  = payload.x;
      rp.targetY  = payload.y;
      rp.animState = payload.animState || 'idle';
      rp.facing    = payload.facing || 1;
      rp.isDancing = payload.isDancing || false;
      state.players[id] = rp;
      App.chat.addSystem(`${payload.username} joined the world!`);
      updatePlayerList();
    } else {
      const rp = state.players[id];
      rp.targetX   = payload.x;
      rp.targetY   = payload.y;
      rp.animState = payload.animState || 'idle';
      rp.facing    = payload.facing   || 1;
      rp.isDancing = payload.isDancing || false;
      if (payload.appearance) rp.updateAppearance(payload.appearance);
    }
  });

  ch.on('broadcast', { event: 'chat' }, ({ payload }) => {
    if (!payload || payload.id === state.sessionId) return;
    App.chat.addMessage(payload.username, payload.msg, payload.id);
    // Show speech bubble
    const rp = state.players[payload.id];
    if (rp) {
      rp.chatMsg   = payload.msg.slice(0, 32);
      rp.chatTimer = 4000;
    }
  });

  ch.on('broadcast', { event: 'ping' }, ({ payload }) => {
    if (payload?.id === state.sessionId) {
      state.pingMs = Math.round(performance.now() - state.pingStart);
      document.getElementById('ping-display').textContent = `● ${state.pingMs}ms`;
      document.getElementById('ping-display').style.color =
        state.pingMs < 80 ? '#2ecc71' : state.pingMs < 200 ? '#f5a623' : '#e74c3c';
    }
  });

  ch.on('broadcast', { event: 'map_change' }, ({ payload }) => {
    if (!payload || payload.id === state.sessionId) return;
    App.maps.applyMapData(payload.mapData);
    App.notify('🗺 Map changed by ' + payload.username);
  });

  ch.on('presence', { event: 'join' }, ({ newPresences }) => {
    updatePlayerList();
  });
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
      broadcastState(state.localPlayer);
    }
  });

  state.channel = ch;
}

function broadcastState(p) {
  if (!state.channel || !p) return;
  state.channel.send({
    type:    'broadcast',
    event:   'state',
    payload: {
      id:         state.sessionId,
      username:   state.user.username,
      x:          Math.round(p.x),
      y:          Math.round(p.y),
      animState:  p.animState,
      facing:     p.facing,
      isDancing:  p.isDancing,
      appearance: p.appearance,
    }
  });
}

function updatePlayerList() {
  const list = document.getElementById('player-list');
  const self = { username: state.user?.username, appearance: state.localPlayer?.appearance };
  const all  = [self, ...Object.values(state.players)];
  list.innerHTML = all.map(p => {
    const c = p?.appearance?.torsoColor || '#4a9eff';
    return `<div class="player-list-item">
      <div class="player-avatar-dot" style="background:${c}"></div>
      <span>${p?.username || 'Unknown'}</span>
    </div>`;
  }).join('');
  const cnt = Object.keys(state.players).length + 1;
  document.getElementById('player-count').textContent = `${cnt} player${cnt!==1?'s':''}`;
}

/* ══════════════════════════════════════════════════════════
   CANVAS EDITOR
══════════════════════════════════════════════════════════ */
function editorCanvasClick(e, isRight) {
  if (!state.editorMode) return;
  const rect = canvas.getBoundingClientRect();
  const mx   = state.camera.x +
    (e.clientX - rect.left) * (canvas.width / rect.width) / state.editorZoom;
  const my   = state.camera.y +
    (e.clientY - rect.top) * (canvas.height / rect.height) / state.editorZoom;
  const tx   = Math.floor(mx / TILE_SIZE);
  const ty   = Math.floor(my / TILE_SIZE);
  const key  = `${tx},${ty}`;

  if (isRight || state.editorTile === 'erase') {
    state.map.tiles = state.map.tiles.filter(t => !(t.x === tx && t.y === ty));
    delete state.tileMap[key];
  } else {
    state.map.tiles = state.map.tiles.filter(t => !(t.x === tx && t.y === ty));
    const newTile = { x: tx, y: ty, type: state.editorTile };
    state.map.tiles.push(newTile);
    state.tileMap[key] = newTile;
  }
}

/* ══════════════════════════════════════════════════════════
   MOBILE JOYSTICK
══════════════════════════════════════════════════════════ */
const joystick = {
  active: false,
  startX: 0,
  startY: 0,
};

function initJoystick() {
  if (!isMobile()) return;
  document.getElementById('mobile-controls').classList.add('active');

  const zone  = document.getElementById('joystick-zone');
  const thumb = document.getElementById('joystick-thumb');
  const MAX   = 45;

  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    joystick.active = true;
    const t = e.touches[0];
    const r = zone.getBoundingClientRect();
    joystick.startX = r.left + r.width/2;
    joystick.startY = r.top  + r.height/2;
  }, { passive: false });

  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!joystick.active) return;
    const t  = e.touches[0];
    let dx = t.clientX - joystick.startX;
    let dy = t.clientY - joystick.startY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > MAX) { dx = dx/dist*MAX; dy = dy/dist*MAX; }
    thumb.style.left = `${50 + dx/MAX*50}%`;
    thumb.style.top  = `${50 + dy/MAX*50}%`;
    input.mobile.jx = dx / MAX;
    input.mobile.jy = dy / MAX;
  }, { passive: false });

  const reset = e => {
    e.preventDefault();
    joystick.active = false;
    input.mobile.jx = 0;
    input.mobile.jy = 0;
    thumb.style.left = '50%';
    thumb.style.top  = '50%';
  };
  zone.addEventListener('touchend',    reset, { passive: false });
  zone.addEventListener('touchcancel', reset, { passive: false });
}

/* ══════════════════════════════════════════════════════════
   APP — Main Controller
══════════════════════════════════════════════════════════ */
const App = {
  /* ── Auth ─────────────────────────────────────────────── */
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
      const errEl    = document.getElementById('login-error');
      const btn      = document.getElementById('login-btn');
      errEl.classList.add('hidden');

      if (!username || !password) {
        errEl.textContent = 'Please fill in all fields.';
        errEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Signing in…';

      try {
        const hash = await sha256(password);
        const { data, error } = await _supabase
          .from('users')
          .select('id, username, appearance')
          .eq('username', username)
          .eq('password_hash', hash)
          .single();

        if (error || !data) throw new Error('Invalid username or password.');

        state.user = { id: data.id, username: data.username, appearance: data.appearance || {} };
        App.startGame();
      } catch (err) {
        errEl.textContent = err.message || 'Login failed.';
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }
    },

    async register() {
      const username = document.getElementById('reg-username').value.trim();
      const password = document.getElementById('reg-password').value;
      const confirm  = document.getElementById('reg-confirm').value;
      const errEl    = document.getElementById('reg-error');
      const sucEl    = document.getElementById('reg-success');
      const btn      = document.getElementById('register-btn');
      errEl.classList.add('hidden');
      sucEl.classList.add('hidden');

      if (!username || !password || !confirm) {
        errEl.textContent = 'All fields are required.';
        errEl.classList.remove('hidden');
        return;
      }
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        errEl.textContent = 'Username: 3–24 characters, letters/numbers/underscore only.';
        errEl.classList.remove('hidden');
        return;
      }
      if (password.length < 6) {
        errEl.textContent = 'Password must be at least 6 characters.';
        errEl.classList.remove('hidden');
        return;
      }
      if (password !== confirm) {
        errEl.textContent = 'Passwords do not match.';
        errEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Creating…';

      try {
        const hash = await sha256(password);
        const { error } = await _supabase
          .from('users')
          .insert({ username, password_hash: hash, appearance: {} });

        if (error) {
          if (error.message?.includes('unique') || error.code === '23505') {
            throw new Error('Username already taken.');
          }
          throw new Error(error.message || 'Registration failed.');
        }

        sucEl.textContent = '✓ Account created! You can now sign in.';
        sucEl.classList.remove('hidden');
        setTimeout(() => App.auth.showTab('login'), 2000);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create Account';
      }
    },

    logout() {
      if (state.channel) {
        state.channel.unsubscribe();
        state.channel = null;
      }
      state.user   = null;
      state.players = {};
      document.getElementById('screen-game').classList.add('hidden');
      document.getElementById('screen-auth').classList.remove('hidden');
    },
  },

  /* ── Game Start ───────────────────────────────────────── */
  startGame() {
    document.getElementById('screen-auth').classList.add('hidden');
    document.getElementById('screen-game').classList.remove('hidden');
    document.getElementById('topbar-username').textContent = state.user.username;

    resizeCanvas();
    rebuildTileMap();

    const sp = getSpawnPoint();
    state.localPlayer = new Player(sp.x, sp.y, state.user.username, state.user.appearance);
    state.camera = { x: sp.x - canvas.width/2, y: sp.y - canvas.height/2 };

    initEditorListeners();
    initJoystick();
    initRealtime();
    updatePlayerList();

    requestAnimationFrame(ts => { lastTime = ts; requestAnimationFrame(gameLoop); });
    App.notify(`Welcome, ${state.user.username}! 🎮`);
  },

  /* ── Dance ────────────────────────────────────────────── */
  dance() {
    const p = state.localPlayer;
    if (!p || p.isDead) return;
    p.isDancing  = true;
    p.danceTimer = DANCE_DURATION;
    App.notify('🕺 Feeling Lucky!');
  },

  /* ── Chat ─────────────────────────────────────────────── */
  chat: {
    send() {
      const input = document.getElementById('chat-input');
      const msg   = input.value.trim();
      if (!msg) return;
      input.value = '';
      const p = state.localPlayer;
      if (p) { p.chatMsg = msg.slice(0, 32); p.chatTimer = 4000; }
      App.chat.addMessage(state.user.username, msg, state.sessionId);
      if (state.channel) {
        state.channel.send({
          type: 'broadcast', event: 'chat',
          payload: { id: state.sessionId, username: state.user.username, msg }
        });
      }
    },
    addMessage(username, msg, senderId) {
      const el = document.createElement('div');
      el.className = 'chat-msg';
      el.innerHTML = `<span class="msg-author">${escapeHtml(username)}</span>${escapeHtml(msg)}`;
      const box = document.getElementById('chat-messages');
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
      if (box.children.length > 150) box.removeChild(box.firstChild);
    },
    addSystem(msg) {
      const el = document.createElement('div');
      el.className = 'chat-msg system';
      el.textContent = msg;
      const box = document.getElementById('chat-messages');
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    },
  },

  /* ── Toggle chat ──────────────────────────────────────── */
  toggleChat() {
    const panel = document.getElementById('side-panel');
    panel.classList.toggle('collapsed');
    state.chatOpen = !panel.classList.contains('collapsed');
  },

  /* ── Notifications ────────────────────────────────────── */
  notify(msg) {
    const area = document.getElementById('notification-area');
    const el   = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    area.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  },

  /* ── Editor ───────────────────────────────────────────── */
  editor: {
    toggle() {
      state.editorMode = !state.editorMode;
      document.getElementById('editor-palette').classList.toggle('hidden', !state.editorMode);
      document.getElementById('editor-controls').classList.toggle('hidden', !state.editorMode);
      document.getElementById('mode-badge').textContent = state.editorMode ? 'EDITOR' : 'PLAY';
      document.getElementById('mode-badge').style.background = state.editorMode ? '#e74c3c' : 'var(--accent)';
      if (state.editorMode) {
        centerEditorView();
      } else {
        state.editorZoom = 1;
      }
      clampCamera();
      updateEditorZoomLabel();
      App.notify(state.editorMode ? '🛠 Editor mode ON' : '🎮 Play mode ON');
    },
    zoomIn() {
      setEditorZoom(state.editorZoom * 1.2);
    },
    zoomOut() {
      setEditorZoom(state.editorZoom / 1.2);
    },
    resetView() {
      resetEditorView();
    },
    centerView() {
      centerEditorView();
    },
    selectTile(type, btn) {
      state.editorTile = type;
      document.querySelectorAll('.tile-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    },
    clearMap() {
      if (!confirm('Clear all tiles? This cannot be undone.')) return;
      state.map.tiles = [];
      rebuildTileMap();
      App.notify('🗑 Map cleared');
    },
  },

  /* ── Mobile ───────────────────────────────────────────── */
  mobile: {
    jumpStart()  { input.mobile.jump  = true;  },
    jumpEnd()    { input.mobile.jump  = false; },
    danceStart() { input.mobile.dance = true;  App.dance(); },
    danceEnd()   { input.mobile.dance = false; },
  },

  /* ── Modals ───────────────────────────────────────────── */
  modals: {
    open(id) {
      document.getElementById(`modal-${id}`).classList.remove('hidden');
    },
    close(id) {
      document.getElementById(`modal-${id}`).classList.add('hidden');
    },
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
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
        document.getElementById(`color-${part}`).value = hex;
        App.modals.updatePreview();
      }
    },
    updatePreview() {
      const previewApp = {
        headColor:  document.getElementById('color-head').value,
        torsoColor: document.getElementById('color-torso').value,
        legColor:   document.getElementById('color-legs').value,
        armColor:   document.getElementById('color-arms').value,
        shirtUrl:   document.getElementById('shirt-url').value,
        hatUrl:     document.getElementById('hat-url').value,
      };
      // Sync hex fields
      document.getElementById('color-head-hex').value  = previewApp.headColor;
      document.getElementById('color-torso-hex').value = previewApp.torsoColor;
      document.getElementById('color-legs-hex').value  = previewApp.legColor;
      document.getElementById('color-arms-hex').value  = previewApp.armColor;

      const pv  = document.getElementById('customizer-canvas');
      const pvCtx = pv.getContext('2d');
      pvCtx.clearRect(0, 0, pv.width, pv.height);
      pvCtx.fillStyle = '#1a1a2e';
      pvCtx.fillRect(0, 0, pv.width, pv.height);

      const dummy = {
        appearance: previewApp,
        animState:  'idle',
        animTime:   state.animTime,
        isDancing:  false,
        chatMsg:    '',
        chatTimer:  0,
        _shirtImg:  null,
        _hatImg:    null,
        facing:     1,
        isDead:     false,
        w: 28, h: 44,
        username: state.user?.username || 'You',
      };
      drawCharacter(pvCtx, dummy, pv.width/2 - 14, pv.height/2 - 22, 1/60, true);
    },
    saveAppearance() {
      const app = {
        headColor:  document.getElementById('color-head').value,
        torsoColor: document.getElementById('color-torso').value,
        legColor:   document.getElementById('color-legs').value,
        armColor:   document.getElementById('color-arms').value,
        shirtUrl:   document.getElementById('shirt-url').value,
        hatUrl:     document.getElementById('hat-url').value,
      };
      if (state.localPlayer) state.localPlayer.updateAppearance(app);
      // Persist to DB
      _supabase.from('users')
        .update({ appearance: app })
        .eq('id', state.user.id)
        .then(({ error }) => {
          if (error) console.error('Save appearance error:', error);
        });
      App.modals.close('customizer');
      App.notify('🎨 Appearance saved!');
      updatePlayerList();
    },

    openMapBrowser() {
      App.modals.open('mapbrowser');
      App.modals.refreshMaps();
    },
    async refreshMaps() {
      const container = document.getElementById('map-list-container');
      container.innerHTML = '<div class="empty-state">Loading…</div>';
      const { data, error } = await _supabase
        .from('games')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30);

      if (error || !data) {
        container.innerHTML = `<div class="alert alert-error">Failed to load maps.</div>`;
        return;
      }
      if (data.length === 0) {
        container.innerHTML = '<div class="empty-state">no games rn 😴<br><br>Create one in Editor mode!</div>';
        return;
      }
      container.innerHTML = `<div class="map-list">${data.map(m => `
        <div class="map-card">
          <div class="map-card-info">
            <h4>${escapeHtml(m.title)}</h4>
            <div class="meta">by ${escapeHtml(m.creator)} • ${new Date(m.created_at).toLocaleDateString()}</div>
          </div>
          <div class="map-actions">
            <button class="btn btn-primary btn-sm" onclick="App.maps.loadMap('${m.id}')">▶ Load</button>
          </div>
        </div>`).join('')}</div>`;
    },

    openSaveMap() {
      if (!state.editorMode) { App.notify('Enable editor mode first!'); return; }
      document.getElementById('map-title').value = '';
      document.getElementById('save-map-error').classList.add('hidden');
      document.getElementById('save-map-success').classList.add('hidden');
      App.modals.open('savemap');
    },
  },

  /* ── Maps ─────────────────────────────────────────────── */
  maps: {
    async saveCurrentMap() {
      const title   = document.getElementById('map-title').value.trim();
      const errEl   = document.getElementById('save-map-error');
      const sucEl   = document.getElementById('save-map-success');
      errEl.classList.add('hidden');
      sucEl.classList.add('hidden');

      if (!title) {
        errEl.textContent = 'Please enter a map title.';
        errEl.classList.remove('hidden');
        return;
      }
      if (state.map.tiles.length < 3) {
        errEl.textContent = 'Add at least a few tiles before saving.';
        errEl.classList.remove('hidden');
        return;
      }

      const mapData = {
        tiles:  state.map.tiles,
        width:  state.map.width,
        height: state.map.height,
      };

      const { error } = await _supabase
        .from('games')
        .insert({ title, creator: state.user.username, data: mapData });

      if (error) {
        errEl.textContent = 'Save failed: ' + (error.message || 'unknown error');
        errEl.classList.remove('hidden');
        return;
      }

      sucEl.textContent = '✓ Map published successfully!';
      sucEl.classList.remove('hidden');
      App.notify('✅ Map published: ' + title);

      // Broadcast map change to all players
      if (state.channel) {
        state.channel.send({
          type: 'broadcast', event: 'map_change',
          payload: { id: state.sessionId, username: state.user.username, mapData }
        });
      }

      setTimeout(() => App.modals.close('savemap'), 1800);
    },

    async loadMap(id) {
      const { data, error } = await _supabase
        .from('games')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !data) { App.notify('Failed to load map.'); return; }

      App.maps.applyMapData(data.data);
      App.modals.close('mapbrowser');
      App.notify('🗺 Loaded: ' + data.title);

      // Broadcast
      if (state.channel) {
        state.channel.send({
          type: 'broadcast', event: 'map_change',
          payload: { id: state.sessionId, username: state.user.username, mapData: data.data }
        });
      }
    },

    applyMapData(mapData) {
      state.map.tiles  = mapData.tiles || [];
      state.map.width  = mapData.width  || 2400;
      state.map.height = mapData.height || 1200;
      rebuildTileMap();
      if (state.localPlayer) respawn(state.localPlayer);
    },
  },
};

/* ══════════════════════════════════════════════════════════
   EDITOR CANVAS EVENTS
══════════════════════════════════════════════════════════ */
function initEditorListeners() {
  if (initEditorListeners.initialized) return;
  initEditorListeners.initialized = true;

  canvas.addEventListener('mousedown', e => {
    if (!state.editorMode) return;
    state.mouseDown = true;
    state.isDragging = false;
    const spacePan = input.keys.Space || e.button === 1;
    if (spacePan) {
      state.isPanning = true;
      state.panLastX = e.clientX;
      state.panLastY = e.clientY;
      canvas.classList.add('is-panning');
      e.preventDefault();
      return;
    }
    if (e.button === 0) editorCanvasClick(e, false);
    if (e.button === 2) editorCanvasClick(e, true);
  });
  canvas.addEventListener('mousemove', e => {
    if (!state.editorMode || !state.mouseDown) return;
    if (state.isPanning) {
      const rect = canvas.getBoundingClientRect();
      state.camera.x -= (e.clientX - state.panLastX) / (rect.width / canvas.width) / state.editorZoom;
      state.camera.y -= (e.clientY - state.panLastY) / (rect.height / canvas.height) / state.editorZoom;
      state.panLastX = e.clientX;
      state.panLastY = e.clientY;
      clampCamera();
      return;
    }
    if (state.mouseDown) {
      state.isDragging = true;
      editorCanvasClick(e, e.buttons === 2);
    }
  });
  const stopPointer = () => {
    state.mouseDown = false;
    state.isPanning = false;
    canvas.classList.remove('is-panning');
  };
  canvas.addEventListener('mouseup', stopPointer);
  canvas.addEventListener('mouseleave', stopPointer);
  canvas.addEventListener('contextmenu', e => { e.preventDefault(); });
  canvas.addEventListener('wheel', e => {
    if (!state.editorMode) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const isPinch = e.ctrlKey;
    const isMouseWheel = Math.abs(e.deltaY) >= 40 && !e.deltaX;

    if (isPinch || isMouseWheel) {
      setEditorZoom(state.editorZoom * Math.exp(-e.deltaY * 0.0015), x, y);
      return;
    }

    // Small two-finger trackpad scrolls pan the editor viewport.
    state.camera.x += (e.deltaX || (e.shiftKey ? e.deltaY : 0)) / state.editorZoom;
    state.camera.y += (!e.shiftKey ? e.deltaY : 0) / state.editorZoom;
    clampCamera();
  }, { passive: false });

  canvas.addEventListener('touchstart', e => {
    if (!state.editorMode || e.touches.length < 2) return;
    e.preventDefault();
    const first = e.touches[0];
    const second = e.touches[1];
    state.editorTouch.active = true;
    state.editorTouch.distance = Math.hypot(
      second.clientX - first.clientX,
      second.clientY - first.clientY
    );
    state.editorTouch.centerX = (first.clientX + second.clientX) / 2;
    state.editorTouch.centerY = (first.clientY + second.clientY) / 2;
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    if (!state.editorMode || !state.editorTouch.active || e.touches.length < 2) return;
    e.preventDefault();
    const first = e.touches[0];
    const second = e.touches[1];
    const distance = Math.hypot(
      second.clientX - first.clientX,
      second.clientY - first.clientY
    );
    const centerX = (first.clientX + second.clientX) / 2;
    const centerY = (first.clientY + second.clientY) / 2;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const anchorX = (centerX - rect.left) * scaleX;
    const anchorY = (centerY - rect.top) * scaleY;

    if (state.editorTouch.distance > 0) {
      setEditorZoom(
        state.editorZoom * (distance / state.editorTouch.distance),
        anchorX,
        anchorY
      );
    }

    state.camera.x -= (centerX - state.editorTouch.centerX) * scaleX / state.editorZoom;
    state.camera.y -= (centerY - state.editorTouch.centerY) * scaleY / state.editorZoom;
    clampCamera();
    state.editorTouch.distance = distance;
    state.editorTouch.centerX = centerX;
    state.editorTouch.centerY = centerY;
  }, { passive: false });

  const stopTouchGesture = () => {
    state.editorTouch.active = false;
    state.editorTouch.distance = 0;
  };
  canvas.addEventListener('touchend', stopTouchGesture, { passive: true });
  canvas.addEventListener('touchcancel', stopTouchGesture, { passive: true });
}

/* ══════════════════════════════════════════════════════════
   UTILS
══════════════════════════════════════════════════════════ */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════
   BOOTSTRAP
══════════════════════════════════════════════════════════ */
(async function init() {
  // Minimal delay to show loading screen
  await new Promise(r => setTimeout(r, 800));

  // Test Supabase connection
  try {
    await _supabase.from('users').select('id').limit(1);
  } catch (e) {
    console.warn('Supabase connection check:', e);
  }

  document.getElementById('loading-overlay').style.opacity = '0';
  document.getElementById('loading-overlay').style.transition = 'opacity .4s';
  setTimeout(() => {
    document.getElementById('loading-overlay').style.display = 'none';
    document.getElementById('screen-auth').classList.remove('hidden');
  }, 400);
})();
