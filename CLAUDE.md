# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**kCubeGL** is a 3D dice-rolling puzzle game playable in the browser using WebGL and Three.js. Players roll cubes on a 5×5 board to make all cubes show the same colour on top while forming a connected block, within a limited move budget.

Key features:
- True 3D rolling animation (cubes tip over with 90° rotations)
- Guaranteed-solvable, **deterministic** puzzles (reverse-scrambled from a solved board). Puzzles are a **fixed, named catalogue** — no level numbers, no infinite auto-create: a pool of ~40 puzzles with randomly generated names (e.g. `ochre-bramble`) and varied — *not* monotonically increasing — cube counts and scramble depths, all derived from one master seed so every player gets the same catalogue
- View rotation (Q/E keys) and solution playback
- A landing page (`index.html`) that lists the catalogue and lets you **sort by difficulty** (failure rate, world-best moves over scramble length, cube count, name), separate from the game page (`play.html?puzzle=<name>`)
- A **backend** (`server/`) using Node's built-in `node:sqlite` — the source of truth for the catalogue, username accounts (bearer-token sessions, with additive WebAuthn/passkey login and optional password login), leaderboards, per-attempt tracking that feeds puzzle-difficulty and player-skill stats, and an **admin** page to pin/order which puzzles are featured first. Submitting scores and fetching puzzles assume the server is there.
- A **tutorial system**: hand-authored levels (arbitrary board states + per-step hint annotations) stored in the DB and playable at `tutorial.html?t=<name>`. A **level designer** (`designer.html`) lets admins place cubes, roll them into starting orientations, record a solution sequence with per-step text hints, and save to the DB via the API. Tutorials can also be exported to JSON for version control.
- Best scores also persist in `localStorage` (keyed by puzzle name) as a client-side cache. The server is always expected to be reachable; the app does not need to degrade gracefully to an offline mode

## Commands

### Development & Testing

```bash
npm start              # Full app + API + SQLite on http://localhost:8080 (server/server.mjs)
npm run dev            # Static-only server (no backend; cold-start cache + localStorage): Python HTTP server on port 8080
npm run check          # Syntax-check all source + server files
npm test               # Unit + API integration + headless browser smoke tests
npm run test:unit      # Pure-logic unit tests (catalogue determinism, engine, solvers)
npm run test:api       # Backend API test only (no browser; fast)
npm run test:smoke     # Headless Playwright end-to-end test only
```

**Requires Node ≥ 22.5** for the backend (built-in `node:sqlite`; also declared in `package.json` `engines`). A build step and npm dependencies are fully accepted — wire any build into `npm run build` and ensure `npm run check`/`npm test` stay green. Currently ES modules are served directly and Three.js loads from a CDN, but that is not a constraint. The DB file `server/kcube.sqlite` is created on first run (gitignored). Set `KCUBE_DB=:memory:` for an ephemeral DB (the tests do this).

**Auth & deploy env vars:** `KCUBE_ADMIN_TOKEN` (a bootstrap secret) is the only way to mint an admin — `POST /api/users` grants admin only when its `adminToken` field matches it; if unset, no new admins can be created via the API. `KCUBE_TRUST_PROXY=1` (or `true`) tells the server to trust `X-Forwarded-Host`/`X-Forwarded-Proto` (used to derive the WebAuthn origin/RP-ID); set it behind a TLS-terminating reverse proxy or passkeys/origins will be wrong (it also makes rate limiting key on the last `X-Forwarded-For` entry — the one the trusted proxy appended). `KCUBE_RATE_LIMIT` overrides the per-minute cap for every rate-limit bucket (0 disables limiting; the tests set this).

## Codebase Structure

