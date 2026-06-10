/* =============================================================================
 * solver.mjs — Pure-state BFS and greedy solvers for kCubeGL.
 *
 * No Three.js dependency; works on a plain state object:
 *   { cubes: [{id, r, c, faces}], cursorId }
 *
 * `faces` is a 6-element array indexed by world direction:
 *   0 = +X (right), 1 = -X (left), 2 = +Y (top), 3 = -Y (bottom),
 *   4 = +Z (front), 5 = -Z (back)
 * faces[2] is therefore always the top colour.
 *
 * Colour ids match FACE_AXES in main.js: 0=white, 1=yellow, 2=red,
 * 3=orange, 4=blue, 5=green.
 *
 * Roll permutations: new_faces[i] = old_faces[PERM[i]]
 * Derived from the world-space 90° premultiply rotations used in main.js:
 *   ArrowRight → R_z(−90°): left→top, top→right, right→bottom, bottom→left
 *   ArrowLeft  → R_z(+90°): right→top, top→left, left→bottom, bottom→right
 *   ArrowUp    → R_x(−90°): front→top, top→back, back→bottom, bottom→front
 *   ArrowDown  → R_x(+90°): back→top, top→front, front→bottom, bottom→back
 * =========================================================================== */

import { BOARD, NEI, OPPOSITE, inBounds } from "./shared.mjs";

const DIRS = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"];

const ROLL_PERM = {
  ArrowRight: [2, 3, 1, 0, 4, 5],
  ArrowLeft:  [3, 2, 0, 1, 4, 5],
  ArrowUp:    [0, 1, 4, 5, 3, 2],
  ArrowDown:  [0, 1, 5, 4, 2, 3],
};
const ROLL_DR = { ArrowRight: 0,  ArrowLeft:  0,  ArrowUp: -1, ArrowDown: 1  };
const ROLL_DC = { ArrowRight: 1,  ArrowLeft: -1,  ArrowUp:  0, ArrowDown: 0  };

/* --- Low-level helpers ------------------------------------------------------- */

function cubeAt(cubes, r, c) {
  for (const k of cubes) if (k.r === r && k.c === c) return k;
  return null;
}

function topColor(cube) { return cube.faces[2]; }

// All cubes 4-connected to `id` (the cursor's island).
function getIsland(cubes, id) {
  const start = cubes.find(c => c.id === id);
  if (!start) return [];
  const island = [start];
  const seen = new Set([id]);
  for (let i = 0; i < island.length; i++) {
    const c = island[i];
    for (const [dr, dc] of NEI) {
      const n = cubeAt(cubes, c.r + dr, c.c + dc);
      if (n && !seen.has(n.id)) { seen.add(n.id); island.push(n); }
    }
  }
  return island;
}

function isContiguous(cubes) {
  if (cubes.length <= 1) return true;
  return getIsland(cubes, cubes[0].id).length === cubes.length;
}

function isWon(state, targetColor = null) {
  const { cubes } = state;
  if (!cubes.length) return false;
  const t = targetColor ?? topColor(cubes[0]);
  return cubes.every(c => topColor(c) === t) && isContiguous(cubes);
}

// Immutable single-roll application; cursor follows the rolled cube.
function applyRoll(state, cubeId, dir) {
  const perm = ROLL_PERM[dir];
  const dr = ROLL_DR[dir], dc = ROLL_DC[dir];
  return {
    cubes: state.cubes.map(cube => {
      if (cube.id !== cubeId) return cube;
      return { id: cube.id, r: cube.r + dr, c: cube.c + dc,
               faces: perm.map(i => cube.faces[i]) };
    }),
    cursorId: cubeId,
  };
}

