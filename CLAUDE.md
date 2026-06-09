# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**kCubeGL** is a 3D dice-rolling puzzle game playable in the browser using WebGL and Three.js. Players roll cubes on a 5×5 board to make all cubes show the same colour on top while forming a connected block, within a limited move budget.

Key features:
- True 3D rolling animation (cubes tip over with 90° rotations)
- Guaranteed-solvable, **deterministic** puzzles (reverse-scrambled from a solved board). Puzzles are a **fixed, named catalogue** — no level numbers, no infinite auto-create: a pool of ~40 puzzles with randomly generated names (e.g. `ochre-bramble`) and varied — *not* monotonically increasing — cube counts and scramble depths, all derived from one master seed so every player gets the same catalogue
- View rotation (Q/E keys) and solution playback
- A landing page (`index.html`) that lists the catalogue and lets you **sort by difficulty** (failure rate, world-best moves over scramble length, cube count, name), separate from the game page (`play.html?puzzle=<name>`)
- An **optional backend** (`server/`) using Node's built-in `node:sqlite`: username accounts (bearer-token auth), leaderboards, per-attempt tracking that feeds puzzle-difficulty and player-skill stats, and an **admin** page to pin/order which puzzles are featured first
- Best scores persist in `localStorage` (keyed by puzzle name); the game runs fully even with no backend (the API client degrades gracefully)

## Commands

### Development & Testing

```bash
npm start              # Full app + API + SQLite on http://localhost:8080 (server/server.mjs)
npm run static         # Static-only server (no backend; localStorage fallback)
npm run dev            # Alternative static server: Python HTTP server on port 8080
npm run check          # Syntax-check all source + server files
npm test               # API integration test + headless browser smoke test
npm run test:api       # Backend API test only (no browser; fast)
npm run test:smoke     # Headless Playwright end-to-end test only
```

**Requires Node ≥ 22.5** for the backend (built-in `node:sqlite`). No build step and no native dependency: ES modules are served directly, Three.js loads from a CDN at runtime, and the server uses only Node built-ins. The DB file `server/kcube.sqlite` is created on first run (gitignored). Set `KCUBE_DB=:memory:` for an ephemeral DB (the tests do this).

## Codebase Structure

**Frontend (browser):**
- **index.html** — Landing page: the puzzle catalogue (with a difficulty sort control), sign-in, per-puzzle leaderboard/difficulty detail. Loads `src/index.mjs`.
- **play.html** — The game page: import map (Three.js 0.160.0), HUD (puzzle-name/moves/cubes/best/world badges), overlay panels, back-to-puzzles link. Loads `src/main.js`. Reads the puzzle from `?puzzle=<name>`.
- **src/main.js** — All game logic, rendering, roll animation, and the attempt lifecycle (reports start/win/lose/abandon to the backend, offline-safe).
- **src/index.mjs** — Landing-page logic (account widget, catalogue grid + sorting, detail dialog).
- **src/admin.mjs** — Admin-page logic (user management + featured-puzzle pin/order UI).
- **src/api.mjs** — Offline-safe browser client for the JSON API (token storage + fetch wrappers; every call no-ops to null with no server).
- **src/shared.mjs** — Dependency-free puzzle math (seeded PRNG, `buildCatalog`, `catalogByName`, `budgetFor`) imported by BOTH the game and the server. Defines the deterministic catalogue. Must not import Three.js or touch the DOM.
- **src/styles.css** — HUD, landing page, admin, and overlay styling.

**Backend (Node):**
- **server/server.mjs** — `node:http` server: serves static files and routes `/api/*` to JSON handlers.
- **server/db.mjs** — `node:sqlite` data layer: schema, catalogue seeding (`seedCatalog`) and all queries, including the leaderboard, puzzle-difficulty and player-skill aggregates.

**Testing:**
- **test/api.mjs** — Boots the server against an in-memory DB and drives the API with `fetch` (no browser). The fast, primary backend test.
- **test/smoke.mjs** — Boots the real server + a headless browser: landing → sign in → play → solution playback; asserts an attempt was recorded and that nothing logged a console/page/network error.

## Architecture: Core Concepts

### Board & Cubes