**Frontend (browser):**
- **index.html** — Landing page: the puzzle catalogue (with a difficulty sort control), sign-in, per-puzzle leaderboard/difficulty detail. Loads `src/index.mjs`.
- **play.html** — The game page: import map (Three.js 0.160.0), HUD (puzzle-name/moves/cubes/best/world badges), overlay panels, back-to-puzzles link. Loads `src/main.js`. Reads the puzzle from `?puzzle=<name>`.
- **login.html** — Sign-in / account page: username registration plus the WebAuthn/passkey register and login flow. Loads `src/login.mjs`.
- **admin.html** — Admin page: user management and the featured-puzzle pin/order UI. Loads `src/admin.mjs`.
- **settings.html** — Account settings page: link/clear a Gravatar email (only its hash is ever stored). Loads `src/settings.mjs`.
- **designer.html** — Admin-only level designer: place cubes on the 5×5 grid, roll them into starting orientations (using the real roll engine), record a solution sequence, annotate each step with hint text, save to the DB, and export to JSON. Loads `src/designer.mjs`.
- **tutorial.html** — Tutorial player: loads a tutorial by name (`?t=<name>`), renders the 3D board, and shows per-step hint overlays (text bubble + optional highlight). In guided mode only the required move is accepted. Loads `src/tutorial.mjs`.
- **src/main.js** — Game logic, rendering, roll animation, and the attempt lifecycle (reports start/win/lose/abandon to the backend; best-effort if it's briefly unreachable). Imports `generateLevel` from `src/level-gen.mjs` and renders its result — it no longer contains its own board-generation logic.
- **src/index.mjs** — Landing-page logic (account widget, catalogue grid + sorting, detail dialog).
- **src/login.mjs** — Sign-in page logic: username registration (with optional password), password login, and the passkey (WebAuthn) register/login ceremonies against the `/api/auth/*` endpoints.
- **src/admin.mjs** — Admin-page logic (user management incl. password resets; featured-puzzle pin/order UI with drag-to-reorder + unsaved-state indicator; the explicit "Run solver" step that fills in per-puzzle difficulty).
- **src/settings.mjs** — Settings page logic: set/clear the Gravatar email via `PATCH /api/me`.
- **src/api.mjs** — Browser client for the JSON API (token storage + fetch wrappers). The server is always assumed to be reachable; API failures surface as errors rather than silently degrading.
- **src/shared.mjs** — Dependency-free puzzle math (seeded PRNG, `buildCatalog`, `catalogByName`, `budgetFor`) plus the board constants (`BOARD`, `NEI`, `OPPOSITE`, `inBounds`) imported by BOTH the game and the server. Defines the deterministic catalogue. Must not import Three.js or touch the DOM.
- **src/level-gen.mjs** — Pure, dependency-free board generation: the single source of truth for the seeded scramble, quaternion math, and connectivity helpers. Exports `generateLevel(config)` and is imported by both `src/main.js` and `src/catalog-solve.mjs` (it imports the catalogue math from `src/shared.mjs`). Must stay pure (no Three.js, no DOM).
- **src/solver.mjs** — Pure-state solvers (no Three.js): `bfsSolve` (the provably-optimal "full solver" — internally A* over canonical packed states with an admissible heuristic, see the file header), `greedySolve`, `beamSolve` (approximate, tight upper bound; its expansion order is deliberately deterministic because its results feed the persisted difficulty signals), and `minBeamWidthToSolve` (the search-effort difficulty guide: smallest beam width that solves the board — a "how much planning a human needs" signal). Operate on a plain `{cubes:[{id,r,c,faces}], cursorId}` state.
- **src/catalog-solve.mjs** — Thin adapter over `src/level-gen.mjs` + the solvers: reproduces a catalogue puzzle's scrambled board via `generateLevel` (no reimplemented board build) and runs the solvers. Used by the server's admin solver step to compute real difficulty signals without Three.js, and by the server's win verification (`replayMoves`/`solutionCodes`: replay a recorded R/L/U/D cursor path against the deterministic board). Must stay pure.
- **src/designer.mjs** — Level designer logic: three-mode editor (place/orient/record), step annotation UI, save-to-DB and export-to-JSON.
- **src/tutorial.mjs** — Tutorial player logic: loads tutorial data from the API, drives the step-by-step hint overlay, and enforces guided-mode move filtering.
- **src/theme.mjs** — Light/dark theme: `setupTheme()` applies the saved/preferred theme and wires the header toggle button (each HTML page also carries a tiny inline pre-paint script so the theme applies before first render).
- **src/ui.mjs** — Browser-only DOM + formatting helpers (`$`, `esc`, `dash`, `pct`, `fmtMs`, `fmtDate`) shared by the page scripts. Kept separate from `src/shared.mjs`, which must stay server-safe.
- **src/styles.css** — HUD, landing page (with a Featured / All puzzles split), admin, overlay styling, and the light/dark CSS-variable themes.

**Backend (Node):**
- **server/server.mjs** — `node:http` server: serves static files and routes `/api/*` to JSON handlers.
- **server/db.mjs** — `node:sqlite` data layer: schema, catalogue seeding (`seedCatalog`) and all queries, including the leaderboard, puzzle-difficulty and player-skill aggregates.
- **server/webauthn.mjs** — WebAuthn/passkey helpers (challenge generation, registration and assertion verification) backing the `/api/auth/passkey/*` endpoints.
- **server/password.mjs** — Password hashing with `node:crypto` scrypt. Stores self-describing `scrypt:N:r:p:salt:hash` strings; verification is constant-time and never throws.

**Testing:**
- **test/unit.mjs** — Pure-logic tests (no server, no browser): catalogue determinism snapshots (with full-catalogue solvability replay), engine/quaternion behaviour and solver invariants.
- **test/api.mjs** — Boots the server against an in-memory DB and drives the API with `fetch` (no browser). The fast, primary backend test.
- **test/smoke.mjs** — Boots the real server + a headless browser: landing → sign in → play → solution playback; asserts an attempt was recorded and that nothing logged a console/page/network error.
- **test/bench-solver.mjs** — Manual (not in `npm test`): times the solvers on real catalogue boards and prints a fingerprint of every beam solution. Run it before/after touching `src/solver.mjs` — the fingerprints must not change, or persisted difficulty signals would drift.

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

**Deterministic per puzzle:** `generateLevel(config)` (in `src/level-gen.mjs`, the single shared source of truth for board generation) seeds a PRNG (`rng = mulberry32(config.seed)`) and draws *every* random choice in board generation from it (`rint`, `shuffle`). So a given puzzle is the **identical board on every device** — the prerequisite for comparable best-scores and meaningful per-puzzle difficulty. Do not reintroduce `Math.random()` into the generation path. The catalogue lives in `src/shared.mjs` so the server seeds the same puzzles (`db.seedCatalog()`) without the game engine.

**Move Budget:** `budgetFor(numCubes, scramble)` = scramble + 3·cubes + 4, set well above the raw sequence length to account for "herding" scattered cubes back together (cursor can't jump between disjoint clusters). `game.par` is the bonus-free budget; `game.optimal` is the solution length — both informed by the catalogue / reported to the backend.

### Persistence

- **Local best scores**: `localStorage` under key `kcube.v1` as `{ best: { <puzzleName>: movesUsed }, cleared }`. Client-side cache kept in sync with the server; the server is the authoritative source.
- **Auth token**: `localStorage` key `kcube.token` (a bearer token minted by `POST /api/users`).
- **Backend**: SQLite via `server/db.mjs`. The schema is **attempt-centric** — one `attempts` row per started board, stamped with an outcome (`won`/`lost`/`abandoned`), `moves_used` and `duration_ms`. **Wins are replay-verified**: the server replays the submitted `move_seq` (the player's R/L/U/D cursor path) against its own copy of the deterministic board (`replayMoves` in `src/catalog-solve.mjs`) and accepts the win only if the sequence is legal, ends solved, and its paid roll count equals `moves_used`. Best-scores are `MIN(moves_used)` over winning attempts; difficulty and skill are aggregates over the same rows.

### Backend & Data Model

- **Tables**: `users(id, username, username_lower UNIQUE, token UNIQUE, is_admin, avatar_hash, password_hash, …)` (`token` holds the **sha256 of the bearer token**, never the token itself — a DB dump must not hand out live sessions; the plaintext exists only in the response that minted it) (`avatar_hash` is the Gravatar hash derived from a player's email — we hash the email and store **only** the hash, never the raw address; non-null ⇒ they supplied an email. `password_hash` is a scrypt hash from `server/password.mjs`; null ⇒ no password login), `puzzles(id PK, name UNIQUE, seed, num_cubes, scramble, par, optimal, pinned, sort_order, full_optimal, beam_moves, min_beam_width, solved_at, …)` (`full_optimal`/`beam_moves`/`min_beam_width`/`solved_at` hold the admin-run solver difficulty signals; `min_beam_width` is the search-effort guide), `attempts(id, user_id, puzzle_id, outcome, moves_used, duration_ms, move_seq, started_at, ended_at)`, `tutorials(id PK, name UNIQUE, title, initial_board_json, steps_json, mode, sort_order, created_at, updated_at)` (`initial_board_json` is a JSON array of `{r,c,q:[x,y,z,w]}` cube states; `steps_json` is a JSON array of `{hint, required, highlightCell}` objects; `mode` is `"guided"` or `"hint"`). The puzzle **`id` is the opaque key** everything references; `name` is the stable public handle. `seedCatalog()` idempotently inserts the catalogue (matched on `name`) on every `openDb`.
- **Identity**: puzzles are addressed by `name` in URLs and the API; the server resolves a name to its `id` for FKs. No level numbers anywhere.
- **Attempt lifecycle** (in `src/main.js`): `beginAttempt()` → `POST /api/attempts {puzzle}` on entering a board; `finalizeAttempt(outcome)` → `PATCH /api/attempts/:id` on win/lose, and `"abandoned"` on retry / leaving (a `sendBeacon` to `/abandon` covers page unload).
- **Auth**: `POST /api/users {username, adminToken?, email?, password?}` registers a username and returns a bearer token; admin is granted only when `adminToken` matches the server's `KCUBE_ADMIN_TOKEN` (never "first user wins"). A password is optional (8–128 chars, hashed with scrypt via `server/password.mjs`); `POST /api/auth/password/login {username, password}` mints and returns a **fresh** bearer token (tokens are stored hashed, so the old one can't be echoed back — each login rotates it, one live session per account), with a constant-time dummy-hash verify so timing can't enumerate usernames. Passkeys are additive on top of bearer tokens: `POST /api/auth/passkey/{register,login}/{options,verify}` run the WebAuthn ceremonies, and a successful passkey login also mints and returns a fresh bearer token (same rotation as password login).
- **Key endpoints**: `POST /api/users`, `GET /api/me`, `GET /api/me/stats`, `GET /api/puzzles` (full catalogue, pinned first, with difficulty signals), `GET /api/puzzles/:name` (metadata + leaderboard + difficulty stats), `POST /api/attempts`, `PATCH /api/attempts/:id`. **Tutorials (public)**: `GET /api/tutorials` (list all), `GET /api/tutorials/:name` (full tutorial data for the player). **Admin**: `GET /api/admin/users`, `PATCH /api/admin/users/:id {isAdmin}`, `DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/reset-password {newPassword}` (null/empty clears password login), `GET /api/admin/puzzles`, `PUT /api/admin/puzzles/order {ids}` (set the pinned/featured order), `PATCH /api/admin/puzzles/:id {pinned, sortOrder}`, `POST /api/admin/puzzles/:id/solve` (explicit, admin-triggered: runs the full/BFS + beam solvers and the search-effort probe for that board via `src/catalog-solve.mjs` and persists `full_optimal`/`beam_moves`/`min_beam_width`/`solved_at`). Solving is slow on the hardest boards, so it is never run at boot — only on demand. `GET /api/admin/tutorials`, `POST /api/admin/tutorials` (create), `PUT /api/admin/tutorials/:name` (full replace / save from designer), `DELETE /api/admin/tutorials/:name`, `GET /api/admin/tutorials/:name/export` (returns the tutorial as a downloadable JSON file).
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
- `game.cubes`: a flat array of Cube objects (not a 2D board grid)
- `game.selected`: an integer index into `game.cubes` for the current cursor (not a position object)
- `moves`, `movesLeft`: move tracking
- `game.solving`: flag during solution playback
- Scores fetched from localStorage on load; updated after each win

### Animation
Rolls interpolate the rotation with an **ease-in-out cubic** over `ROLL_MS`
(there is no `lerpQuaternion` helper). The roll rotation is built with
`THREE.Quaternion.setFromAxisAngle` and applied to the cube's orientation:
```js
progress = (now - startTime) / ROLL_MS  // 0 to 1, then eased in/out
```
Other animations (overlay fade, cube scale on win) use CSS transitions.

## Important Constraints

- **Dependencies and a build step are the norm** — npm packages, a bundler, or other build tooling are all fine. Wire any build into `npm run build` and keep `npm run check`/`npm test` green. Currently Three.js loads from a CDN and the server uses Node built-ins, but that is not a hard constraint — adopt better libraries or tooling when they earn their keep.
- **Node ≥ 22.5** — the backend uses the built-in `node:sqlite` module. CI runs on Node 22.
- **Shared code stays pure** — `src/shared.mjs` is imported by both browser and server, so it must not import Three.js or touch the DOM.
- **Always-online** — the app assumes the server is always reachable. There is no offline mode, no cold-start cache fallback, and no requirement for API calls to silently no-op on failure. Surface errors to the user when the server is unreachable instead of hiding them.
- **Deterministic puzzles** — keep all catalogue and board-generation randomness on the seeded PRNGs (`CATALOG_SEED` in `buildCatalog`, `config.seed` in `generateLevel`); never `Math.random()` in those paths, or puzzles/names diverge across users and leaderboards break.
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
