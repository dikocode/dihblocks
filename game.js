/**
 * DIHBLOCKS — game.js
 * Minimal local/offline game engine so the imported UI actually loads and runs.
 * Replaces the missing App object referenced by index.html.
 */
'use strict';

(function() {
  const TILE_SIZE = 32;
  const GRAVITY = 1800;
  const MOVE_ACCEL = 1200;
  const MAX_SPEED = 260;
  const JUMP_FORCE = -620;
  const FRICTION = 0.82;
  const AIR_FRICTION = 0.94;
  const CHUNK_SIZE = 16; // tiles per chunk (chunk loader)

  const TILES = {
    platform: { color: '#4a9eff', solid: true },
    ground: { color: '#5c8a3c', solid: true },
    hazard: { color: '#e74c3c', solid: true, hazard: true },
    spawn: { color: '#f5a623', solid: false },
    lava: { color: '#ff6b00', solid: true, hazard: true },
    ice: { color: '#aef0ff', solid: true, friction: 0.98 },
    bounce: { color: '#c678dd', solid: true, bounce: 1.4 },
    erase: { color: '#333', solid: false }
  };

  const state = {
    user: null,
    currentMap: null,
    maps: [],
    chat: [],
    settings: { renderMode: 'preloader' },
    appearance: { head: '#f5c842', torso: '#3a8bff', legs: '#2c3e50', arms: '#f5c842', shirt: '', hat: '' },
    editor: { active: false, selectedTile: 'platform', scriptSource: { dihlang: '', python: '', js: '' }, scriptTab: 'dihlang' },
    homeTab: 'all',
    mobile: { active: false, joystick: { active: false, dx: 0, dy: 0 }, jump: false, dance: false }
  };

  const player = { x: 200, y: 200, vx: 0, vy: 0, width: 24, height: 36, onGround: false, dancing: false, face: 1 };
  const camera = { x: 0, y: 0 };
  const keys = {};
  const $ = id => document.getElementById(id);

  let canvas, ctx, studioCanvas, studioCtx, customizerCanvas, customizerCtx;
  let lastTime = 0;
  let scriptEngine = null;
  let animationId = null;

  const App = {
    init,
    auth: { showTab, login, register, logout },
    home: { createNewMap, searchMaps, refreshMaps, setTab, returnToBrowser },
    game: { start, stop },
    editor: { toggle, selectTile, clearMap },
    studio: { switchLeftTab, switchRightTab, switchScriptTab, spawnAsset, saveScriptSource, runScript, stopScript },
    modals: { openCustomizer, closeCustomizer, updatePreview, syncColor, saveAppearance, openSaveMap, closeSaveMap, openSettings, closeSettings, close },
    maps: { saveCurrentMap },
    chat: { send, addMessage },
    mobile: { jumpStart, jumpEnd, danceStart, danceEnd },
    settings: { setRenderMode },
    toggleChat
  };

  window.App = Object.assign(window.App || {}, App);

  function init() {
    loadState();
    initCanvases();
    setupInput();
    setupMobileControls();
    setupStudioInput();
    updateScriptEngine();
    window.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(loop);
    $('loading-overlay').classList.add('hidden');
    $('screen-auth').classList.remove('hidden');
    if (state.user) showHome();
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem('dihblocks_state') || '{}');
      Object.assign(state, saved);
    } catch (e) {}
  }

  function saveState() {
    localStorage.setItem('dihblocks_state', JSON.stringify(state));
  }

  function initCanvases() {
    canvas = $('gameCanvas');
    ctx = canvas.getContext('2d');
    studioCanvas = $('studioCanvas');
    studioCtx = studioCanvas.getContext('2d');
    customizerCanvas = $('customizer-canvas');
    customizerCtx = customizerCanvas ? customizerCanvas.getContext('2d') : null;
  }

  function resize() {
    if (canvas) {
      canvas.width = canvas.parentElement.clientWidth;
      canvas.height = canvas.parentElement.clientHeight;
    }
    if (studioCanvas) {
      studioCanvas.width = studioCanvas.parentElement.clientWidth;
      studioCanvas.height = studioCanvas.parentElement.clientHeight;
    }
  }

  // ============================================================
  // GAME LOOP & PHYSICS (delta-time)
  // ============================================================
  function loop(ts) {
    const dt = Math.min((ts - lastTime) / 1000, 0.05);
    lastTime = ts;
    if (state.editor.active) {
      updateStudio(dt);
    } else if (state.currentMap) {
      updateGame(dt);
    }
    render();
    animationId = requestAnimationFrame(loop);
  }

  function updateGame(dt) {
    // Movement scaled by dt so speed is the same at 60Hz, 120Hz, 144Hz
    let move = 0;
    if (keys['a'] || keys['arrowleft']) move -= 1;
    if (keys['d'] || keys['arrowright']) move += 1;

    if (move !== 0) {
      player.vx += move * MOVE_ACCEL * dt;
      player.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, player.vx));
      player.face = move > 0 ? 1 : -1;
    }

    const friction = getTileFriction() * (player.onGround ? 1 : 0.9);
    player.vx *= friction;

    // Gravity
    player.vy += GRAVITY * dt;

    // Apply velocity
    player.x += player.vx * dt;
    resolveHorizontalCollision();
    player.y += player.vy * dt;
    resolveVerticalCollision();

    // Mobile joystick
    if (state.mobile.joystick.active) {
      player.vx += state.mobile.joystick.dx * MOVE_ACCEL * dt;
      player.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, player.vx));
      player.face = state.mobile.joystick.dx > 0 ? 1 : -1;
    }
    if (state.mobile.jump && player.onGround) {
      player.vy = JUMP_FORCE;
      player.onGround = false;
      state.mobile.jump = false;
    }
    player.dancing = state.mobile.dance || keys['e'];

    // Camera follow
    camera.x = player.x - canvas.width / 2;
    camera.y = player.y - canvas.height / 2;

    // Hazard / fall reset
    if (player.y > (state.currentMap.height || 40) * TILE_SIZE + 200) {
      respawnPlayer();
    }
  }

  function getTileFriction() {
    const tx = Math.floor((player.x + player.width / 2) / TILE_SIZE);
    const ty = Math.floor((player.y + player.height) / TILE_SIZE);
    const tile = getTile(tx, ty);
    return tile && TILES[tile].friction ? TILES[tile].friction : FRICTION;
  }

  function resolveHorizontalCollision() {
    const map = state.currentMap.tiles;
    const left = Math.floor(player.x / TILE_SIZE);
    const right = Math.floor((player.x + player.width) / TILE_SIZE);
    const top = Math.floor(player.y / TILE_SIZE);
    const bottom = Math.floor((player.y + player.height - 1) / TILE_SIZE);
    for (let ty = top; ty <= bottom; ty++) {
      for (let tx = left; tx <= right; tx++) {
        const t = getTile(tx, ty);
        if (t && TILES[t].solid) {
          const tileX = tx * TILE_SIZE;
          if (player.vx > 0 && player.x + player.width - player.vx * 0.016 <= tileX) {
            player.x = tileX - player.width - 0.01;
            player.vx = 0;
          } else if (player.vx < 0 && player.x - player.vx * 0.016 >= tileX + TILE_SIZE) {
            player.x = tileX + TILE_SIZE + 0.01;
            player.vx = 0;
          }
        }
      }
    }
  }

  function resolveVerticalCollision() {
    const map = state.currentMap.tiles;
    const left = Math.floor(player.x / TILE_SIZE);
    const right = Math.floor((player.x + player.width - 1) / TILE_SIZE);
    const top = Math.floor(player.y / TILE_SIZE);
    const bottom = Math.floor((player.y + player.height) / TILE_SIZE);
    player.onGround = false;
    for (let ty = top; ty <= bottom; ty++) {
      for (let tx = left; tx <= right; tx++) {
        const t = getTile(tx, ty);
        if (t && TILES[t].solid) {
          const tileY = ty * TILE_SIZE;
          if (player.vy > 0 && player.y + player.height - player.vy * 0.016 <= tileY) {
            player.y = tileY - player.height - 0.01;
            player.vy = 0;
            player.onGround = true;
            if (TILES[t].bounce) player.vy = JUMP_FORCE * TILES[t].bounce;
          } else if (player.vy < 0 && player.y - player.vy * 0.016 >= tileY + TILE_SIZE) {
            player.y = tileY + TILE_SIZE + 0.01;
            player.vy = 0;
          }
          if (TILES[t].hazard) respawnPlayer();
        }
      }
    }
  }

  function getTile(tx, ty) {
    if (!state.currentMap || !state.currentMap.tiles) return null;
    return state.currentMap.tiles[`${tx},${ty}`] || null;
  }

  function setTile(tx, ty, type) {
    if (!state.currentMap) return;
    if (type === 'erase' || !type) {
      delete state.currentMap.tiles[`${tx},${ty}`];
    } else {
      state.currentMap.tiles[`${tx},${ty}`] = type;
    }
  }

  function respawnPlayer() {
    const map = state.currentMap;
    const spawns = Object.keys(map.tiles).filter(k => map.tiles[k] === 'spawn');
    if (spawns.length) {
      const [tx, ty] = spawns[0].split(',').map(Number);
      player.x = tx * TILE_SIZE + 4;
      player.y = ty * TILE_SIZE - player.height;
    } else {
      player.x = 200;
      player.y = 200;
    }
    player.vx = 0;
    player.vy = 0;
  }

  // ============================================================
  // RENDER (pre-loader vs chunk loader)
  // ============================================================
  function render() {
    if (state.editor.active) {
      renderStudio();
    } else if (state.currentMap) {
      renderGame();
    }
  }

  function renderGame() {
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!state.currentMap) return;

    const startCol = Math.floor(camera.x / TILE_SIZE);
    const endCol = Math.floor((camera.x + canvas.width) / TILE_SIZE) + 1;
    const startRow = Math.floor(camera.y / TILE_SIZE);
    const endRow = Math.floor((camera.y + canvas.height) / TILE_SIZE) + 1;

    // Determine visible tiles based on render mode
    const visibleTiles = getVisibleTiles(startCol, endCol, startRow, endRow);

    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // Draw grid background for empty areas
    ctx.strokeStyle = '#11121f';
    ctx.lineWidth = 1;
    for (let c = startCol; c <= endCol; c++) {
      for (let r = startRow; r <= endRow; r++) {
        ctx.strokeRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }

    // Draw tiles
    for (const key of visibleTiles) {
      const type = state.currentMap.tiles[key];
      if (!type || !TILES[type]) continue;
      const [tx, ty] = key.split(',').map(Number);
      drawTile(ctx, tx, ty, type);
    }

    // Draw player
    drawPlayer(ctx, player.x, player.y);

    ctx.restore();
  }

  function getVisibleTiles(startCol, endCol, startRow, endRow) {
    const keys = Object.keys(state.currentMap.tiles || {});
    if (state.settings.renderMode === 'chunk') {
      const pcx = Math.floor(player.x / TILE_SIZE / CHUNK_SIZE);
      const pcy = Math.floor(player.y / TILE_SIZE / CHUNK_SIZE);
      const radius = 2;
      return keys.filter(k => {
        const [tx, ty] = k.split(',').map(Number);
        const cx = Math.floor(tx / CHUNK_SIZE);
        const cy = Math.floor(ty / CHUNK_SIZE);
        return Math.abs(cx - pcx) <= radius && Math.abs(cy - pcy) <= radius;
      });
    }
    return keys.filter(k => {
      const [tx, ty] = k.split(',').map(Number);
      return tx >= startCol && tx <= endCol && ty >= startRow && ty <= endRow;
    });
  }

  function drawTile(context, tx, ty, type) {
    const x = tx * TILE_SIZE;
    const y = ty * TILE_SIZE;
    const def = TILES[type];
    context.fillStyle = def.color;
    context.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    if (type === 'spawn') {
      context.fillStyle = 'rgba(0,0,0,0.4)';
      context.font = '10px sans-serif';
      context.fillText('SPAWN', x + 2, y + 20);
    }
    if (type === 'hazard' || type === 'lava') {
      context.strokeStyle = 'rgba(0,0,0,0.3)';
      context.beginPath();
      context.moveTo(x + 4, y + 4);
      context.lineTo(x + TILE_SIZE - 4, y + TILE_SIZE - 4);
      context.stroke();
    }
  }

  function drawPlayer(context, x, y) {
    const a = state.appearance;
    // Head
    context.fillStyle = a.head;
    context.fillRect(x + 4, y, 16, 14);
    // Torso
    context.fillStyle = a.torso;
    context.fillRect(x + 4, y + 14, 16, 14);
    // Arms
    context.fillStyle = a.arms;
    context.fillRect(player.face > 0 ? x + 20 : x - 2, y + 16, 6, 10);
    // Legs
    context.fillStyle = a.legs;
    if (player.dancing) {
      context.fillRect(x + 2, y + 28, 8, 8);
      context.fillRect(x + 14, y + 28, 8, 8);
    } else {
      context.fillRect(x + 4, y + 28, 6, 8);
      context.fillRect(x + 14, y + 28, 6, 8);
    }
    // Hat
    if (a.hat) drawImageOrPlaceholder(context, a.hat, x, y - 8, 24, 16);
    // Shirt
    if (a.shirt) drawImageOrPlaceholder(context, a.shirt, x + 4, y + 14, 16, 14);
  }

  function drawImageOrPlaceholder(context, url, x, y, w, h) {
    const img = new Image();
    img.onload = () => context.drawImage(img, x, y, w, h);
    img.src = url;
    // Placeholder while loading
    context.fillStyle = 'rgba(255,255,255,0.2)';
    context.fillRect(x, y, w, h);
  }

  // ============================================================
  // STUDIO (pointer + touch block place/delete)
  // ============================================================
  function updateStudio(dt) {
    // Studio is mostly static; we re-render in renderStudio
  }

  function renderStudio() {
    const ctx = studioCtx;
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, studioCanvas.width, studioCanvas.height);
    if (!state.currentMap) return;
    ctx.save();
    const offsetX = studioCanvas.width / 2 - camera.x;
    const offsetY = studioCanvas.height / 2 - camera.y;
    ctx.translate(offsetX, offsetY);
    const keys = Object.keys(state.currentMap.tiles || {});
    for (const k of keys) {
      const [tx, ty] = k.split(',').map(Number);
      drawTile(ctx, tx, ty, state.currentMap.tiles[k]);
    }
    ctx.restore();
  }

  function setupStudioInput() {
    if (!studioCanvas) return;
    let isDown = false, isErase = false;
    const getPos = e => {
      const rect = studioCanvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const offsetX = studioCanvas.width / 2 - camera.x;
      const offsetY = studioCanvas.height / 2 - camera.y;
      return {
        tx: Math.floor((clientX - rect.left - offsetX) / TILE_SIZE),
        ty: Math.floor((clientY - rect.top - offsetY) / TILE_SIZE)
      };
    };
    const paint = e => {
      const { tx, ty } = getPos(e);
      const type = isErase ? 'erase' : state.editor.selectedTile;
      setTile(tx, ty, type);
      updateStudioStats();
    };
    studioCanvas.addEventListener('pointerdown', e => {
      isDown = true;
      isErase = e.button === 2 || e.shiftKey || state.editor.selectedTile === 'erase';
      paint(e);
      studioCanvas.setPointerCapture(e.pointerId);
    });
    studioCanvas.addEventListener('pointermove', e => {
      if (isDown) paint(e);
    });
    studioCanvas.addEventListener('pointerup', e => { isDown = false; });
    studioCanvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  function updateStudioStats() {
    const map = state.currentMap;
    if (!map) return;
    const tiles = Object.keys(map.tiles).length;
    const spawns = Object.values(map.tiles).filter(t => t === 'spawn').length;
    $('stat-tiles').textContent = tiles;
    $('stat-players').textContent = 1;
    $('stat-spawns').textContent = spawns;
  }

  // ============================================================
  // INPUT
  // ============================================================
  function setupInput() {
    window.addEventListener('keydown', e => {
      const key = e.key.toLowerCase();
      keys[key] = true;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (player.onGround) player.vy = JUMP_FORCE;
      }
      if (key === 'e') player.dancing = true;
      if (key === 't') {
        const input = $('chat-input');
        if (input) input.focus();
      }
    });
    window.addEventListener('keyup', e => {
      const key = e.key.toLowerCase();
      keys[key] = false;
      if (key === 'e') player.dancing = false;
    });
  }

  function setupMobileControls() {
    const zone = $('joystick-zone');
    const base = $('joystick-base');
    const thumb = $('joystick-thumb');
    if (!zone) return;

    const start = e => {
      e.preventDefault();
      state.mobile.active = true;
      state.mobile.joystick.active = true;
      moveJoystick(e.touches ? e.touches[0] : e);
      $('mobile-controls').classList.add('active');
    };
    const move = e => {
      if (!state.mobile.joystick.active) return;
      moveJoystick(e.touches ? e.touches[0] : e);
    };
    const end = e => {
      state.mobile.joystick.active = false;
      state.mobile.joystick.dx = 0;
      state.mobile.joystick.dy = 0;
      if (thumb) thumb.style.transform = 'translate(-50%, -50%)';
    };

    function moveJoystick(point) {
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = point.clientX - cx;
      const dy = point.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const max = rect.width / 2;
      const scale = dist > max ? max / dist : 1;
      const sx = dx * scale;
      const sy = dy * scale;
      if (thumb) thumb.style.left = (50 + (sx / max) * 50) + '%';
      if (thumb) thumb.style.top = (50 + (sy / max) * 50) + '%';
      state.mobile.joystick.dx = sx / max;
      state.mobile.joystick.dy = sy / max;
    }

    zone.addEventListener('touchstart', start, { passive: false });
    zone.addEventListener('touchmove', move, { passive: false });
    zone.addEventListener('touchend', end);
    zone.addEventListener('touchcancel', end);
  }

  // ============================================================
  // AUTH
  // ============================================================
  function showTab(tab) {
    const loginForm = $('form-login');
    const regForm = $('form-register');
    const loginTab = $('tab-login');
    const regTab = $('tab-register');
    if (tab === 'login') {
      loginForm.classList.remove('hidden');
      regForm.classList.add('hidden');
      loginTab.classList.add('active');
      regTab.classList.remove('active');
    } else {
      loginForm.classList.add('hidden');
      regForm.classList.remove('hidden');
      loginTab.classList.remove('active');
      regTab.classList.add('active');
    }
  }

  function login() {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    const error = $('login-error');
    const users = JSON.parse(localStorage.getItem('dihblocks_users') || '[]');
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) {
      error.textContent = 'Invalid username or password.';
      error.classList.remove('hidden');
      return;
    }
    state.user = user;
    saveState();
    showHome();
  }

  function register() {
    const username = $('reg-username').value.trim();
    const password = $('reg-password').value;
    const confirm = $('reg-confirm').value;
    const error = $('reg-error');
    const success = $('reg-success');
    const usernameRegex = /^[a-zA-Z0-9_]{3,24}$/;
    if (!usernameRegex.test(username)) {
      error.textContent = 'Username must be 3–24 letters, numbers, or underscores.';
      error.classList.remove('hidden');
      return;
    }
    if (password.length < 6) {
      error.textContent = 'Password must be at least 6 characters.';
      error.classList.remove('hidden');
      return;
    }
    if (password !== confirm) {
      error.textContent = 'Passwords do not match.';
      error.classList.remove('hidden');
      return;
    }
    const users = JSON.parse(localStorage.getItem('dihblocks_users') || '[]');
    if (users.find(u => u.username === username)) {
      error.textContent = 'Username already taken.';
      error.classList.remove('hidden');
      return;
    }
    users.push({ username, password });
    localStorage.setItem('dihblocks_users', JSON.stringify(users));
    state.user = { username };
    saveState();
    error.classList.add('hidden');
    success.textContent = 'Account created! You can now sign in.';
    success.classList.remove('hidden');
  }

  function logout() {
    state.user = null;
    saveState();
    stop();
    $('screen-auth').classList.remove('hidden');
    $('screen-home').classList.add('hidden');
    $('screen-game').classList.add('hidden');
    $('creator-studio').classList.add('hidden');
  }

  // ============================================================
  // HOME
  // ============================================================
  function showHome() {
    $('screen-auth').classList.add('hidden');
    $('screen-game').classList.add('hidden');
    $('creator-studio').classList.add('hidden');
    $('screen-home').classList.remove('hidden');
    $('home-username').textContent = state.user ? state.user.username : 'Guest';
    refreshMaps();
  }

  function createNewMap() {
    const map = {
      id: 'local_' + Date.now(),
      title: 'Untitled World',
      creator: state.user ? state.user.username : 'Guest',
      createdAt: Date.now(),
      tiles: {},
      width: 100,
      height: 60
    };
    // Baseplate
    for (let x = 0; x < 40; x++) {
      map.tiles[`${x},${55}`] = 'ground';
    }
    map.tiles[`${2},${54}`] = 'spawn';
    map.tiles[`${3},${54}`] = 'spawn';
    state.maps.push(map);
    saveState();
    start(map.id);
  }

  function refreshMaps() {
    const maps = state.maps || [];
    const grid = $('map-grid');
    const term = ($('home-search') ? $('home-search').value : '').toLowerCase();
    const tab = state.homeTab;
    const filtered = maps.filter(m => {
      const matches = !term || m.title.toLowerCase().includes(term);
      const mine = state.user && m.creator === state.user.username;
      if (tab === 'mine') return matches && mine;
      return matches;
    });
    if (!filtered.length) {
      grid.innerHTML = '<div class="empty-state">No worlds found.</div>';
      return;
    }
    grid.innerHTML = filtered.map(m => `
      <div class="map-card" onclick="App.game.start('${m.id}')">
        <h4>${escapeHtml(m.title)}</h4>
        <div class="meta">By ${escapeHtml(m.creator)} • ${new Date(m.createdAt).toLocaleDateString()}</div>
        <div class="map-card-actions">
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); App.game.start('${m.id}')">Play</button>
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); App.editor.toggle('${m.id}')">Edit</button>
        </div>
      </div>
    `).join('');
  }

  function searchMaps() { refreshMaps(); }

  function setTab(tab, btn) {
    state.homeTab = tab;
    document.querySelectorAll('.home-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    refreshMaps();
  }

  function returnToBrowser() {
    stop();
    showHome();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ============================================================
  // GAME / EDITOR
  // ============================================================
  function start(mapId) {
    const map = state.maps.find(m => m.id === mapId) || state.currentMap;
    if (!map) return;
    state.currentMap = map;
    state.editor.active = false;
    $('creator-studio').classList.add('hidden');
    $('screen-home').classList.add('hidden');
    $('screen-game').classList.remove('hidden');
    $('topbar-username').textContent = state.user ? state.user.username : 'Guest';
    $('player-count').textContent = '1 player';
    $('ping-display').textContent = '● 0ms';
    if (window.ScriptEngine) updateScriptEngine();
    respawnPlayer();
  }

  function stop() {
    state.currentMap = null;
    state.editor.active = false;
  }

  function toggle(mapId) {
    if (state.editor.active) {
      // close studio
      state.editor.active = false;
      $('creator-studio').classList.add('hidden');
      if (state.currentMap) $('screen-game').classList.remove('hidden');
      else showHome();
      return;
    }
    const map = mapId ? state.maps.find(m => m.id === mapId) : state.currentMap;
    if (!map) return;
    state.currentMap = map;
    state.editor.active = true;
    $('screen-game').classList.add('hidden');
    $('creator-studio').classList.remove('hidden');
    $('studio-map-title').value = map.title;
    updateStudioStats();
    updateScriptEngine();
  }

  function selectTile(type, btn) {
    state.editor.selectedTile = type;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('selected'));
    if (btn) btn.classList.add('selected');
  }

  function clearMap() {
    if (!state.currentMap) return;
    if (!confirm('Clear the entire map?')) return;
    state.currentMap.tiles = {};
    updateStudioStats();
  }

  // ============================================================
  // STUDIO TABS & SCRIPTS
  // ============================================================
  function switchLeftTab(tab, btn) {
    $('left-tab-tools').classList.toggle('hidden', tab !== 'tools');
    $('left-tab-assets').classList.toggle('hidden', tab !== 'assets');
    document.querySelectorAll('#studio-left .panel-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
  }

  function switchRightTab(tab, btn) {
    $('right-tab-inspector').classList.toggle('hidden', tab !== 'inspector');
    $('right-tab-scripts').classList.toggle('hidden', tab !== 'scripts');
    document.querySelectorAll('#studio-right .panel-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
  }

  function switchScriptTab(tab, btn) {
    state.editor.scriptTab = tab;
    $('script-editor').value = state.editor.scriptSource[tab] || '';
    document.querySelectorAll('.script-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
  }

  function saveScriptSource() {
    state.editor.scriptSource[state.editor.scriptTab] = $('script-editor').value;
  }

  function runScript() {
    saveScriptSource();
    if (!scriptEngine) updateScriptEngine();
    const source = state.editor.scriptSource[state.editor.scriptTab];
    scriptEngine.run(state.editor.scriptTab, source);
  }

  function stopScript() {
    if (scriptEngine) scriptEngine.stop();
  }

  function updateScriptEngine() {
    if (!window.ScriptEngine) return;
    scriptEngine = new window.ScriptEngine({
      move: (x, y) => { player.x += x || 0; player.y += y || 0; },
      rotate: deg => {},
      color: c => {},
      size: (w, h) => {},
      create: (type, x, y) => setTile(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE), type || 'platform'),
      destroy: id => {},
      say: msg => addMessage('Script', msg, 'system'),
      playSound: name => {},
      stopSound: name => {},
      gravity: g => {},
      jumpForce: f => {},
      moveSpeed: s => {},
      friction: f => {},
      onLog: msg => logScript(msg, 'info'),
      onError: msg => logScript(msg, 'error'),
      image: {}, game: {}, ui: {}
    });
  }

  function logScript(msg, cls) {
    const consoleEl = $('script-console');
    if (!consoleEl) return;
    const div = document.createElement('div');
    div.className = 'log-' + cls;
    div.textContent = msg;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function spawnAsset(type) {
    if (!state.currentMap) return;
    state.editor.selectedTile = type;
    addMessage('Studio', `Selected asset: ${type}. Click the canvas to place.`, 'system');
  }

  // ============================================================
  // MODALS
  // ============================================================
  function openCustomizer() {
    $('modal-customizer').classList.remove('hidden');
    const a = state.appearance;
    $('color-head').value = a.head;
    $('color-head-hex').value = a.head;
    $('color-torso').value = a.torso;
    $('color-torso-hex').value = a.torso;
    $('color-legs').value = a.legs;
    $('color-legs-hex').value = a.legs;
    $('color-arms').value = a.arms;
    $('color-arms-hex').value = a.arms;
    $('shirt-url').value = a.shirt || '';
    $('hat-url').value = a.hat || '';
    updatePreview();
  }

  function closeCustomizer() { $('modal-customizer').classList.add('hidden'); }
  function openSaveMap() { $('modal-savemap').classList.remove('hidden'); $('save-map-error').classList.add('hidden'); $('save-map-success').classList.add('hidden'); }
  function closeSaveMap() { $('modal-savemap').classList.add('hidden'); }
  function openSettings() { $('modal-settings').classList.remove('hidden'); }
  function closeSettings() { $('modal-settings').classList.add('hidden'); }
  function close(name) {
    if (name === 'customizer') closeCustomizer();
    if (name === 'savemap') closeSaveMap();
  }

  function updatePreview() {
    const a = state.appearance;
    a.head = $('color-head').value;
    a.torso = $('color-torso').value;
    a.legs = $('color-legs').value;
    a.arms = $('color-arms').value;
    a.shirt = $('shirt-url').value;
    a.hat = $('hat-url').value;
    $('color-head-hex').value = a.head;
    $('color-torso-hex').value = a.torso;
    $('color-legs-hex').value = a.legs;
    $('color-arms-hex').value = a.arms;
    if (customizerCtx) {
      customizerCtx.clearRect(0, 0, customizerCanvas.width, customizerCanvas.height);
      drawPlayer(customizerCtx, 48, 20);
    }
  }

  function syncColor(part) {
    const hex = $(`color-${part}-hex`).value;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      $(`color-${part}`).value = hex;
      updatePreview();
    }
  }

  function saveAppearance() {
    updatePreview();
    saveState();
    closeCustomizer();
  }

  // ============================================================
  // MAPS
  // ============================================================
  function saveCurrentMap() {
    const map = state.currentMap;
    if (!map) return;
    const title = $('map-title').value.trim() || map.title;
    map.title = title;
    const existing = state.maps.find(m => m.id === map.id);
    if (!existing) state.maps.push(map);
    saveState();
    const err = $('save-map-error');
    const ok = $('save-map-success');
    if (err) err.classList.add('hidden');
    if (ok) {
      ok.textContent = 'World published!';
      ok.classList.remove('hidden');
    }
    setTimeout(() => closeSaveMap(), 1000);
  }

  // ============================================================
  // CHAT
  // ============================================================
  function toggleChat() {
    const panel = $('side-panel');
    if (panel.classList.contains('collapsed')) panel.classList.remove('collapsed');
    else panel.classList.add('collapsed');
  }

  function send() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    const author = state.user ? state.user.username : 'Guest';
    addMessage(author, text);
    input.value = '';
  }

  function addMessage(author, text, cls) {
    const chat = $('chat-messages');
    if (!chat) return;
    const div = document.createElement('div');
    div.className = 'chat-msg' + (cls ? ' ' + cls : '');
    div.innerHTML = `<span class="msg-author">${escapeHtml(author)}</span>${escapeHtml(text)}`;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // ============================================================
  // MOBILE
  // ============================================================
  function jumpStart(e) {
    if (e) e.preventDefault();
    state.mobile.jump = true;
    if (player.onGround) player.vy = JUMP_FORCE;
  }
  function jumpEnd(e) { state.mobile.jump = false; }
  function danceStart(e) {
    if (e) e.preventDefault();
    state.mobile.dance = true;
    player.dancing = true;
  }
  function danceEnd(e) {
    state.mobile.dance = false;
    player.dancing = false;
  }

  // ============================================================
  // SETTINGS
  // ============================================================
  function setRenderMode(mode) {
    state.settings.renderMode = mode === 'chunk' ? 'chunk' : 'preloader';
    saveState();
    const desc = $('render-mode-desc');
    const preBtn = $('mode-preloader');
    const chunkBtn = $('mode-chunk');
    if (state.settings.renderMode === 'chunk') {
      if (desc) desc.textContent = 'Chunk Loader renders only visible screen chunks around the player.';
      if (preBtn) preBtn.classList.remove('active');
      if (chunkBtn) chunkBtn.classList.add('active');
    } else {
      if (desc) desc.textContent = 'Pre-loader loads the full world map at start.';
      if (preBtn) preBtn.classList.add('active');
      if (chunkBtn) chunkBtn.classList.remove('active');
    }
  }

  // ============================================================
  // BOOT
  // ============================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
