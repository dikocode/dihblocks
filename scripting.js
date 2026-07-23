function initScripting() {
  const api = {
    move: (x, y) => {
      if (state.localPlayer) { 
        state.localPlayer.x += Number(x || 0); 
        state.localPlayer.y += Number(y || 0); 
      }
    },
    rotate: (deg) => { 
      App.notify(`Rotated ${deg}°`); 
    },
    color: (c) => {
      if (state.localPlayer) {
        state.localPlayer.updateAppearance({ torsoColor: c });
        App.notify(`🎨 Color changed to ${c}`);
      }
    },
    size: (w, h) => { 
      if (state.localPlayer) { 
        state.localPlayer.w = Number(w || 28); 
        state.localPlayer.h = Number(h || 44);
        App.notify(`📐 Size changed to ${w}x${h}`);
      } 
    },
    say: (msg) => { 
      chat.addMessage('Script', String(msg), 'script');
      App.notify(`💬 Script: ${msg}`);
    },
    playSound: (name) => { 
      App.notify(`🔊 Playing: ${name}`);
    },
    stopSound: (name) => {
      App.notify(`🔇 Stopped: ${name}`);
    },
    create: (type, x, y) => {
      App.notify(`✨ Created ${type} at ${x},${y}`);
      if (state.editorMode) {
        const tx = Math.floor(Number(x || 0) / TILE_SIZE);
        const ty = Math.floor(Number(y || 0) / TILE_SIZE);
        if (state.map) {
          state.map.tiles.push({ x: tx, y: ty, type: type || 'platform' });
          rebuildTileMap();
          App.studio.updateStats();
        }
      }
    },
    destroy: (id) => {
      App.notify(`🗑️ Destroyed ${id}`);
      if (state.map && id) {
        const parts = id.split(',');
        if (parts.length === 2) {
          const tx = parseInt(parts[0]);
          const ty = parseInt(parts[1]);
          state.map.tiles = state.map.tiles.filter(t => !(t.x === tx && t.y === ty));
          rebuildTileMap();
          App.studio.updateStats();
        }
      }
    },
    custom: (name, args) => { 
      App.notify(`⚙️ Custom: ${name}(${args.join(',')})`);
      if (name === 'teleport') {
        const x = parseFloat(args[0]) || 0;
        const y = parseFloat(args[1]) || 0;
        if (state.localPlayer) {
          state.localPlayer.x = x * TILE_SIZE;
          state.localPlayer.y = y * TILE_SIZE;
          App.notify(`🔄 Teleported to ${x}, ${y}`);
        }
      }
    },
    image: {
      load: (url) => { 
        if (state.localPlayer) {
          state.localPlayer.updateAppearance({ shirtUrl: url });
          App.notify(`🖼️ Image loaded`);
        }
      },
      filter: (name) => { 
        App.notify(`🎨 Image filter: ${name}`);
      },
    },
    game: {
      getPlayer: () => state.localPlayer,
      getMap: () => state.map,
      getPlayers: () => ({ 
        local: state.localPlayer,
        remote: Object.values(state.players)
      }),
      setTile: (x, y, type) => {
        if (state.map && state.editorMode) {
          const tx = Math.floor(Number(x));
          const ty = Math.floor(Number(y));
          state.map.tiles = state.map.tiles.filter(t => !(t.x === tx && t.y === ty));
          if (type && type !== 'erase') {
            state.map.tiles.push({ x: tx, y: ty, type: String(type) });
            rebuildTileMap();
            App.studio.updateStats();
            App.notify(`🧱 Set tile at (${tx}, ${ty}) to ${type}`);
          }
        }
      }
    },
    ui: {
      createPanel: (html) => {
        const el = document.createElement('div');
        el.className = 'toast';
        el.innerHTML = String(html);
        document.getElementById('notification-area').appendChild(el);
        setTimeout(() => el.remove(), 5000);
      },
    },
    onLog: (msg) => App.studio.logConsole(msg, 'info'),
    onError: (msg) => App.studio.logConsole(msg, 'error'),
    
    // =========================================================
    // PHYSICS CONTROLS - ALL 4 WORKING
    // =========================================================
    gravity: (value) => {
      const g = Number(value);
      if (!isNaN(g) && g >= 0 && g <= 10) {
        GRAVITY = g;
        App.notify(`🌍 Gravity set to ${g}`);
        App.studio.logConsole(`Gravity → ${g}`, 'info');
      } else {
        App.notify(`❌ Gravity must be between 0 and 10`);
      }
    },
    jumpForce: (value) => {
      const j = Number(value);
      if (!isNaN(j) && j <= 0 && j >= -30) {
        JUMP_FORCE = j;
        App.notify(`⬆ Jump force set to ${j}`);
        App.studio.logConsole(`JumpForce → ${j}`, 'info');
      } else {
        App.notify(`❌ Jump force must be negative (e.g. -15)`);
      }
    },
    moveSpeed: (value) => {
      const s = Number(value);
      if (!isNaN(s) && s >= 0 && s <= 20) {
        MOVE_SPEED = s;
        App.notify(`🏃 Move speed set to ${s}`);
        App.studio.logConsole(`MoveSpeed → ${s}`, 'info');
      } else {
        App.notify(`❌ Move speed must be between 0 and 20`);
      }
    },
    friction: (value) => {
      const f = Number(value);
      if (!isNaN(f) && f >= 0 && f <= 1) {
        GROUND_FRICTION = f;
        App.notify(`🧊 Friction set to ${f}`);
        App.studio.logConsole(`Friction → ${f}`, 'info');
      } else {
        App.notify(`❌ Friction must be between 0 and 1`);
      }
    }
  };

  scriptEngine = new ScriptEngine(api);
  
  const editor = document.getElementById('script-editor');
  if (editor && scriptEngine.currentSource.dihlang) {
    editor.value = scriptEngine.currentSource.dihlang;
  }
}
