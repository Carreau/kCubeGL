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
import { bfsSolve, beamSolve, minBeamWidthToSolve } from "./solver.mjs";

// Reproduce a catalogue puzzle's scrambled start as a pure solver state.
// Returns { state, solutionLen } where solutionLen is the stored
// scramble-reverse solution length.
export function buildCatalogState(config) {
  const gen = generateLevel(config);
  return {
    state: {
      cubes: gen.cubes.map((c, i) => ({ id: i, r: c.r, c: c.c, faces: quatToFaces(c.quat) })),
      cursorId: gen.cursorIndex,
    },
    solutionLen: gen.scramble.length,
  };
}

// Compute difficulty signals for a catalogue puzzle:
//   • optimal     — the stored scramble-reverse solution length.
//   • bfs         — the BFS-optimal roll count (the "full solver"; null if it
//                   found no solution within budget).
//   • beam        — the beam-search approximate roll count (a tight upper bound
//                   that solves boards plain greedy gets stuck on).
//   • searchWidth — the minimum beam width at which the bounded-rationality
//                   beam first solves the board: a "how much planning a human
//                   needs" difficulty guide. 1 ≈ no planning (easy); a wide beam
//                   means the obvious moves keep dead-ending (hard). null if even
//                   the widest beam tried found nothing.
export function solveCatalogPuzzle(config, opts = {}) {
  const { state, solutionLen } = buildCatalogState(config);
  // BFS never needs to search deeper than the stored solution length (a valid
  // solve of exactly that length always exists), but it stays capped at 20:
  // catalogue scrambles go up to 30 and an exhaustive depth-30 BFS can blow up
  // in time/memory. So `bfs` (and the persisted full_optimal) is null BY DESIGN
  // on deep boards — the beam result is the difficulty signal there.
  const bfs = bfsSolve(state, opts.bfs ?? { maxDepth: Math.min(solutionLen, 20) });
  const beam = beamSolve(state, opts.beam);
  const effort = minBeamWidthToSolve(state, opts.effort);

  // Per-target-color beam: run beamSolve for each of the 6 face colours so the
  // admin can see which winning colour is easiest/hardest to reach.
  const colorBeams = {};
  for (let color = 0; color < 6; color++) {
    const result = beamSolve(state, { ...(opts.beam ?? {}), targetColor: color });
    colorBeams[color] = result ? result.length : null;
  }

  return {
    optimal: solutionLen,
    bfs: bfs ? bfs.length : null,
    beam: beam ? beam.length : null,
    searchWidth: effort ? effort.width : null,
    colorBeams,
  };
}
