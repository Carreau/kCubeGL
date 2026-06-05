# kCube

A 3D dice-rolling puzzle, playable in the browser with WebGL (Three.js).

Cubes sit on a 5×5 board; each is a die with six coloured faces. Roll them
around until **every cube shows the same colour on top** — before you run out
of moves.

![board](https://img.shields.io/badge/render-WebGL-6ee7ff) ![deps](https://img.shields.io/badge/deps-three.js-3aa0ff)

## Play locally

The game uses ES modules, so it must be served over HTTP (opening the file
directly via `file://` won't load the modules). Any static server works:

```bash
# option A — Node
npm start            # serves on http://localhost:8080

# option B — Python
python3 -m http.server 8080
```

Then open <http://localhost:8080> and press **Play**.

Three.js is loaded from a CDN at runtime (in your browser), so no build step or
`npm install` is required.

## How to play

- **Arrow keys** — look at the neighbouring cell in that direction:
  - **Empty cell:** the selected cube *rolls* one square into it (a real die
    tip-over — the top face changes). Costs **1 move**.
  - **Another cube:** the cursor (a down-pointing arrow) just *re-selects* that
    cube (free). The cursor can only hop between cubes that are **N/S/E/W
    adjacent** — it can't jump across a gap.
  - **Board edge:** nothing happens.
- **Q / E** — rotate the board view around the vertical axis.
- **S** — show a solution (replays a guaranteed solve from the start; then
  retry to try it yourself).
- **R** — retry the current level (fresh scramble).
- **M** / **Levels** — open the level picker.
- **Enter / Space** — dismiss a panel / advance to the next level.

### Win & economy

- A level is solved when **all cubes show the same colour face-up** *and* they
  form a **single connected block** (every cube touching another N/S/E/W).
- Each level has a **fixed move budget**. Run out before solving → retry.
- **Clearing a level grants +1 move**, carried into later levels — so efficient
  solving compounds across a run.
- **Best scores** (fewest moves to clear each level) are saved in your browser.
  Pick any level you've reached from the **Levels** menu to **replay** it and
  beat your record.

## How it works

- **Guaranteed-solvable levels:** every level starts from a *solved* board —
  cubes placed in one **contiguous block**, all white up — and is scrambled with
  random *reverse-rolls*. Reversing that exact sequence both matches the colours
  and returns the cubes to their connected start, so no level is ever
  impossible. That reverse sequence is also what **Show solution** plays back.
- **Par accounts for herding:** because the cursor can't jump between disjoint
  clusters, scattered cubes must be rolled back together to win. The move budget
  is therefore set well above the raw scramble length (it scales with the cube
  count) so a level stays beatable by hand.
- **True 3D rolling:** a roll rotates the cube 90° about its leading bottom
  edge. Because the cell spacing equals the cube size, the cube lands exactly on
  the next cell. The face shown on top is read back from the cube's orientation
  for win detection.

## Project layout

```
index.html       entry point + import map (Three.js) + HUD/overlay markup
src/styles.css   HUD, help text and overlay styling
src/main.js      game logic, level generation, rendering and roll animation
```

## Scope (v1)

Implemented: 5×5 board, bevelled dice with randomised orientations, arrow-key
cursor & rolling, animated tip-over, solvable level generation, contiguous-block
win condition, herding-aware move budget, carried bonus, Q/E view rotation,
show-solution playback, persisted best scores and level replay, win/lose flow.
Deliberately left out for now: sound, timer and undo.

## License

MIT