// Canonical key for BFS de-duplication.
// Sort cubes by position; represent cursor by the smallest board-index in its
// island so states that differ only in free cursor moves within an island share
// one key (they have identical move reachability).
function stateKey(state) {
  const sorted = state.cubes.slice().sort((a, b) => a.r * BOARD + a.c - (b.r * BOARD + b.c));
  const cubeStr = sorted.map(c => `${c.r}${c.c}${c.faces.join("")}`).join("|");
  const island = getIsland(state.cubes, state.cursorId);
  const minPos = island.reduce((m, c) => Math.min(m, c.r * BOARD + c.c), BOARD * BOARD);
  return `${cubeStr}@${minPos}`;
}

/* --- BFS solver --------------------------------------------------------------- */

// Returns [{id, dir}, …] (optimal roll sequence) or null if no solution was
// found within the budget.  Parent-pointer reconstruction avoids O(depth) array
// copies on every expansion.
export function bfsSolve(initialState, { maxDepth = 20, maxNodes = 60000 } = {}) {
  if (isWon(initialState)) return [];

  // Each queue entry: { state, parentIdx, move }
  const queue = [{ state: initialState, parentIdx: -1, move: null }];
  const seen = new Set([stateKey(initialState)]);

  for (let qi = 0; qi < queue.length && qi < maxNodes; qi++) {
    const { state, parentIdx: pi } = queue[qi];

    // Measure current depth via parent chain (cheap given tight depth limits).
    let depth = 0;
    for (let k = qi; queue[k].parentIdx !== -1; k = queue[k].parentIdx) depth++;
    if (depth >= maxDepth) continue;

    for (const cube of getIsland(state.cubes, state.cursorId)) {
      for (const dir of DIRS) {
        const nr = cube.r + ROLL_DR[dir], nc = cube.c + ROLL_DC[dir];
        if (!inBounds(nr, nc) || cubeAt(state.cubes, nr, nc)) continue;

        const ns = applyRoll(state, cube.id, dir);
        const key = stateKey(ns);
        if (seen.has(key)) continue;
        seen.add(key);

        const idx = queue.length;
        queue.push({ state: ns, parentIdx: qi, move: { id: cube.id, dir } });

        if (isWon(ns)) {
          // Reconstruct path from parent pointers.
          const path = [];
          for (let k = idx; queue[k].parentIdx !== -1; k = queue[k].parentIdx)
            path.push(queue[k].move);
          return path.reverse();
        }
      }
    }
  }
  return null;
}

/* --- Beam search (approximate, tight upper bound) ----------------------------- */

// An admissible-style progress measure for a state (lower = closer to solved):
// how many cubes are NOT showing the most-common top colour, plus how many extra
// disconnected islands remain. Used to rank beam-search candidates.
function remainingEstimate(state) {
  const counts = new Array(6).fill(0);
  for (const c of state.cubes) counts[topColor(c)]++;
  const colorGap = state.cubes.length - Math.max(...counts);

  const seen = new Set();
  let components = 0;
  for (const c of state.cubes) {
    if (seen.has(c.id)) continue;
    components++;
    for (const k of getIsland(state.cubes, c.id)) seen.add(k.id);
  }
  return colorGap + (components - 1);
}

