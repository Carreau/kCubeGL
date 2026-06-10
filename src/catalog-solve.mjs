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
import {
  bfsSolve, beamSolve, minBeamWidthToSolve,
  applyRoll, isWon, ROLL_DR, ROLL_DC,
} from "./solver.mjs";
import { inBounds, cubeAt, NEI, OPPOSITE } from "./shared.mjs";

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

// One code per arrow press, as recorded by the game (src/main.js KEY_CODE).
const CODE_TO_DIR = { R: "ArrowRight", L: "ArrowLeft", U: "ArrowUp", D: "ArrowDown" };

// Replay a recorded cursor path (a string of R/L/U/D codes) against a puzzle's
// deterministic board, mirroring the game's input rules exactly (src/main.js
// tryMove): from the cursor cube, an arrow toward an occupied neighbour is a
// free cursor switch; toward an empty in-bounds cell it is a paid roll (and the
// cursor rides the rolled cube). The game never records a press toward an
// off-board cell, so one in the sequence means it cannot be a real recording.
//
// Returns { rolls, won } — the paid roll count and whether the final position
// is solved (every top the same colour, one connected block) — or null if the
// sequence is impossible. This is the server's ground truth for win claims:
// a submission is only as good as a sequence that actually replays to a win.
export function replayMoves(config, moveSeq) {
  let { state } = buildCatalogState(config);
  let rolls = 0;
  for (const code of moveSeq) {
    const dir = CODE_TO_DIR[code];
    if (!dir) return null;
    const cur = state.cubes.find((c) => c.id === state.cursorId);
    const nr = cur.r + ROLL_DR[dir], nc = cur.c + ROLL_DC[dir];
    if (!inBounds(nr, nc)) return null;
    const other = cubeAt(state.cubes, nr, nc);
    if (other) {
      state = { cubes: state.cubes, cursorId: other.id }; // free switch
    } else {
      state = applyRoll(state, cur.id, dir);
      rolls++;
    }
  }
  return { rolls, won: isWon(state) };
}

const DIR_TO_CODE = Object.fromEntries(Object.entries(CODE_TO_DIR).map(([c, d]) => [d, c]));
// "dr,dc" → code, for turning an adjacent-cube hop into the arrow that walks it.
const DELTA_CODE = Object.fromEntries(
  Object.entries(CODE_TO_DIR).map(([code, dir]) => [`${ROLL_DR[dir]},${ROLL_DC[dir]}`, code])
);

// Shortest cursor walk between two cubes of one island, as arrow codes (BFS over
// cube adjacency — every hop lands on an occupied cell, i.e. a free switch).
// Returns null when the cubes are in different islands.
function walkCodes(cubes, fromId, toId) {
  if (fromId === toId) return [];
  const byId = new Map(cubes.map((c) => [c.id, c]));
  const prev = new Map([[fromId, null]]);
  const queue = [byId.get(fromId)];
  while (queue.length) {
    const c = queue.shift();
    if (c.id === toId) break;
    for (const [dr, dc] of NEI) {
      const n = cubeAt(cubes, c.r + dr, c.c + dc);
      if (n && !prev.has(n.id)) { prev.set(n.id, c.id); queue.push(n); }
    }
  }
  if (!prev.has(toId)) return null;
  const ids = [];
  for (let id = toId; id != null; id = prev.get(id)) ids.push(id);
  ids.reverse();
  const codes = [];
  for (let i = 1; i < ids.length; i++) {
    const a = byId.get(ids[i - 1]), b = byId.get(ids[i]);
    codes.push(DELTA_CODE[`${b.r - a.r},${b.c - a.c}`]);
  }
  return codes;
}

// The puzzle's stored reverse-scramble solution as a full replayable code
// string: each solution roll prefixed by the free cursor walk that reaches its
// cube — exactly the stream the game records when a player follows the
// solution. replayMoves(config, solutionCodes(config)) always wins, with a
// paid roll count equal to the stored solution length.
export function solutionCodes(config) {
  const gen = generateLevel(config);
  let state = {
    cubes: gen.cubes.map((c, i) => ({ id: i, r: c.r, c: c.c, faces: quatToFaces(c.quat) })),
    cursorId: gen.cursorIndex,
  };
  const codes = [];
  for (const { cubeIndex, key } of gen.scramble.slice().reverse()) {
    const dir = OPPOSITE[key];
    const walk = walkCodes(state.cubes, state.cursorId, cubeIndex);
    if (!walk) return null; // can't happen: scramble moves stay within the cursor's island
    codes.push(...walk);
    codes.push(DIR_TO_CODE[dir]);
    state = applyRoll(state, cubeIndex, dir);
  }
  return codes.join("");
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
  // The optimal solver never needs to search deeper than the stored solution
  // (a valid solve of exactly that length always exists). This runs server-side
  // (admin-triggered, in a worker thread), so it also gets a much larger node
  // budget than the in-browser default — together enough to crack all but the
  // deepest catalogue board in a few seconds. `bfs` (and the persisted
  // full_optimal) is null only when that budget runs out.
  const bfs = bfsSolve(state, { maxDepth: solutionLen, maxNodes: 500_000, ...opts.bfs });
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
