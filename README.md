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
the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module. Today the
server runs with no npm dependencies, though that's a convenience rather than a
hard rule — adding dependencies or a build step is fine. The database file
(`server/kcube.sqlite`) is created on first run.

Then open <http://localhost:8080>, pick a puzzle, and play.

### If the server is unreachable

The backend is the source of truth for accounts, the catalogue, leaderboards and
difficulty stats, but the client is resilient: if the server is briefly
unreachable it falls back to a cold-start cache — the same catalogue computed
locally plus your `localStorage` best scores — so you can keep playing until the
connection returns. You can also serve the game as plain static files (no
accounts or leaderboards) for a CDN-only deploy:

```bash
npm run dev          # static only (no backend): Python http.server on 8080
# or
python3 -m http.server 8080
```

Three.js is loaded from a CDN at runtime (in your browser), so no build step is
required today — though one can be added if the project grows to need it.

## Puzzles, accounts & leaderboards

- **`index.html` is the puzzle catalogue** — a grid of named puzzles showing your
  best, the world best, and how many players have solved each. You can **sort by
  difficulty** (failure rate, world-best moves over scramble length, cube count,
  name). Click a card to play (`play.html?puzzle=<name>`); each puzzle has a
  shareable URL.
- **A fixed, named pool — no level numbers.** Puzzles are a catalogue of ~40
  randomly-named boards (e.g. `ochre-bramble`) with varied cube counts and
  scramble depths, all derived from one master seed — so a given puzzle is an
  identical board on every device, which makes the best score a genuine record.
  Admins can pin/order which puzzles are featured first.
- **Sign in with a name** (password optional) to land on the leaderboards, and
  optionally add a **passkey** for secure WebAuthn login on later visits. The server
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
- **R** — retry the current puzzle (same scrambled start).
- **M** / **Puzzles** — open the puzzle catalogue.
- **Enter / Space** — dismiss a panel / advance to the next puzzle.

### Win & economy

- A puzzle is solved when **all cubes show the same colour face-up** *and* they
  form a **single connected block** (every cube touching another N/S/E/W).
- Each puzzle has a **fixed move budget**. Run out before solving → retry.
- **Clearing a puzzle grants +1 move**, carried into later puzzles — so efficient
  solving compounds across a run.
- **Best scores** (fewest moves to clear each puzzle) are saved in your browser.
  Pick any puzzle from the **Puzzles** catalogue to **replay** it and beat your
  record.

## How it works

- **Guaranteed-solvable puzzles:** every puzzle starts from a *solved* board —
  cubes placed in one **contiguous block**, all one colour up — and is scrambled
  with random *reverse-rolls*. Reversing that exact sequence both matches the
  colours and returns the cubes to their connected start, so no puzzle is ever
  impossible. That reverse sequence is also what **Show solution** plays back.
- **A fixed catalogue, not a difficulty ramp:** the ~40 puzzles draw their cube
  count and scramble depth independently and within bounded ranges (more cubes
  isn't obviously harder), rather than auto-creating ever-bigger boards.
- **Par accounts for herding:** because the cursor can't jump between disjoint
  clusters, scattered cubes must be rolled back together to win. The move budget
  is therefore set well above the raw scramble length (it scales with the cube
  count) so a puzzle stays beatable by hand.
- **True 3D rolling:** a roll rotates the cube 90° about its leading bottom
  edge. Because the cell spacing equals the cube size, the cube lands exactly on
  the next cell. The face shown on top is read back from the cube's orientation
  for win detection.

## Project layout

```
index.html         landing page: puzzle catalogue + difficulty sort, leaderboards
play.html          the game page (import map for Three.js) + HUD/overlay
login.html         sign-in / account page: username + passkey (WebAuthn) login
admin.html         admin page: user management + featured-puzzle pin/order
src/index.mjs      landing-page logic (catalogue grid, sorting, account, detail)
src/login.mjs      sign-in logic (username registration + passkey ceremonies)
src/admin.mjs      admin-page logic (users + puzzle pin/order)
src/main.js        game logic, rendering and roll animation (renders generateLevel)
src/level-gen.mjs  pure board generation: seeded scramble + quaternion/connectivity
src/api.mjs        resilient browser client for the backend API
src/shared.mjs     dependency-free puzzle catalogue + math shared by game + server
src/styles.css     HUD, landing page, admin and overlay styling
server/server.mjs  HTTP server: static files + JSON API (node:http)
server/db.mjs      SQLite data layer + analytics queries (node:sqlite)
server/webauthn.mjs WebAuthn/passkey helpers (challenge + verify)
test/api.mjs       backend API integration test (no browser)
test/smoke.mjs     end-to-end smoke test (Playwright, headless browser)
```

## Scope

Implemented: 5×5 board, bevelled dice, arrow-key cursor & rolling, animated
tip-over, **deterministic** solvable puzzle generation, contiguous-block win
condition, herding-aware move budget, carried bonus, Q/E view rotation,
show-solution playback, win/lose flow; a real **level-picker landing page**, an
optional **SQLite backend** with **username accounts** (optional **password
login** plus additive **passkey / WebAuthn login**), **leaderboards**, and per-attempt tracking
feeding **puzzle-difficulty** and **player-skill** stats. Best scores also
persist locally, so a brief server hiccup never blocks play. Deliberately left
out for now: sound, timer and undo.

## License

MIT
