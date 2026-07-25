# Dihblocks — Things, Pyfork & Infinite Worlds

This edit adds three big features on top of the original repo:

1. **Infinite levels.** The map no longer has a fixed width/height. Camera,
   physics and editor panning all work at any coordinate. Save/load preserves
   the "infinite" flag (`width/height` are stored as `null`).
2. **512 KB upload guard.** Any file the user picks in the Thing editor is
   validated client-side; uploads larger than 512 KB are rejected with an
   error message.
3. **Things — scripted textured objects.** A new editor tool (`Thing
   (scripted)` in the tile palette) places a placeable object with:
    - a texture (URL or uploaded file, up to 512 KB),
    - a fallback colour, a size, and a physics mode (`static`, `dynamic`,
      `ghost`),
    - a **Pyfork** (Python-like) or **JavaScript** script that reacts to
      game events.

Right-click in the editor deletes the tile / Thing under the cursor.

## Pyfork — the mini language

Pyfork is a friendly, Python-flavoured DSL that compiles to JavaScript at
runtime (see `pyfork.js`). It is **not** full Python: indentation is
significant, but only a subset of syntax is supported. Everything else is
game-specific keywords. If you'd rather write plain JS, switch the language
selector to **JavaScript** — you'll get helpers `H.on_start`, `H.on_update`,
`H.on('name', fn)`, `H.every(period, fn)`.

### Structure

Top-level blocks register handlers:

```pyfork
on_start:
    print 'hello'

on_update:
    self.x += 1

every 0.5:
    move self by 10 0

on_touch player:
    bounce player 700
    trigger 'boom'

on 'boom':
    flash '#ff0'
    delete self

on_click:
    say self 'ouch'

on_key W:
    jump player
```

### Expressions & control flow

```pyfork
if self.x > 500 and player.y < 200:
    self.vx = -100
elif self.x < 0:
    self.vx = 100
else:
    self.vx = 0

for i in range(5):
    create thing at self.x + i * 40 self.y colour '#0ff'
```

`and / or / not / True / False / None` map to `&& || ! true false null`.

### The full keyword table

Every keyword below is a top-level statement (no parentheses needed).

| Category    | Keyword                             | Meaning                                      |
|-------------|-------------------------------------|----------------------------------------------|
| Output      | `print X`, `log X`, `notify X`, `say self X` | Console / on-screen text            |
| Visuals     | `colour C` / `color C`              | Set fallback colour (hex string)             |
|             | `texture URL`                       | Set texture image                            |
|             | `size N`                            | Set edge length in px                        |
|             | `scale N`                           | Multiply size                                |
|             | `rotate DEG`                        | Rotate around centre                         |
|             | `opacity N`                         | 0..1                                         |
|             | `show` / `hide`                     | Visibility                                   |
|             | `flash COLOUR`                      | Full-screen flash                            |
|             | `shake MAG`                         | Camera shake                                 |
| Physics     | `gravity G`                         | Per-thing gravity (px/s²)                    |
|             | `friction F`                        | 0..1                                         |
|             | `solid` / `ghost`                   | Collide vs. no-collide                       |
|             | `velocity VX VY`                    | Set velocity                                 |
|             | `push T by DX DY`                   | Add to velocity                              |
|             | `bounce T POWER`                    | Set vy to `-POWER`                           |
|             | `jump T`                            | Default jump for T                           |
| Movement    | `move T by DX DY` / `move T to X Y` | Displace or teleport                         |
|             | `goto T X Y`                        | Teleport                                     |
|             | `face 'left'`/`'right'`/T           | Set facing                                   |
|             | `follow T SPEED`                    | Steer self toward T                          |
|             | `stop`                              | Zero velocity                                |
| Timing      | `wait S` / `sleep S`                | Async pause in seconds                       |
| Lifecycle   | `create thing at X Y with size S colour C texture URL script SRC` | Spawn a Thing |
|             | `spawn ...`                         | Alias of `create`                            |
|             | `clone`                             | Duplicate `self`                             |
|             | `delete T` / `destroy T`            | Remove Thing                                 |
|             | `kill T` / `respawn T`              | Player death / respawn                       |
| Events      | `trigger 'name' PAYLOAD`            | Fire a named event                           |
|             | `broadcast 'name' PAYLOAD`          | Alias of trigger                             |
|             | `on 'name': ...`                    | Handler for a named event                    |
|             | `on_touch player: ...`              | Player collision                             |
|             | `on_click: ...`                     | (reserved) click on thing                    |
|             | `on_key K: ...`                     | Keyboard                                     |
|             | `on_start:` / `on_update:` / `every N:` | Lifecycle blocks                         |
| State       | `set KEY = VAL`                     | `state[KEY] = VAL`                           |
|             | `inc KEY [BY]` / `dec KEY [BY]`     | Increment/decrement                          |
| World       | `tile at X Y = 'platform'`          | Place a tile                                 |
|             | `tile clear X Y`                    | Remove a tile                                |
|             | `camera to X Y` / `camera follow T` | Move camera                                  |
|             | `background COLOUR` / `music URL`   | Global background / music                    |
| Audio       | `sound URL` / `beep`                | Play a sound                                 |
| Misc        | `random`, `return`, `break`, `continue` | Utility                                  |

### The runtime API (if you use plain JS)

The compiled script sees these variables: `self`, `player`, `world`, `api`,
`state`. Some highlights:

```js
H.on_start(async () => { api.setColour(self, '#0ff'); });
H.every(1, () => { api.moveBy(self, 10, 0); });
H.on('boom', () => { api.flash('#ff0'); api.delete(self); });
```

See `things.js` for the full API surface.

## Files added / changed

- `app.js`         — infinite world; hooks Things into physics + render;
                    saves `things` inside map data; adds a `thing` editor
                    tile that opens the Thing modal.
- `index.html`     — new `Thing` palette button, the Thing editor modal,
                    and `<script src>` tags for `pyfork.js` and `things.js`.
- `pyfork.js`      — new: Pyfork → JS compiler.
- `things.js`      — new: Thing entity system, editor modal wiring,
                    512 KB upload guard, serialisation.
- `THINGS_README.md` — this document.

No files were removed.