// Greedy best-first beam: keep the `width` most promising states per depth layer,
// ranked by remainingEstimate. Not optimal, but it solves boards the simple
// greedy solver gets stuck on and returns a tight upper bound on the roll count.
// Returns [{id, dir}, …] or null if no solution was found within the budget.
export function beamSolve(initialState, { width = 300, maxDepth = 80, targetColor = null } = {}) {
  if (isWon(initialState, targetColor)) return [];

  // Nodes keep a parent pointer + move so the winning path can be reconstructed
  // without copying the whole move list into every candidate.
  const nodes = [{ state: initialState, parent: -1, move: null }];
  const seen = new Set([stateKey(initialState)]);
  let frontier = [0]; // indices into `nodes`

  for (let depth = 0; depth < maxDepth; depth++) {
    const children = [];
    for (const idx of frontier) {
      const { state } = nodes[idx];
      for (const cube of getIsland(state.cubes, state.cursorId)) {
        for (const dir of DIRS) {
          const nr = cube.r + ROLL_DR[dir], nc = cube.c + ROLL_DC[dir];
          if (!inBounds(nr, nc) || cubeAt(state.cubes, nr, nc)) continue;

          const ns = applyRoll(state, cube.id, dir);
          const key = stateKey(ns);
          if (seen.has(key)) continue;
          seen.add(key);

          const nidx = nodes.length;
          nodes.push({ state: ns, parent: idx, move: { id: cube.id, dir } });

          if (isWon(ns, targetColor)) {
            const path = [];
            for (let k = nidx; nodes[k].parent !== -1; k = nodes[k].parent)
              path.push(nodes[k].move);
            return path.reverse();
          }
          children.push(nidx);
        }
      }
    }
    if (!children.length) return null;
    // Keep only the most promising `width` states for the next layer. The sort is
    // stable in V8, so ties resolve by insertion order — keeping this solver
    // deterministic, which matters for reproducible difficulty values.
    children.sort((a, b) => remainingEstimate(nodes[a].state) - remainingEstimate(nodes[b].state));
    frontier = children.slice(0, width);
  }
  return null;
}

/* --- Search-effort difficulty signal ------------------------------------------ */

// The default ladder of beam widths probed by minBeamWidthToSolve. Geometric, so
// it covers "no planning" (1) through "lots of search" (512) in a few steps.
const WIDTH_LADDER = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

// Minimum search effort to solve a board: the smallest beam width at which the
// best-first beam (our bounded-rationality "human-ish" solver) first finds ANY
// solution. Width 1 ≈ pure greedy / no planning (easy); needing a wide beam means
// the obvious moves keep leading to dead ends, so a human must plan far ahead
// (hard). A cleaner difficulty guide than optimal length, which measures the
// puzzle, not the effort to play it.
//
// Returns { width, moves } for the first width that solves (moves = that beam's
// solution length), or null if even the widest beam tried found nothing. Beam
// solvability is near-monotone in width, so we scan the ladder low→high and stop
// at the first hit.
export function minBeamWidthToSolve(initialState, { ladder = WIDTH_LADDER, maxDepth = 80, targetColor = null } = {}) {
  if (isWon(initialState, targetColor)) return { width: 0, moves: 0 };
  for (const width of ladder) {
    const sol = beamSolve(initialState, { width, maxDepth, targetColor });
    if (sol) return { width, moves: sol.length };
  }
  return null;
}

/* --- Helpers shared by greedy ------------------------------------------------ */

// BFS over the 24 discrete cube orientations. With only 4 roll directions the
// maximum shortest path to any orientation is at most 4 steps, so the queue
// is tiny.  Returns [dir, …] or null.
function singleCubeSolve(faces, targetColor) {
  if (faces[2] === targetColor) return [];
  const seen = new Map([[faces.join(","), null]]);
  const queue = [[faces, []]];
  for (let qi = 0; qi < queue.length; qi++) {
    const [cur, path] = queue[qi];
    for (const dir of DIRS) {
      const nf = ROLL_PERM[dir].map(i => cur[i]);
      const k = nf.join(",");
      if (seen.has(k)) continue;
      seen.set(k, null);
      const np = [...path, dir];
      if (nf[2] === targetColor) return np;
      queue.push([nf, np]);
    }
  }
  return null;
}

// The colour that the most cubes already show on top.
function pickTargetColor(cubes) {
  const counts = new Array(6).fill(0);
  for (const c of cubes) counts[topColor(c)]++;
  return counts.indexOf(Math.max(...counts));
}

