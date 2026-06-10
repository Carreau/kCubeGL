# plan.md

Project status, scope, and future considerations for kCubeGL.

## Current Scope (v2 — adds a backend)

### Implemented
- ✅ 5×5 board, bevelled dice, arrow-key cursor with 4-direction rolling
- ✅ Animated tip-over (true 3D quaternion rotations)
- ✅ Guaranteed-solvable level generation (reverse-scrambling)
- ✅ **Deterministic puzzles** — a fixed, named catalogue (~40 puzzles) derived from one master seed; each board is seeded by its puzzle's own seed, so a given puzzle is the same board for everyone (basis for fair leaderboards). No level numbers anywhere.
- ✅ Contiguous-block win condition (connectivity + same color)
- ✅ Move budget economy + carried move bonus
- ✅ Q/E view rotation, solution playback
- ✅ Best-score persistence (localStorage) — works with no backend
- ✅ Win/lose flow
- ✅ **Real landing page** (`index.html`) — puzzle grid with your best / world best, sign-in, per-puzzle leaderboard + difficulty detail; game lives at `play.html?puzzle=<name>`
- ✅ **SQLite backend** (`node:sqlite`, no native deps) — `server/server.mjs` serves the game + a JSON API
- ✅ **Username accounts** (bearer-token; optional password login, plus passkeys)
- ✅ **Leaderboards** (fewest moves per puzzle, tie-broken by time)
- ✅ **Per-attempt tracking** (won / lost / abandoned, moves, duration) → puzzle-difficulty and player-skill aggregates
- ✅ Tests: unit (`test/unit.mjs`: catalogue determinism, engine, solvers) + API integration (`test/api.mjs`) + headless browser smoke (`test/smoke.mjs`)

### Deliberately Out of Scope
- ❌ **Self-serve account recovery** — passwords and passkeys exist, but a lost token with no password/passkey set still means asking an admin (password reset) or picking a new name
- ❌ **Sound / Timer-pressure / Undo**
- ❌ **Difficulty progression** — move budget does not ramp from measured difficulty yet (the data to drive it now exists)
- ❌ **Mobile touch controls**
- ❌ **Accessibility** — limited ARIA / screen-reader support

## Known Limitations

1. **Move Budget Calculation**: Simple heuristic; the backend now collects the attempt/move data needed to refine it from measured difficulty
2. **Random Scrambling**: Naive random reverse-rolls (seeded/deterministic per puzzle); no explicit difficulty targeting yet
3. **View Rotation**: Continuous (Q/E hold), not snapped; can be disorienting
4. **Cube Selection**: Cursor can only move between physically adjacent cubes
5. **Account Recovery**: A lost token (cleared localStorage) is only recoverable if a password or passkey was set; otherwise an admin reset or a new name
6. **Three.js Dependency on CDN**: Game won't load if unpkg.com is unavailable or slow

## Potential Future Enhancements

### Short-term (Low effort, high value)
- [ ] **Undo/Redo** — Store move history; allow player to step back
- [ ] **Difficulty Selector** — Pre-set move budgets (Easy, Normal, Hard)
- [ ] **Sound Effects** — Web Audio API for roll, win, level-complete
- [ ] **Mobile Touch** — Swipe/tap controls for mobile browsers
- [ ] **Level Thumbnails** — Preview board layout in level picker
- [ ] **Per-Color Best Scores** — Track which colour each best was won with + a best per colour, with a colour-target selector for replayability (see "Planned Feature: Per-Color Best Scores" below)

### Medium-term
- [ ] **Systematic Difficulty Ramp** — Use the now-collected attempt/move data to assign each level a measured difficulty tier and tune its move budget
- [ ] **Accessibility** — ARIA labels, keyboard-only navigation, high-contrast mode
- [~] **Statistics Dashboard** — Per-level difficulty + per-player skill summaries exist on the landing page; a fuller history/trend view is still open
- [ ] **Custom Boards** — Level editor or procedural generation beyond reverse-scrambling
- [ ] **Multiplayer** — Local pass-and-play or real-time competitive modes

### Long-term
- [x] **Backend Leaderboard** — Scores persisted to SQLite; per-level global rankings ✅
- [ ] **Cloud Saves** — Sync progress across devices (password/passkey login now makes this possible)
- [ ] **Themes** — Custom cube colors, board styles, UI skins
- [ ] **3D Model Import** — Replace procedural cubes with custom 3D assets
- [ ] **Larger Boards** — 6×6, 7×7 or variable sizes

## Planned Feature: Per-Color Best Scores

