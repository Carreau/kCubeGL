# plan.md

Project status, scope, and future considerations for kCubeGL.

## Current Scope (v2 — adds a backend)

### Implemented
- ✅ 5×5 board, bevelled dice, arrow-key cursor with 4-direction rolling
- ✅ Animated tip-over (true 3D quaternion rotations)
- ✅ Guaranteed-solvable level generation (reverse-scrambling)
- ✅ **Deterministic levels** — generation is seeded by the level number, so level N is the same puzzle for everyone (basis for fair leaderboards)
- ✅ Contiguous-block win condition (connectivity + same color)
- ✅ Move budget economy + carried move bonus
- ✅ Q/E view rotation, solution playback
- ✅ Best-score persistence (localStorage) — works with no backend
- ✅ Win/lose flow
- ✅ **Real landing page** (`index.html`) — level grid with your best / world best, sign-in, per-level leaderboard + difficulty detail; game lives at `play.html?level=N`
- ✅ **SQLite backend** (`node:sqlite`, no native deps) — `server/server.mjs` serves the game + a JSON API
- ✅ **Username accounts** (bearer-token, no password)
- ✅ **Leaderboards** (fewest moves per level, tie-broken by time)
- ✅ **Per-attempt tracking** (won / lost / abandoned, moves, duration) → puzzle-difficulty and player-skill aggregates
- ✅ Tests: API integration (`test/api.mjs`) + headless browser smoke (`test/smoke.mjs`)

### Deliberately Out of Scope
- ❌ **Passwords / sessions** — accounts are name + token only (a token in localStorage); no recovery or cross-device sync yet
- ❌ **Sound / Timer-pressure / Undo**
- ❌ **Difficulty progression** — move budget does not ramp from measured difficulty yet (the data to drive it now exists)
- ❌ **Mobile touch controls**
- ❌ **Accessibility** — limited ARIA / screen-reader support

## Known Limitations

1. **Move Budget Calculation**: Simple heuristic; the backend now collects the attempt/move data needed to refine it from measured difficulty
2. **Random Scrambling**: Naive random reverse-rolls (now seeded/deterministic per level); no explicit difficulty targeting yet
3. **View Rotation**: Continuous (Q/E hold), not snapped; can be disorienting
4. **Cube Selection**: Cursor can only move between physically adjacent cubes
5. **Account Recovery**: A lost token (cleared localStorage) means picking a new name — no password/recovery yet
6. **Three.js Dependency on CDN**: Game won't load if unpkg.com is unavailable or slow

## Potential Future Enhancements

### Short-term (Low effort, high value)
- [ ] **Undo/Redo** — Store move history; allow player to step back
- [ ] **Difficulty Selector** — Pre-set move budgets (Easy, Normal, Hard)
- [ ] **Sound Effects** — Web Audio API for roll, win, level-complete
- [ ] **Mobile Touch** — Swipe/tap controls for mobile browsers
- [ ] **Level Thumbnails** — Preview board layout in level picker

### Medium-term
- [ ] **Systematic Difficulty Ramp** — Use the now-collected attempt/move data to assign each level a measured difficulty tier and tune its move budget
- [ ] **Accessibility** — ARIA labels, keyboard-only navigation, high-contrast mode
- [~] **Statistics Dashboard** — Per-level difficulty + per-player skill summaries exist on the landing page; a fuller history/trend view is still open
- [ ] **Custom Boards** — Level editor or procedural generation beyond reverse-scrambling
- [ ] **Multiplayer** — Local pass-and-play or real-time competitive modes

### Long-term
- [x] **Backend Leaderboard** — Scores persisted to SQLite; per-level global rankings ✅
- [ ] **Cloud Saves** — Sync progress across devices (needs password/real auth first)
- [ ] **Themes** — Custom cube colors, board styles, UI skins
- [ ] **3D Model Import** — Replace procedural cubes with custom 3D assets
- [ ] **Larger Boards** — 6×6, 7×7 or variable sizes

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

4. **Testing** — Current smoke test only covers happy path; unit tests for:
   - Quaternion rotation correctness
   - Win condition detection
   - Move budget calculations
   - Level generation distribution

### Performance Notes
- **Rendering** is GPU-bound (WebGL); CPU usage is minimal even with 25 cubes
- **Animation** uses requestAnimationFrame; frame drops are rare on modern hardware
- **localStorage** access is negligible (< 1 KB per session)
- **Level generation** (scrambling) happens synchronously at level start; <50 ms even for slow devices

## Testing Strategy

### Current
- Smoke test (npm test) catches import errors, WebGL failures, and runtime exceptions
- Manual testing recommended for:
  - Level difficulty balance (move budgets)
  - Quaternion edge cases (corner cases in roll logic)
  - Win condition detection (especially connectivity checks)

### Future
- Unit tests for board logic (separated from rendering)
- Property-based tests for level solvability (generate 1000+ levels, verify all can reach solved state)
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