// When the cursor sits on a single isolated cube that already shows the right
// colour, find the shortest sequence of rolls that brings it to a cell adjacent
// to the rest of the board while ending with targetColor on top.  Returns the
// move list or null if no path was found within a tight search budget.
function reconnectColoredCube(state, targetColor) {
  const island = getIsland(state.cubes, state.cursorId);
  if (island.length !== 1) return null;
  const iso = island[0];
  if (topColor(iso) !== targetColor) return null;

  // Positions occupied by all OTHER cubes — cannot roll into these.
  const others = state.cubes.filter(c => c.id !== iso.id);
  const occupied = new Set(others.map(c => c.r * BOARD + c.c));
  const adjacent = (r, c) => NEI.some(([dr, dc]) => occupied.has((r + dr) * BOARD + (c + dc)));

  const seen = new Set([`${iso.r},${iso.c},${iso.faces.join(",")}`]);
  // Keep full path in each entry to simplify reconstruction (budget is small).
  const queue = [{ r: iso.r, c: iso.c, faces: iso.faces, path: [] }];

  for (let qi = 0; qi < queue.length && qi < 400; qi++) {
    const { r, c, faces, path } = queue[qi];
    if (path.length >= 7) continue;
    for (const dir of DIRS) {
      const nr = r + ROLL_DR[dir], nc = c + ROLL_DC[dir];
      if (!inBounds(nr, nc) || occupied.has(nr * BOARD + nc)) continue;
      const nf = ROLL_PERM[dir].map(i => faces[i]);
      const k = `${nr},${nc},${nf.join(",")}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const np = [...path, dir];
      if (adjacent(nr, nc) && nf[2] === targetColor)
        return np.map(d => ({ id: iso.id, dir: d }));
      queue.push({ r: nr, c: nc, faces: nf, path: np });
    }
  }
  return null;
}

// One greedy step that nudges the cursor's island toward disconnected cubes.
// Strongly avoids rolling cubes that already show the right colour.
function mergeStep(state, targetColor) {
  const island = getIsland(state.cubes, state.cursorId);
  const inIsland = new Set(island.map(c => c.id));
  const others = state.cubes.filter(c => !inIsland.has(c.id));
  if (!others.length) return null;

  const oR = others.reduce((s, c) => s + c.r, 0) / others.length;
  const oC = others.reduce((s, c) => s + c.c, 0) / others.length;

  let best = null, bestScore = Infinity;
  for (const cube of island) {
    const penalty = topColor(cube) === targetColor ? 1000 : 0;
    for (const dir of DIRS) {
      const nr = cube.r + ROLL_DR[dir], nc = cube.c + ROLL_DC[dir];
      if (!inBounds(nr, nc) || cubeAt(state.cubes, nr, nc)) continue;
      const score = (nr - oR) ** 2 + (nc - oC) ** 2 + penalty;
      if (score < bestScore) { bestScore = score; best = { id: cube.id, dir }; }
    }
  }
  return best;
}

/* --- Greedy solver ------------------------------------------------------------ */

// Heuristics:
//   • Pick the target colour with the most cubes already showing it.
//   • Commit to one wrong cube at a time; switch only when it is fixed.
//   • When rolling a committed cube, prefer `lastDir` if it still makes progress
//     (reduces the single-cube path length), otherwise follow the optimal path.
//   • Never voluntarily roll a cube that already shows the right colour unless
//     handling connectivity (mergeStep).
//   • Cycle detection via a visited-states set; if stuck on a cube, release the
//     commitment and try another.
//
// Returns [{id, dir}, …] or null.
export function greedySolve(initialState, { maxMoves = 300 } = {}) {
  let state = initialState;
  const allMoves = [];
  const targetColor = pickTargetColor(state.cubes);
  let committedId = null;
  let lastDir = null;
  const visited = new Set([stateKey(state)]);
  // Pre-planned move sequence (filled by reconnectColoredCube when needed).
  let pending = [];

  for (let step = 0; step < maxMoves; step++) {
    if (isWon(state)) return allMoves;

    // --- Drain any pre-planned reconnect moves first ---
    if (pending.length) {
      const m = pending.shift();
      const ns = applyRoll(state, m.id, m.dir);
      const key = stateKey(ns);
      if (visited.has(key)) { pending = []; committedId = null; lastDir = null; continue; }
      visited.add(key);
      allMoves.push(m);
      state = ns;
      committedId = m.id; lastDir = m.dir;
      continue;
    }

    // --- Connectivity first ---
    if (!isContiguous(state.cubes)) {
      // Special case: single isolated cube with the right colour — find a route
      // back to the group that ends with the colour still on top.
      const reconnect = reconnectColoredCube(state, targetColor);
      if (reconnect && reconnect.length) {
        pending = reconnect.slice(1);   // queue remaining moves
        const m = reconnect[0];
        const ns = applyRoll(state, m.id, m.dir);
        visited.add(stateKey(ns));
        allMoves.push(m);
        state = ns;
        committedId = m.id; lastDir = m.dir;
        continue;
      }
      // General case: nudge cursor island toward the others.
      const m = mergeStep(state, targetColor);
      if (!m) return null;
      allMoves.push(m);
      state = applyRoll(state, m.id, m.dir);
      committedId = m.id;
      lastDir = m.dir;
      const key = stateKey(state);
      if (visited.has(key)) { committedId = null; lastDir = null; }
      else visited.add(key);
      continue;
    }

    // --- Pick/keep a committed cube ---
    const committed = committedId !== null
      ? state.cubes.find(c => c.id === committedId) : null;

    if (!committed || topColor(committed) === targetColor) {
      // Release; choose the wrong cube in the cursor's island with fewest fixes.
      // Tie-break by neighbour count (prefer edge cubes — fewer connections means
      // rolling it away is less likely to fracture the main group).
      const island = getIsland(state.cubes, state.cursorId);
      const wrong = island.filter(c => topColor(c) !== targetColor);
      if (!wrong.length) return null; // stuck (shouldn't happen if not won)

      let pick = wrong[0], pickCost = Infinity, pickNei = Infinity;
      for (const c of wrong) {
        const p = singleCubeSolve(c.faces, targetColor);
        const cost = p ? p.length : Infinity;
        const nei = NEI.filter(([dr, dc]) => cubeAt(state.cubes, c.r + dr, c.c + dc)).length;
        if (cost < pickCost || (cost === pickCost && nei < pickNei)) {
          pickCost = cost; pickNei = nei; pick = c;
        }
      }
      committedId = pick.id;
      lastDir = null;
    }

    const cube = state.cubes.find(c => c.id === committedId);
    if (!cube) { committedId = null; continue; }

    const path = singleCubeSolve(cube.faces, targetColor);
    if (!path || !path.length) { committedId = null; lastDir = null; continue; }

    // Build candidate direction list: prefer lastDir first (continuity), then
    // the optimal first step, then the rest.
    const candidates = [];
    if (lastDir && lastDir !== OPPOSITE[path[0]]) candidates.push(lastDir);
    candidates.push(path[0]);
    for (const d of DIRS) if (d !== lastDir && d !== path[0]) candidates.push(d);

    let moved = false;
    for (const dir of candidates) {
      const nr = cube.r + ROLL_DR[dir], nc = cube.c + ROLL_DC[dir];
      if (!inBounds(nr, nc) || cubeAt(state.cubes, nr, nc)) continue;

      // Accept the optimal first step unconditionally; for other directions only
      // accept if path length does not increase — allowing same-length detours
      // around blocked cells while still preventing backtracking.
      const newFaces = ROLL_PERM[dir].map(i => cube.faces[i]);
      const newPath = singleCubeSolve(newFaces, targetColor);
      if (!newPath) continue;
      if (dir !== path[0] && newPath.length > path.length) continue;

      const newState = applyRoll(state, committedId, dir);
      const key = stateKey(newState);
      if (visited.has(key)) continue; // avoid cycle

      visited.add(key);
      allMoves.push({ id: committedId, dir });
      state = newState;
      lastDir = dir;
      moved = true;
      break;
    }

    if (!moved) { committedId = null; lastDir = null; } // release; try another cube
  }

  return isWon(state) ? allMoves : null;
}