**Goal:** boost replayability by letting a player re-challenge a puzzle under a
self-imposed constraint — *finish with a specific colour on top*. Today the win
condition (`src/main.js`, `winCheck`) accepts **any** uniform top colour: all
cubes simply have to match `cubes[0].topColor`. So every solve already *has* a
winning colour; we just don't record which one. The idea is to track, per puzzle:
- the **overall best** (fewest moves, any colour) — as today, plus **which colour**
  that best was achieved with;
- the **best for each of the 6 colours** independently (white/yellow/red/orange/
  blue/green — ids 0–5, see `COLORS` / `FACE_AXES` in `src/main.js`).

A player can then pick a target colour and try to match the per-colour record,
giving each board up to 6 extra mini-challenges.

### Data model (server, `server/db.mjs`)
- Record the winning colour on every won attempt: add `win_color INTEGER` to the
  `attempts` table (nullable; only set when `outcome = 'won'`). Migrate with an
  idempotent `ALTER TABLE … ADD COLUMN` guarded by a `PRAGMA table_info` check so
  existing DBs upgrade cleanly (old rows stay `NULL` = "colour unknown").
- Best-per-colour is then a `MIN(moves_used) … GROUP BY win_color` over winning
  attempts — no denormalised table needed. Add helpers alongside
  `bestForUser` / `worldBest`:
  - `bestByColor(puzzleId)` → `{ [colorId]: { best, userId, username } }`
  - `userBestByColor(userId, puzzleId)` → `{ [colorId]: best }`
  - extend `leaderboard()` / `puzzleStats()` to expose the overall best's colour.
- Index: extend the won index to `(puzzle_id, win_color, moves_used)` (or add a
  second index) so per-colour bests stay cheap.

### Attempt lifecycle (client, `src/main.js`)
- `winCheck` already knows the winning colour (`cubes[0].topColor`). Capture it
  and thread it into `finalizeAttempt("won")` so the `PATCH /api/attempts/:id`
  body carries `winColor`. Keep it best-effort/offline-safe like the rest of the
  API calls.
- `localStorage` (`kcube.v1`): widen `best` from `{ [name]: moves }` to also hold
  per-colour records, e.g. `{ [name]: { best, color, byColor: { [id]: moves } } }`.
  Keep backward-compatible reads (a bare number = legacy overall best).

### API (`server/server.mjs`, `src/api.mjs`)
- `GET /api/puzzles/:name` — include `bestByColor` + the overall best's colour in
  the response next to the existing leaderboard/difficulty payload.
- `PATCH /api/attempts/:id` — accept and persist `winColor`.
- Mirror these in the resilient client wrappers in `src/api.mjs` (no-op to null on
  failure, as elsewhere).

### UI
- **Game page (`play.html` / `src/main.js`):** a colour-target selector (six
  swatches, "any" default). Selecting a colour updates the HUD "best" badge to
  that colour's record and shows the target swatch; winning with a non-target
  colour still counts as a generic win but doesn't beat the chosen challenge.
  (Open question: should an off-target finish *block* the win, or just not count
  toward that colour's record? Lean toward the latter — never make a board harder
  to merely clear.)
- **Landing page (`index.html` / `src/index.mjs`):** in the per-puzzle detail
  dialog, show the 6 per-colour bests (swatch + moves + holder) beside the overall
  leaderboard.
- Centralise the colour list/names so the landing page and any pure code don't
  duplicate `COLORS` — candidate: a small exported table in `src/shared.mjs`
  (kept Three.js-free) that `src/main.js` maps to hex/materials.