- **Board**: 5×5 grid; cubes occupy cells indexed by (row, col)
- **Cube State**: `{ r, c, q }` where q is a Quaternion (THREE.Quaternion) encoding the 3D orientation
- **Cell Spacing = Cube Size** (S = 1.0): ensures a rolling cube lands exactly on the next cell

### Rolling & Orientation

Rolls are **true 3D tip-overs** (not just color swaps):
1. A roll applies a 90° rotation about an edge of the cube's bottom face
2. The rotation axis and angle are pre-computed in `DIRS` (ArrowRight/Left/Up/Down) based on direction
3. The cube's quaternion is updated; the visible top face is derived from its orientation
4. The animation smoothly interpolates the rotation over 170ms (ROLL_MS)

**Face Mapping:** `FACE_AXES` maps local cube axes (+X→red, -X→orange, +Y→white, etc.) to colors. The "solved" state has white face-up (identity orientation).

### Puzzle Catalogue, Generation & Solvability

Puzzles are **generated backwards**: start with a solved board (all cubes one colour up, forming a connected block), apply random reverse-rolls, then store the **exact reverse sequence** as the solution. This guarantees solvability: playing the stored reverse sequence undoes the scramble.

**A fixed, named catalogue:** `buildCatalog()` in `src/shared.mjs` derives a pool of ~40 puzzle definitions `{ name, seed, numCubes, scramble, par, order }` from one master seed (`CATALOG_SEED`). Cube count (2–16) and scramble depth (4–30) are drawn **independently** and within a bounded range — deliberately *not* monotonically increasing, since more cubes is not obviously harder. Names are random adjective-noun handles (deduped) and are the **public key** used in URLs and as the localStorage best-score key. There is **no level numbering and no auto-create** of ever-bigger boards.

**Deterministic per puzzle:** `buildLevel(config)` seeds a PRNG (`rng = mulberry32(config.seed)`) and draws *every* random choice in board generation from it (`rint`, `shuffle`). So a given puzzle is the **identical board on every device** — the prerequisite for comparable best-scores and meaningful per-puzzle difficulty. Do not reintroduce `Math.random()` into the generation path. The catalogue lives in `src/shared.mjs` so the server seeds the same puzzles (`db.seedCatalog()`) without the game engine.

