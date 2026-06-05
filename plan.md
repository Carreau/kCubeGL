# plan.md

Project status, scope, and future considerations for kCubeGL.

## Current Scope (v1 - Complete)

### Implemented
- ✅ 5×5 board with 3–10 cubes per level
- ✅ Bevelled dice with randomized orientations
- ✅ Arrow-key cursor with 4-direction rolling
- ✅ Animated tip-over (true 3D quaternion rotations)
- ✅ Guaranteed-solvable level generation (reverse-scrambling)
- ✅ Contiguous-block win condition (connectivity + same color)
- ✅ Move budget economy (scales with cube count and scramble length)
- ✅ Carried move bonus (extra move from prior level → next level)
- ✅ Q/E view rotation
- ✅ Solution playback (reverses stored scramble sequence)
- ✅ Best-score persistence and level replay (localStorage)
- ✅ Win/lose/level-picker flow
- ✅ Integration smoke test (Playwright, headless browser)

### Deliberately Out of Scope (v1)
- ❌ **Sound** — no audio feedback
- ❌ **Timer** — no time pressure
- ❌ **Undo** — no move-by-move backtracking
- ❌ **Difficulty progression** — level difficulty (move budget) does not ramp systematically
- ❌ **Mobile touch controls** — only keyboard input
- ❌ **Accessibility** — no ARIA labels, alt text, or screen-reader support
- ❌ **Analytics** — no usage tracking

## Known Limitations

1. **Level Picker**: Only shows levels already reached; first level is auto-selected on load
2. **Move Budget Calculation**: Simple heuristic (scramble length × 1.5 + cube count); could be refined with difficulty analysis
3. **Random Scrambling**: Uses naive random reverse-rolls; no guarantee of variety or puzzle difficulty distribution
4. **View Rotation**: Continuous (Q/E hold), not snapped; can be disorienting
5. **Cube Selection**: Cursor can only move between physically adjacent cubes; no "selection highlight" if a cube is isolated
6. **No Networked Leaderboard**: Scores are local-only
7. **Three.js Dependency on CDN**: Game won't load if unpkg.com is unavailable or slow

## Potential Future Enhancements

### Short-term (Low effort, high value)
- [ ] **Undo/Redo** — Store move history; allow player to step back
- [ ] **Difficulty Selector** — Pre-set move budgets (Easy, Normal, Hard)
- [ ] **Sound Effects** — Web Audio API for roll, win, level-complete
- [ ] **Mobile Touch** — Swipe/tap controls for mobile browsers
- [ ] **Level Thumbnails** — Preview board layout in level picker

### Medium-term
- [ ] **Systematic Difficulty Ramp** — Assign difficulty tier to each level; adjust move budget accordingly
- [ ] **Accessibility** — ARIA labels, keyboard-only navigation, high-contrast mode
- [ ] **Statistics Dashboard** — Total moves across all levels, completion rate, personal best history
- [ ] **Custom Boards** — Level editor or procedural generation beyond reverse-scrambling
- [ ] **Multiplayer** — Local pass-and-play or real-time competitive modes

### Long-term
- [ ] **Backend Leaderboard** — Persist scores to a database; global rankings
- [ ] **Cloud Saves** — Sync progress across devices
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

- **No runtime dependencies** (Three.js is loaded from CDN)
- **No build artifacts** (serve the repo root directly)
- **Static hosting only** (no server-side logic needed)
- **Works offline** once cached (PWA potential, not yet implemented)
- **localStorage** requires user to opt-in (no explicit permission needed in modern browsers)

## Contact & Contribution

This is a solo project at v1. Future contributors should:
1. Coordinate major changes via the issue tracker
2. Preserve the "no-build-step" principle unless adding a significant feature requires it
3. Test changes with `npm test` and manual play before pushing
4. Update CLAUDE.md and plan.md if architecture changes
