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

### Do I need parentheses?

Short answer: **statements never need them, expression-helper functions
always do.**

- **Statement keywords — no parentheses, ever.** These are full lines/actions
  by themselves: `print`, `colour`, `size`, `move`, `push`, `bounce`,
  `damage`, `create`, `tag`, `on_start:`, and basically everything in the
  keyword table below. Just write the keyword followed by its arguments,
  separated by spaces (commas also work):

  ```pyfork
  bounce player 700
  push self by 10 20
  damage player 5
  size 60
  tag 'enemy'
  ```

- **Expression-level helper functions — parentheses required**, because
  they're used *inside* an expression rather than as a standalone action.
  Right now these are `distance(...)`, `angle_to(...)`, and `clamp(...)`.
  You'll use them inside an `if`, a `set`, or anywhere else a value is
  expected:

  ```pyfork
  if distance(self, player) < 100:
      damage player 5

  set d = clamp(x, 0, 10)
  ```

- **`range(...)` also needs parentheses**, since it's part of `for` loop
  syntax:

  ```pyfork
  for i in range(5):
      create thing at self.x + i * 40 self.y colour '#0ff'
  ```

Rule of thumb: if it's a full line/action by itself, no parens. If it's a
value you're plugging into a condition or assignment, use parens.

### The full keyword table

Every keyword below is a top-level statement (no parentheses needed) —
**except** the "Expressions" row, whose entries are called with `()` since
they're used inside a condition or assignment, not as a standalone line.
See "Do I need parentheses?" above for the full explanation.

| Category    | Keyword                             | Meaning                                      |
|-------------|-------------------------------------|----------------------------------------------|
| Output      | `print X`, `log X`, `notify X`, `say self X` | Console / on-screen text            |
|             | `print_message X`                   | Prints X to the in-game **Console panel** (creator-only, see below) |
| Visuals     | `colour C` / `color C`              | Set fallback colour (hex string)             |
|             | `texture URL`                       | Set texture image                            |
|             | `size N`                            | Set edge length in px (square)               |
|             | `width N` / `height N`              | Set width / height independently             |
|             | `scale N`                           | Multiply size/width/height                   |
|             | `rotate DEG`                        | Rotate around centre (relative)              |
|             | `angle DEG`                         | Set absolute rotation                        |
|             | `opacity N`                         | 0..1                                         |
|             | `fade FROM TO DURATION`             | Animate opacity over DURATION seconds        |
|             | `show` / `hide`                     | Visibility                                   |
|             | `layer N`                           | Draw order (higher draws on top)             |
|             | `label TEXT`                        | Floating text label above the Thing          |
|             | `tag NAME`                          | Free-form string tag for grouping/lookup     |
|             | `flash COLOUR`                      | Full-screen flash                            |
|             | `shake MAG`                         | Camera shake                                 |
| Physics     | `gravity G`                         | Per-thing gravity (px/s²)                    |
|             | `friction F`                        | 0..1                                         |
|             | `solid` / `ghost`                   | Collide vs. no-collide                       |
|             | `velocity VX VY`                    | Set velocity                                 |
|             | `push T by DX DY`                   | Add to velocity                              |
|             | `bounce T POWER`                    | Set vy to `-POWER`                           |
|             | `jump T`                            | Default jump for T                           |
|             | `freeze T` / `unfreeze T`           | Zero velocity & pause / resume physics       |
|             | `lock T` / `unlock T`               | Mark immovable / movable again               |
| Movement    | `move T by DX DY` / `move T to X Y` | Displace or teleport                         |
|             | `goto T X Y`                        | Teleport                                     |
|             | `face 'left'`/`'right'`/T           | Set facing                                   |
|             | `follow T SPEED`                    | Steer self toward T                          |
|             | `stop`                              | Zero velocity                                |
| Health      | `damage T AMOUNT` (`damage AMOUNT` targets self) | Reduce hp, fires `'death'` at 0 |
|             | `heal T AMOUNT` (`heal AMOUNT` targets self) | Increase hp, capped at maxHp        |
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
| Expressions | `distance(A, B)` / `dist(A, B)`     | Distance between Things (usable in `if`)     |
|             | `angle_to(A, B)`                    | Angle in degrees from A to B                 |
|             | `clamp(V, LO, HI)`                  | Clamp a number between bounds                |
| Misc        | `random`, `return`, `break`, `continue` | Utility                                  |

### Console panel (creator-only script output)

A new **🖥 Console** button appears in the editor's top-right controls,
but **only for the map's creator** and only while in Editor mode. It opens
a small panel that shows every message sent with `print_message` from any
Thing's script — handy for debugging without opening the browser dev tools.

- `print_message X` (or `print_message(X)`) sends X to this panel.
- Regular `print`/`log` still only go to the browser console, unchanged —
  use `print_message` specifically when you want to see it in-game.
- The panel has a 🗑 Clear button and a ✕ Close button; it keeps the last
  300 messages.
- Visibility is tied to the same ownership check used for Update/Publish
  (`currentMapCreator === state.user.username`), so other players — even
  other people editing a map they don't own — never see it.

### Bugs fixed in this update

1. **Editing an existing Thing's script silently didn't save.** Clicking a
   Thing with the `Thing` tool always created a *new*, blank Thing on top of
   it rather than opening the one already there, so anything typed and
   "saved" landed on a throwaway duplicate, not the Thing actually on the
   map. Editing now correctly finds and reuses the Thing under the cursor.
   Cancelling out of the editor on a freshly-created (never-saved) Thing now
   also discards it, instead of leaving a blank invisible Thing behind.
2. **Multi-argument keywords compiled to broken JS.** Space-separated
   keyword arguments — `bounce player 700`, `push self by 10 20`,
   `velocity 5 -10`, and basically anything written without commas — were
   joined into one malformed expression (e.g. `api.bounce(player 700, 600)`),
   which threw at runtime. Argument parsing now correctly splits both
   comma-separated and bare space-separated argument lists.

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
                    tile that opens the Thing modal; adds `App.console`
                    (creator-only script output panel).
- `index.html`     — new `Thing` palette button, the Thing editor modal,
                    `<script src>` tags for `pyfork.js` and `things.js`,
                    and the new `#console-btn` / `#script-console` markup.
- `styles.css`     — styling for the new script console panel.
- `pyfork.js`      — new: Pyfork → JS compiler; added `print_message`,
                    `width`/`height`/`angle`/`fade`/`layer`/`label`/`tag`,
                    `freeze`/`unfreeze`/`lock`/`unlock`, `damage`/`heal`,
                    and expression helpers `distance`/`angle_to`/`clamp`.
- `things.js`      — new: Thing entity system, editor modal wiring,
                    512 KB upload guard, serialisation; fixed the
                    edit-creates-a-duplicate save bug; added the API
                    methods backing the new keywords above, including
                    `printMessage`.
- `THINGS_README.md` — this document.

No files were removed.