**Move Budget:** `budgetFor(numCubes, scramble)` = scramble + 3·cubes + 4, set well above the raw sequence length to account for "herding" scattered cubes back together (cursor can't jump between disjoint clusters). `game.par` is the bonus-free budget; `game.optimal` is the solution length — both informed by the catalogue / reported to the backend.

### Persistence

- **Local best scores**: `localStorage` under key `kcube.v1` as `{ best: { <puzzleName>: movesUsed }, cleared }`. Works with no backend.
- **Auth token**: `localStorage` key `kcube.token` (a bearer token minted by `POST /api/users`).
- **Backend (optional)**: SQLite via `server/db.mjs`. The schema is **attempt-centric** — one `attempts` row per started board, stamped with an outcome (`won`/`lost`/`abandoned`), `moves_used` and `duration_ms`. Best-scores are `MIN(moves_used)` over winning attempts; difficulty and skill are aggregates over the same rows.

### Backend & Data Model

- **Tables**: `users(id, username, username_lower UNIQUE, token UNIQUE, is_admin, …)`, `puzzles(id PK, name UNIQUE, seed, num_cubes, scramble, par, optimal, pinned, sort_order, …)`, `attempts(id, user_id, puzzle_id, outcome, moves_used, duration_ms, move_seq, started_at, ended_at)`. The puzzle **`id` is the opaque key** everything references; `name` is the stable public handle. `seedCatalog()` idempotently inserts the catalogue (matched on `name`) on every `openDb`.
- **Identity**: puzzles are addressed by `name` in URLs and the API; the server resolves a name to its `id` for FKs. No level numbers anywhere.
- **Attempt lifecycle** (in `src/main.js`): `beginAttempt()` → `POST /api/attempts {puzzle}` on entering a board; `finalizeAttempt(outcome)` → `PATCH /api/attempts/:id` on win/lose, and `"abandoned"` on retry / leaving (a `sendBeacon` to `/abandon` covers page unload).
- **Key endpoints**: `POST /api/users`, `GET /api/me`, `GET /api/me/stats`, `GET /api/puzzles` (full catalogue, pinned first, with difficulty signals), `GET /api/puzzles/:name` (metadata + leaderboard + difficulty stats), `POST /api/attempts`, `PATCH /api/attempts/:id`. **Admin**: `GET /api/admin/users`, `GET /api/admin/puzzles`, `PUT /api/admin/puzzles/order {ids}` (set the pinned/featured order), `PATCH /api/admin/puzzles/:id {pinned, sortOrder}`.
- **Analytics queries** live in `server/db.mjs`: `leaderboard`, `puzzleStats` (win/fail rate, avg attempts to first solve / to personal best), `userStats` (solve rate, avg moves over best-known, avg solve time), `listPuzzles` (catalogue + per-puzzle difficulty signals for the landing page).

### Win Condition

All cubes must:
1. Show the same color on top (by orientation)
2. Form a single connected block (every cube touching another via N/S/E/W adjacency)

## Implementation Details

### Three.js Setup
- Canvas rendered to `#scene` via requestAnimationFrame
- Camera orbits the board; Q/E keys rotate around the vertical (Y) axis
- Cubes use `RoundedBoxGeometry` with canvas-based face textures (rounded squares on dark backgrounds for seam visibility)

### Input Handling
- Arrow keys: roll the selected cube or switch selection to adjacent cubes
- Q/E: rotate the view
- R: retry the same puzzle (restores the snapshotted scrambled start; opens a new attempt)
- S: show solution (replay the stored reverse sequence)
- Enter/Space: dismiss panels or advance to the next puzzle
- M or click "Puzzles": navigate back to the landing page (`index.html`)

### State Management
All game state is global (no framework):
- `board`: 2D array of cube objects or null
- `moves`, `movesLeft`: move tracking
- `selectedCube`: current cursor position
- `isPlayingSolution`: flag during solution playback
- Scores fetched from localStorage on load; updated after each win

### Animation
Rolls use `Tween.js`-style linear interpolation (manually, without a library):
```js
progress = (now - startTime) / ROLL_MS  // 0 to 1
lerpQuaternion(startQ, targetQ, progress)
```
Other animations (overlay fade, cube scale on win) use CSS transitions.

## Important Constraints

- **No bundler or build step** — serves as raw ES modules; Three.js must be available at runtime. The backend likewise uses only Node built-ins (no native deps), preserving the no-install spirit.
- **Node ≥ 22.5** — the backend depends on the built-in `node:sqlite` module. CI runs on Node 22.
- **Shared code stays pure** — `src/shared.mjs` is imported by both browser and server, so it must not import Three.js or touch the DOM.
- **Backend is optional** — `src/api.mjs` calls must remain offline-safe (no-op to null on failure); the game must stay fully playable as static files on `localStorage`.
- **Deterministic puzzles** — keep all catalogue and board-generation randomness on the seeded PRNGs (`CATALOG_SEED` in `buildCatalog`, `config.seed` in `buildLevel`); never `Math.random()` in those paths, or puzzles/names diverge across users and leaderboards break.
- **Single event loop** — async game operations (renders, animations, level transitions) are orchestrated via frame callbacks
- **Quaternion arithmetic** — rotations are applied via quaternion multiplication; understanding quaternion order (q1 * q2 applies q2 first) is essential for correct roll behavior
- **Board bounds checking** — many loops and adjacency checks use `inBounds(r, c)` to prevent out-of-bounds errors
- **Immutability for undo** — the solution playback requires replaying a stored move sequence; the board must be resetable to its scrambled state

## Debugging Tips

1. **Check console errors** — WebGL context failures or Three.js warnings appear here
2. **Inspect cube orientation** — log a cube's quaternion and call `cube.q.toArray()` to see its state
3. **Trace rolls** — add logging in the roll handler to see which cells are occupied, which moves are valid
4. **Test level generation** — seed a level with a fixed random seed to reproduce scrambles; adjust move count to verify solvability
5. **Browser DevTools** — inspect the Three.js scene (`scene.children`) and check for culled or invisible cubes