### Admin solver (`src/admin.mjs`, `src/catalog-solve.mjs`, `server/db.mjs`)
- The solver currently finds the shortest solve to the puzzle's natural solved
  colour. Extend `catalog-solve.mjs` to solve for **each** of the 6 target colours
  (rotate the goal test in `bfsSolve`/`beamSolve` so "solved" means "all cubes show
  colour K up", for K = 0..5), and persist the per-colour optimal/beam counts so
  the per-colour challenges have a known world-best baseline.
- Storage: add `full_optimal_by_color` / `beam_by_color` (JSON text columns) on
  `puzzles`, written by `POST /api/admin/puzzles/:id/solve`. Solving 6 goals is
  ~6× the work, so keep it on-demand/admin-triggered only (never at boot), as now.

### Tests
- `test/api.mjs`: a won attempt with `winColor` is recorded; `bestByColor` reflects
  it; the per-colour `MIN` is correct across multiple users/colours.
- `test/smoke.mjs`: selecting a colour target updates the HUD best badge.

### Rollout order (when we start)
1. DB column + migration + `bestByColor`/`userBestByColor` helpers (+ API tests).
2. Thread `winColor` through finalize/PATCH + localStorage schema bump.
3. API surfacing on `GET /api/puzzles/:name` + `src/api.mjs` wrappers.
4. Game-page colour selector + HUD wiring.
5. Landing-page per-colour bests in the detail dialog.
6. Admin solver per-colour baselines (last; heaviest, fully optional).

## Difficulty Modeling (solver-based)

The goal is a **difficulty guide for ordering/pinning** that reflects how hard a
puzzle is *for a human to play*, not just its optimal length. Optimal length
measures the puzzle; difficulty is about how hard a bounded-rationality player
has to work to find a good-enough solution. Computed by the explicit, admin-
triggered solver run (`POST /api/admin/puzzles/:id/solve` → `src/catalog-solve.mjs`),
which reproduces the exact board without Three.js and runs the pure solvers in
`src/solver.mjs`. Values persist on `puzzles` and show in the admin panel.

### Implemented
- ✅ **Full solver (BFS-optimal)** — `bfsSolve`; the provably-shortest roll count
  (null on the hardest boards, where it exceeds its node budget).
- ✅ **Beam approximate** — `beamSolve`; a tight upper bound that solves boards
  plain greedy gets stuck on (greedy alone solved 11/40; beam solves 40/40).
- ✅ **Search-effort guide (#1)** — `minBeamWidthToSolve`: the *minimum beam width*
  at which the bounded-rationality beam first solves the board. width 1 ≈ no
  planning (easy); a wide beam means the obvious moves keep dead-ending, so a
  human must plan far ahead (hard). Across the catalogue it spreads cleanly
  (width 1→32) and surfaces what optimal length misses — e.g. boards that are
  easy to *find* a solution for but whose greedy path blows the move budget.

### Roadmap
- [ ] **Friction-weighted cost model (#2)** — a weighted A*/beam where each move's
  cost reflects cognitive effort, so the solver's path is closer to careful human
  play and its total "effort" is the difficulty score. Frictions to encode (also
  the things that make *this* game hard):
  - **Color ambiguity** — penalty when two colours tie for the majority target.
  - **Herding distance** — Σ taxicab distance of cubes to their cluster centroid;
    the cursor-can't-jump-islands rule makes scattered cubes brutal for humans.
  - **Connectivity fragility** — count **articulation points** of the island
    graph; rolling a cut-vertex cube fractures the group and can strand the
    cursor (the classic human failure mode here).
  - **Orientation–position coupling** — penalty when a cube's shortest reorient
    sequence fights its travel path (you can't spin in place).
  - **"Don't disturb solved cubes"** — penalty for rolling a cube already on
    target; a puzzle that *requires* it feels much harder than its length.
- [ ] **Empirical calibration (#3)** — the real signal is observed fail rate /
  avg attempts-to-solve from the `attempts` table. Use the model scores above as
  a **cold-start prior** for fresh puzzles, then blend toward the empirical fail
  rate as plays accumulate. Validate any heuristic by correlating it with real
  fail rate, and mine `move_seq` to see which frictions actually trip people up.

### Notes
- Solving the full catalogue is slow (several minutes; the 15-cube boards are
  ~10s each because BFS exhausts its node budget). It's explicit and on-demand,
  run per-puzzle or batched with progress — never at boot.

## Architectural Considerations

### Current Strengths
- **Single-file architecture** (main.js) is easy to reason about and deploy
- **No build step** means faster iteration and simpler hosting
- **localStorage for persistence** is sufficient for single-device play
- **Guaranteed-solvable generation** is elegant and ensures no player frustration

### Refactoring Opportunities (if scope expands)
1. **Modularization** — Split main.js into separate modules for:
   - Board logic (roll validation, connectivity checking)
   - Rendering (Three.js camera/scene setup)
   - Level generation
   - UI state management

2. **State Machine** — Formalize game states (menu, playing, win, solution-playback) as an explicit state machine to reduce conditional branching

3. **Undo/Redo** — Requires full move history and rollback logic; consider an immutable board representation or move-replay approach

4. **Testing** — `test/unit.mjs` now covers quaternion/roll correctness, win
   detection, budget math and catalogue determinism (with full-catalogue
   solvability replay); remaining gaps are the WebAuthn verify ceremonies and
   the rate limiter (both exercised only manually today)

### Performance Notes
- **Rendering** is GPU-bound (WebGL); CPU usage is minimal even with 25 cubes
- **Animation** uses requestAnimationFrame; frame drops are rare on modern hardware
- **localStorage** access is negligible (< 1 KB per session)
- **Level generation** (scrambling) happens synchronously at level start; <50 ms even for slow devices

## Testing Strategy

### Current
- Unit tests (`npm run test:unit`) cover board logic, quaternion/roll edge
  cases, win/connectivity detection, budget math and catalogue determinism —
  including replaying every catalogue puzzle's stored solution to a solved state
- API integration test (`npm run test:api`) drives the backend over fetch,
  including adversarial cases (poisoned values, cross-user finalisation)
- Smoke test (`npm run test:smoke`) catches import errors, WebGL failures, and runtime exceptions
- Manual testing recommended for:
  - Level difficulty balance (move budgets)
  - Passkey (WebAuthn) register/login ceremonies

### Future
- Headless WebAuthn ceremony tests (Playwright virtual authenticator)
- Rate-limiter coverage (tests currently disable it via KCUBE_RATE_LIMIT=0)
- Accessibility audit (WCAG 2.1 AA)
- Cross-browser testing (Chrome, Firefox, Safari, Edge)

## Deployment Notes

- **No build artifacts** — serve the repo directly; Three.js loads from CDN.
- **Two ways to host:**
  - *Full* — `npm start` runs `server/server.mjs` (Node ≥ 22.5), serving the game + JSON API + SQLite. Accounts, leaderboards and difficulty stats require this.
  - *Static-only* — `npm run static` (or any static host). The API client degrades to localStorage; no accounts/leaderboards. Good for an offline/CDN deploy.
- **No native dependency** — the backend uses only Node built-ins (`node:http`, `node:sqlite`), so there's nothing to compile or `npm install` for the server.
- **DB file** — `server/kcube.sqlite` is created on first run (gitignored). Override with `KCUBE_DB` (`:memory:` for ephemeral, e.g. tests).

## Contact & Contribution

This is a solo project at v1. Future contributors should:
1. Coordinate major changes via the issue tracker
2. Preserve the "no-build-step" principle unless adding a significant feature requires it
3. Test changes with `npm test` and manual play before pushing
4. Update CLAUDE.md and plan.md if architecture changes

---

## Color-Specific Win UI — Implementation Plan

This section is the step-by-step plan for building the **colour-target picker** described above (the UI half of "Per-Color Best Scores", deliverable first because it has zero backend dependency).

### Goal

Players can optionally lock the win condition to a specific face colour. When locked, winning requires all cubes to show *that exact colour* on top (plus contiguity — unchanged). When unlocked ("Any"), the existing behaviour is preserved. The setting persists across reloads via `localStorage`.

### Current state

| What | Location | Note |
|---|---|---|
| `isUniform()` | `src/main.js:431` | Checks `cubes[0].topColor` — any uniform colour wins |
| `game.targetColor` | `src/main.js` game object | Exists but **not** enforced in win check |
| `COLORS` array | `src/main.js:35` | `[{name, hex}, …]` — 6 entries, index = face id |
| `FACE_AXES` | `src/level-gen.mjs:27` | Maps cube-local axis → colour index |

### Step 1 — Game state field `game.winColor`

Add `winColor: null` to the `game` object literal (nullable number, `null` = any colour, `0..5` = specific colour).

On `buildLevel()` / `initGame()` do **not** reset it — the preference should survive puzzle transitions.

On page load restore from `localStorage`:
```js
const saved = localStorage.getItem("kcube.winColor");
game.winColor = saved !== null && saved !== "-1" ? Number(saved) : null;
```

### Step 2 — Update `isUniform()`

```js
function isUniform() {
  if (game.cubes.length === 0) return false;
  const target = game.winColor ?? game.cubes[0].topColor;
  return game.cubes.every((c) => c.topColor === target);
}
```

No other win-path logic changes.

### Step 3 — Export `COLORS` to `src/shared.mjs`

`COLORS` is currently defined only in `src/main.js` (Three.js-free data).  
Move the array to `src/shared.mjs` so the landing page and any future pure code can use it without importing the game module:

```js
// src/shared.mjs
export const COLORS = [
  { name: "white",  hex: 0xf2f3f5 },
  { name: "yellow", hex: 0xffd23f },
  { name: "red",    hex: 0xe5484d },
  { name: "orange", hex: 0xff7a1a },
  { name: "blue",   hex: 0x3aa0ff },
  { name: "green",  hex: 0x3ecf6b },
];
```

`src/main.js` imports it: `import { COLORS, … } from "./shared.mjs";` and removes the local definition.

### Step 4 — HTML widget (`play.html`)

Insert the picker row immediately after the moves HUD line, inside the existing top HUD element:

```html
<div id="win-color-picker" aria-label="Target colour for win">
  <span class="wcp-label">Win with</span>
  <button class="wcp-swatch wcp-any active" data-color="-1" title="Any colour">any</button>
  <button class="wcp-swatch" data-color="0" style="--sc:#f2f3f5" title="White"></button>
  <button class="wcp-swatch" data-color="1" style="--sc:#ffd23f" title="Yellow"></button>
  <button class="wcp-swatch" data-color="2" style="--sc:#e5484d" title="Red"></button>
  <button class="wcp-swatch" data-color="3" style="--sc:#ff7a1a" title="Orange"></button>
  <button class="wcp-swatch" data-color="4" style="--sc:#3aa0ff" title="Blue"></button>
  <button class="wcp-swatch" data-color="5" style="--sc:#3ecf6b" title="Green"></button>
</div>
```

Also add a small inline indicator next to the "best" badge in the HUD:
```html
<span id="win-target-dot" hidden title="Target colour"></span>
```

### Step 5 — CSS (`src/styles.css`)

```css
#win-color-picker {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}
.wcp-label {
  font-size: 0.65rem;
  color: #888;
  margin-right: 2px;
  white-space: nowrap;
}
.wcp-swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--sc, #444);
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: transform 0.12s, border-color 0.12s;
}
.wcp-swatch.active {
  border-color: #fff;
  transform: scale(1.3);
}
.wcp-any {
  background: #2a2a2a;
  font-size: 0.5rem;
  color: #999;
  line-height: 1;
}
#win-target-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 4px;
  vertical-align: middle;
  background: #fff; /* overwritten by JS */
}
```

### Step 6 — JS wiring (`src/main.js`)

```js
// --- colour-target picker ---

function syncWinColorPicker() {
  const active = game.winColor ?? -1;
  document.querySelectorAll("#win-color-picker .wcp-swatch").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.color) === active);
    btn.disabled = game.state === "won" || game.state === "lost";
  });
  const dot = document.getElementById("win-target-dot");
  if (game.winColor !== null) {
    const hex = COLORS[game.winColor].hex.toString(16).padStart(6, "0");
    dot.style.background = `#${hex}`;
    dot.hidden = false;
  } else {
    dot.hidden = true;
  }
}

document.getElementById("win-color-picker").addEventListener("click", (e) => {
  const btn = e.target.closest(".wcp-swatch");
  if (!btn || btn.disabled) return;
  const v = Number(btn.dataset.color);
  game.winColor = v === -1 ? null : v;
  localStorage.setItem("kcube.winColor", game.winColor ?? -1);
  syncWinColorPicker();
});
```

Call `syncWinColorPicker()` from:
- Page load (after restoring from localStorage)
- `updateHud()` (keeps dot in sync on every HUD refresh)
- After entering won/lost state (disables swatches)
- After entering playing state from retry/next (re-enables swatches)

### Step 7 — Overlay hint text

In the "Out of moves" overlay body, show the target if one is set:

```js
const colourName = game.winColor !== null ? COLORS[game.winColor].name : null;
const hint = colourName
  ? `Get all cubes showing <strong>${colourName}</strong> on top in one connected block.`
  : "Get every cube showing the same colour on top in one connected block.";
```

### Files changed

| File | Change |
|---|---|
| `src/shared.mjs` | Add + export `COLORS` array |
| `src/main.js` | Import `COLORS` from shared; add `game.winColor`; update `isUniform()`; add picker wiring + `syncWinColorPicker()`; update overlay hint; call sync from `updateHud()` and state transitions |
| `play.html` | `#win-color-picker` widget; `#win-target-dot` span |
| `src/styles.css` | Swatch, picker row, and dot styles |

Backend untouched for now. `winColor` threading into `finalizeAttempt` and `localStorage` schema bump are the next step (tracked above in "Rollout order").

### Acceptance criteria

1. Default: picker shows "any" active; existing win behaviour unchanged.
2. Selecting a colour locks win to that colour — uniform-but-wrong colour does **not** trigger a win.
3. Clicking the active swatch (or "any") clears the target back to `null`.
4. Preference survives page reload (localStorage).
5. Swatches are disabled after win/loss overlay appears and re-enabled on retry/next.
6. HUD dot appears/disappears correctly as target is set/cleared.
7. `npm run check` passes; `npm test` smoke still green.
