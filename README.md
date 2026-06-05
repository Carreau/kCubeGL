# kCube

A 3D dice-rolling puzzle, playable in the browser with WebGL (Three.js).

Cubes sit on a 5×5 board; each is a die with six coloured faces. Roll them
around until **every cube shows the same colour on top** — before you run out
of moves.

![board](https://img.shields.io/badge/render-WebGL-6ee7ff) ![deps](https://img.shields.io/badge/deps-three.js-3aa0ff)

## Play locally

```bash
npm start            # full app + accounts + leaderboards, http://localhost:8080
```

`npm start` runs a small Node server (`server/server.mjs`) that serves the game
**and** a JSON API backed by SQLite. It needs **Node ≥ 22.5** — the backend uses
the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module, so there
is **no native dependency and no `npm install`** for the server itself. The
database file (`server/kcube.sqlite`) is created on first run.

Then open <http://localhost:8080>, pick a level, and play.

### Without the backend

The game still runs as plain static files — the API client degrades gracefully
to `localStorage` (your best scores are kept, but there are no accounts or
leaderboards):

```bash
npm run static       # static-only server (the old behaviour)
# or
python3 -m http.server 8080
```

Three.js is loaded from a CDN at runtime (in your browser), so no build step is
required either way.

## Levels, accounts & leaderboards

- **`index.html` is a real level picker** — a grid of levels showing your best,
  the world best, and how many players have solved each. Click a card to play
  (`play.html?level=N`); each level has a shareable URL.
- **Every level is the same puzzle for everyone.** Level generation is seeded
  from the level number, so level 5 is an identical board on every device —
  which makes the best score a genuine record.
- **Sign in with a name** (no password) to land on the leaderboards. The server
  records every *attempt* — won, lost or abandoned — with its move count and
  duration. From those rows it derives per-puzzle **difficulty** (win rate, avg
  attempts to first solve / to a personal best) and per-player **skill** (solve
  rate, average moves over the best-known solution, average solve time).

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
index.html         landing page: level grid, sign-in, leaderboards
play.html          the game page (import map for Three.js) + HUD/overlay
src/index.mjs      landing-page logic (grid, account, per-level detail)
src/main.js        game logic, level generation, rendering and roll animation
src/api.mjs        offline-safe browser client for the backend API
src/shared.mjs     dependency-free level math shared by game + server
src/styles.css     HUD, landing page and overlay styling
server/server.mjs  HTTP server: static files + JSON API (node:http)
server/db.mjs      SQLite data layer + analytics queries (node:sqlite)
test/api.mjs       backend API integration test (no browser)
test/smoke.mjs     end-to-end smoke test (Playwright, headless browser)
```

## Scope

Implemented: 5×5 board, bevelled dice, arrow-key cursor & rolling, animated
tip-over, **deterministic** solvable level generation, contiguous-block win
condition, herding-aware move budget, carried bonus, Q/E view rotation,
show-solution playback, win/lose flow; a real **level-picker landing page**, an
optional **SQLite backend** with **username accounts**, **leaderboards**, and
per-attempt tracking feeding **puzzle-difficulty** and **player-skill** stats.
Best scores persist locally too, so the game still works with no backend.
Deliberately left out for now: passwords/sessions, sound, timer and undo.

## License

MIT
