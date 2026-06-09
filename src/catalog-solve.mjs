/* ============================================================================
 * catalog-solve.mjs — pure (no Three.js, no DOM) difficulty signals for a
 * catalogue puzzle: its stored solution length plus BFS-optimal and beam-search
 * solve lengths.
 *
 * The board itself comes from src/level-gen.mjs — the single source of truth the
 * browser game uses too — so the numbers here match exactly what a player sees.
 * This module just adapts that generated board into a solver state and runs the
 * solvers. Imported by the server's admin solver step; dependency-free and pure.
 * ========================================================================== */

import { generateLevel, quatToFaces } from "./level-gen.mjs";
import { bfsSolve, beamSolve } from "./solver.mjs";

// Reproduce a catalogue puzzle's scrambled start as a pure solver state.
// Returns { state, solutionLen } where solutionLen is the stored
// scramble-reverse solution length.
export function buildCatalogState(config) {
  const gen = generateLevel(config);
  return {
    state: {
      cubes: gen.cubes.map((c, i) => ({ id: i, r: c.row, c: c.col, faces: quatToFaces(c.quat) })),
      cursorId: gen.cursorIndex,
    },
    solutionLen: gen.scramble.length,
  };
}

// Compute difficulty signals for a catalogue puzzle: the stored scramble-reverse
// solution length, the BFS-optimal roll count (the "full solver" — null if no
// solution was found within budget), and the beam-search approximate roll count
// (a tight upper bound that solves boards plain greedy gets stuck on).
export function solveCatalogPuzzle(config, opts = {}) {
  const { state, solutionLen } = buildCatalogState(config);
  const bfs = bfsSolve(state, opts.bfs);
  const beam = beamSolve(state, opts.beam);
  return {
    optimal: solutionLen,
    bfs: bfs ? bfs.length : null,
    beam: beam ? beam.length : null,
  };
}
