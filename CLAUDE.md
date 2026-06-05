# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**kCubeGL** is a 3D dice-rolling puzzle game playable in the browser using WebGL and Three.js. Players roll cubes on a 5×5 board to make all cubes show the same colour on top while forming a connected block, within a limited move budget.

Key features:
- True 3D rolling animation (cubes tip over with 90° rotations)
- Guaranteed-solvable, **deterministic** levels (reverse-scrambled from a solved board, seeded by the level number so level N is the same puzzle for everyone)
- View rotation (Q/E keys) and solution playback
- A landing page (`index.html`) that is a real level picker, separate from the game page (`play.html?level=N`)
- An **optional backend** (`server/`) using Node's built-in `node:sqlite`: username accounts (bearer-token auth), leaderboards, and per-attempt tracking that feeds puzzle-difficulty and player-skill stats
- Best scores persist in `localStorage`; the game runs fully even with no backend (the API client degrades gracefully)

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
- **index.html** — Landing page: level grid, sign-in, per-level leaderboard/difficulty detail. Loads `src/index.mjs`.
- **play.html** — The game page: import map (Three.js 0.160.0), HUD (level/moves/cubes/best/world badges), overlay panels, back-to-levels link. Loads `src/main.js`. Reads the level from `?level=N`.
- **src/main.js** — All game logic, rendering, roll animation, and the attempt lifecycle (reports start/win/lose/abandon to the backend, offline-safe).
- **src/index.mjs** — Landing-page logic (account widget, grid, detail dialog).
- **src/api.mjs** — Offline-safe browser client for the JSON API (token storage + fetch wrappers; every call no-ops to null with no server).
- **src/shared.mjs** — Dependency-free level math (seeded PRNG, `levelParams`, `baseBudget`) imported by BOTH the game and the server. Must not import Three.js or touch the DOM.
- **src/styles.css** — HUD, landing page, and overlay styling.

**Backend (Node):**
- **server/server.mjs** — `node:http` server: serves static files and routes `/api/*` to JSON handlers.
- **server/db.mjs** — `node:sqlite` data layer: schema/migrations and all queries, including the leaderboard, puzzle-difficulty and player-skill aggregates.

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

### Level Generation & Solvability

Levels are **generated backwards**: start with a solved board (all cubes white-up, forming a connected block), apply random reverse-rolls, then store the **exact reverse sequence** as the solution. This guarantees solvability: playing the stored reverse sequence undoes the scramble.

**Deterministic per level:** `buildLevel(level)` seeds a PRNG (`rng = levelRng(level)` from `src/shared.mjs`) and draws *every* random choice in generation from it (`rint`, `shuffle`). So level N is the **identical board on every device** — the prerequisite for comparable best-scores and meaningful per-puzzle difficulty. Do not reintroduce `Math.random()` into the generation path. `levelParams`/`baseBudget` live in `src/shared.mjs` so the server computes the same metadata without the game engine.

**Move Budget:** Scales with cube count and scramble length; set well above the raw sequence length to account for "herding" scattered cubes back together (cursor can't jump between disjoint clusters). `game.par` is the bonus-free budget; `game.optimal` is the solution length — both reported to the backend.

### Persistence

- **Local best scores**: `localStorage` under key `kcube.v1` as `{ best: { level: movesUsed }, cleared, maxLevel }`. Works with no backend.
- **Auth token**: `localStorage` key `kcube.token` (a bearer token minted by `POST /api/users`).
- **Backend (optional)**: SQLite via `server/db.mjs`. The schema is **attempt-centric** — one `attempts` row per started board, stamped with an outcome (`won`/`lost`/`abandoned`), `moves_used` and `duration_ms`. Best-scores are `MIN(moves_used)` over winning attempts; difficulty and skill are aggregates over the same rows.

### Backend & Data Model

- **Tables**: `users(id, username, username_lower UNIQUE, token UNIQUE, …)`, `levels(level PK, num_cubes, scramble, par, optimal, …)`, `attempts(id, user_id, level, outcome, moves_used, duration_ms, started_at, ended_at)`.
- **Attempt lifecycle** (in `src/main.js`): `beginAttempt()` → `POST /api/attempts` on entering a board; `finalizeAttempt(outcome)` → `PATCH /api/attempts/:id` on win/lose, and `"abandoned"` on retry / leaving (a `sendBeacon` to `/abandon` covers page unload).
- **Key endpoints**: `POST /api/users`, `GET /api/me`, `GET /api/me/stats`, `GET /api/levels?count=`, `GET /api/levels/:level` (metadata + leaderboard + difficulty stats), `POST /api/attempts`, `PATCH /api/attempts/:id`.
- **Analytics queries** live in `server/db.mjs`: `leaderboard`, `levelStats` (win rate, avg attempts to first solve / to personal best), `userStats` (solve rate, avg moves over best-known, avg solve time).

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
- Enter/Space: dismiss panels or advance levels
- M or click "Levels": navigate back to the landing page (`index.html`)

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
- **Deterministic levels** — keep all generation randomness on the seeded `rng`; never `Math.random()` in the generation path, or levels diverge across users and leaderboards break.
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
