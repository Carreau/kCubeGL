/* =============================================================================
 * solver.mjs — Pure-state optimal (A*), beam and greedy solvers for kCubeGL.
 *
 * No Three.js dependency; works on a plain state object:
 *   { cubes: [{id, r, c, faces}], cursorId }
 *
 * `faces` is a 6-element array indexed by world direction:
 *   0 = +X (right), 1 = -X (left), 2 = +Y (top), 3 = -Y (bottom),
 *   4 = +Z (front), 5 = -Z (back)
 * faces[2] is therefore always the top colour.
 *
 * Colour ids match FACE_AXES in level-gen.mjs: 0=white, 1=yellow, 2=red,
 * 3=orange, 4=blue, 5=green.
 *
 * Roll permutations: new_faces[i] = old_faces[PERM[i]]
 * Derived AT MODULE INIT from the same quaternion roll math the game uses
 * (level-gen.mjs DIRS + qAxisAngle/qMul/quatToFaces), so the solver's face
 * permutations can never drift from the real tip-over rotations. A roll is a
 * world-space premultiplied 90° rotation, so the resulting face permutation is
 * the same for every cube orientation — deriving it once from the identity
 * orientation is sufficient.
 *
 * ── Search internals (bfsSolve / beamSolve) ──────────────────────────────────
 * The search solvers run on a compact internal representation, not on the
 * {cubes:[…]} objects:
 *
 *   • Orientations, not face arrays. A die has exactly 24 reachable
 *     orientations; they are enumerated once at module init from ROLL_PERM
 *     into transition (ORI_NEXT), top-colour (ORI_TOP) and rolls-to-show-a-
 *     colour (MIN_ROLLS) tables. Applying a roll is then one table lookup.
 *
 *   • Canonical state keys. A state is one short string: per cube, sorted by
 *     cell, the char code cell*24+orientation — plus the smallest cell of the
 *     cursor's island. Sorting by cell drops cube identity on purpose: all
 *     cubes are identical dice, so states differing only in which physical
 *     cube sits where are the same search state. Representing the cursor by
 *     its island's min cell merges states that differ only by free cursor
 *     movement within an island (identical move reachability). Real cube ids
 *     are recovered at the end by replaying the winning cell trail against
 *     the caller's initial state (movesFromTrail).
 *
 *   • Commuting moves collapse in the key. Any two move orders that produce
 *     the same board and cursor island hash to the same key, so each set of
 *     interleavings of independent moves is explored once. Pruning the
 *     duplicate orderings *before* they are generated was evaluated and
 *     rejected: legality here is gated on "cube ∈ cursor island", so proving
 *     two adjacent moves commute requires island checks in the parent and
 *     intermediate states — flood fills that cost more than the duplicate
 *     child generation they would avoid. The one free case IS pruned up
 *     front: immediately undoing the previous roll (same cube, opposite
 *     direction) always recreates the grandparent state.
 * =========================================================================== */

import { BOARD, NEI, OPPOSITE, inBounds, cubeAt, islandOf } from "./shared.mjs";
import { DIRS as GEN_DIRS, qAxisAngle, qMul, quatToFaces } from "./level-gen.mjs";

const DIRS = Object.keys(GEN_DIRS); // ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"]

const ROLL_PERM = {};
export const ROLL_DR = {};
export const ROLL_DC = {};
{
  const IDENTITY = [0, 0, 0, 1];
  const idFaces = quatToFaces(IDENTITY); // 6 distinct colour ids, one per slot
  for (const [key, d] of Object.entries(GEN_DIRS)) {
    const rolledFaces = quatToFaces(qMul(qAxisAngle(d.axis, d.angle), IDENTITY));
    ROLL_PERM[key] = rolledFaces.map((color) => idFaces.indexOf(color));
    ROLL_DR[key] = d.dr;
    ROLL_DC[key] = d.dc;
  }
}

/* --- Fast search core: precomputed tables ------------------------------------- */

const CELLS = BOARD * BOARD;

// OPP_DIR[d] — the direction index that undoes DIRS[d].
const OPP_DIR = DIRS.map((k) => DIRS.indexOf(OPPOSITE[k]));

// CELL_NEXT[cell*4+d] — the cell one roll in DIRS[d] lands on, or -1 off-board.
// CELL_NEI[cell*4+j]  — neighbour cells in NEI order (the order shared.mjs
// islandOf visits them in; beamSolve's deterministic expansion relies on it).
const CELL_NEXT = new Int8Array(CELLS * 4);
const CELL_NEI = new Int8Array(CELLS * 4);
for (let r = 0; r < BOARD; r++) {
  for (let c = 0; c < BOARD; c++) {
    for (let j = 0; j < 4; j++) {
      const k = DIRS[j];
      const mr = r + ROLL_DR[k], mc = c + ROLL_DC[k];
      CELL_NEXT[(r * BOARD + c) * 4 + j] = inBounds(mr, mc) ? mr * BOARD + mc : -1;
      const nr = r + NEI[j][0], nc = c + NEI[j][1];
      CELL_NEI[(r * BOARD + c) * 4 + j] = inBounds(nr, nc) ? nr * BOARD + nc : -1;
    }
  }
}

// The 24 die orientations, enumerated by BFS from the identity orientation over
// the derived roll permutations (two perpendicular quarter-turns generate the
// whole rotation group, so all 24 are reached).
const ORI_FACES = [];    // ori -> faces array (6 colour ids)
const ORI_ID = new Map();// faces.join(",") -> ori
const ORI_NEXT = [];     // ori -> Uint8Array(4): orientation after rolling DIRS[d]
const ORI_TOP = [];      // ori -> top colour (faces[2])
{
  ORI_FACES.push(quatToFaces([0, 0, 0, 1]));
  ORI_ID.set(ORI_FACES[0].join(","), 0);
  for (let o = 0; o < ORI_FACES.length; o++) {
    const f = ORI_FACES[o];
    const next = new Uint8Array(4);
    for (let d = 0; d < 4; d++) {
      const nf = ROLL_PERM[DIRS[d]].map((i) => f[i]);
      const s = nf.join(",");
      if (!ORI_ID.has(s)) { ORI_ID.set(s, ORI_FACES.length); ORI_FACES.push(nf); }
      next[d] = ORI_ID.get(s);
    }
    ORI_NEXT.push(next);
    ORI_TOP.push(f[2]);
  }
}

// MIN_ROLLS[ori*6+colour] — fewest rolls before `colour` shows on top (0..2).
// The per-cube term of bfsSolve's admissible heuristic. Computed by BFS from
// each colour's goal set; every roll has an inverse roll, so the orientation
// graph is symmetric and goal-to-state distances equal state-to-goal ones.
const MIN_ROLLS = new Uint8Array(24 * 6);
for (let t = 0; t < 6; t++) {
  const dist = new Array(24).fill(-1);
  const q = [];
  for (let o = 0; o < 24; o++) if (ORI_TOP[o] === t) { dist[o] = 0; q.push(o); }
  for (let qi = 0; qi < q.length; qi++) {
    const o = q[qi];
    for (let d = 0; d < 4; d++) {
      const no = ORI_NEXT[o][d];
      if (dist[no] === -1) { dist[no] = dist[o] + 1; q.push(no); }
    }
  }
  for (let o = 0; o < 24; o++) MIN_ROLLS[o * 6 + t] = dist[o];
}

/* --- Fast search core: state encoding + per-search scratch --------------------- */

// Encode the caller's state into the canonical form: sorted cell*24+ori codes
// (the key chars) and the cursor's cell (-1 if cursorId matches no cube).
function encodeState(state) {
  const n = state.cubes.length;
  const codes = new Array(n);
  let cursor = -1;
  for (let i = 0; i < n; i++) {
    const cube = state.cubes[i];
    if (!inBounds(cube.r, cube.c)) throw new Error("solver: cube out of board bounds");
    const ori = ORI_ID.get(cube.faces.join(","));
    if (ori === undefined) throw new Error("solver: cube faces are not a valid die orientation");
    const cell = cube.r * BOARD + cube.c;
    codes[i] = cell * 24 + ori;
    if (cube.id === state.cursorId) cursor = cell;
  }
  codes.sort((a, b) => a - b);
  for (let i = 1; i < n; i++) {
    if (((codes[i] / 24) | 0) === ((codes[i - 1] / 24) | 0)) throw new Error("solver: two cubes share a cell");
  }
  return { n, baseKey: String.fromCharCode(...codes), cursor };
}

// Reusable buffers + primitives for one search run over n cubes. All methods
// write into shared scratch, so callers must consume results before the next
// call; nothing here allocates in the hot path except the child key strings.
function makeCore(n) {
  const cells = new Uint8Array(n);          // decoded cube cells, ascending
  const oris = new Uint8Array(n);           // orientations, aligned with cells
  const codes = new Uint16Array(n);         // cells[i]*24+oris[i] (= key chars)
  const grid = new Uint8Array(CELLS);       // cell -> cube index + 1, 0 = empty
  const childGrid = new Uint8Array(CELLS);  // occupancy after a candidate move
  const mark = new Uint8Array(CELLS);       // flood-fill visited flags
  const floodQ = new Uint8Array(CELLS);     // flood-fill FIFO
  const islandCells = new Uint8Array(CELLS);// cursor island, islandOf() order
  const childCodes = new Array(n + 1);      // child key char codes + island min
  const counts = new Uint8Array(6);         // top-colour histogram scratch

  return {
    cells, oris, grid, islandCells, counts,
    islandSize: 0, islandMin: 0, childMin: 0, childComps: 0,

    // Unpack a node key (first n chars) into cells/oris/codes and the grid.
    decode(key) {
      grid.fill(0);
      for (let i = 0; i < n; i++) {
        const code = key.charCodeAt(i);
        codes[i] = code;
        const cell = (code / 24) | 0;
        cells[i] = cell;
        oris[i] = code % 24;
        grid[cell] = i + 1;
      }
    },

    // Collect the cursor's island (cells reachable from `start` over occupied
    // cells) into islandCells, visiting neighbours in NEI order so the cube
    // enumeration matches shared.mjs islandOf exactly. Sets islandSize/Min.
    islandFrom(start) {
      mark.fill(0);
      let head = 0, tail = 0, min = start;
      islandCells[tail++] = start;
      mark[start] = 1;
      while (head < tail) {
        const cell = islandCells[head++];
        if (cell < min) min = cell;
        const base = cell * 4;
        for (let j = 0; j < 4; j++) {
          const nb = CELL_NEI[base + j];
          if (nb >= 0 && grid[nb] !== 0 && mark[nb] === 0) { mark[nb] = 1; islandCells[tail++] = nb; }
        }
      }
      this.islandSize = tail;
      this.islandMin = min;
    },

    // Stats of the child state where cube `movedIdx` rolls from -> to: the min
    // cell of the new cursor island (for the canonical key) and the number of
    // connected components (win test + heuristics). Sets childMin/childComps.
    childStats(movedIdx, from, to) {
      childGrid.set(grid);
      childGrid[from] = 0;
      childGrid[to] = 1;
      mark.fill(0);
      let head = 0, tail = 0, min = to;
      floodQ[tail++] = to;
      mark[to] = 1;
      while (head < tail) {
        const cell = floodQ[head++];
        if (cell < min) min = cell;
        const base = cell * 4;
        for (let j = 0; j < 4; j++) {
          const nb = CELL_NEI[base + j];
          if (nb >= 0 && childGrid[nb] !== 0 && mark[nb] === 0) { mark[nb] = 1; floodQ[tail++] = nb; }
        }
      }
      let comps = 1;
      for (let i = 0; i < n; i++) {
        const ci = i === movedIdx ? to : cells[i];
        if (mark[ci]) continue;
        comps++;
        let qh = tail;
        floodQ[tail++] = ci;
        mark[ci] = 1;
        while (qh < tail) {
          const cell = floodQ[qh++];
          const base = cell * 4;
          for (let j = 0; j < 4; j++) {
            const nb = CELL_NEI[base + j];
            if (nb >= 0 && childGrid[nb] !== 0 && mark[nb] === 0) { mark[nb] = 1; floodQ[tail++] = nb; }
          }
        }
      }
      this.childMin = min;
      this.childComps = comps;
    },

    // Canonical key of that child: parent codes with the moved cube's code
    // replaced, kept sorted, plus the cursor-island min cell.
    childKey(movedIdx, to, newOri) {
      const nc = to * 24 + newOri;
      let w = 0, inserted = false;
      for (let i = 0; i < n; i++) {
        if (i === movedIdx) continue;
        const code = codes[i];
        if (!inserted && nc < code) { childCodes[w++] = nc; inserted = true; }
        childCodes[w++] = code;
      }
      if (!inserted) childCodes[w++] = nc;
      childCodes[n] = this.childMin;
      return String.fromCharCode(...childCodes);
    },

    // Top-colour histogram of that child into `counts`; returns the mode count.
    childTopCounts(movedIdx, newOri) {
      counts.fill(0);
      let max = 0;
      for (let i = 0; i < n; i++) {
        const t = ORI_TOP[i === movedIdx ? newOri : oris[i]];
        if (++counts[t] > max) max = counts[t];
      }
      return max;
    },

    // Number of connected components of the decoded state.
    componentsAll() {
      mark.fill(0);
      let comps = 0, head = 0, tail = 0;
      for (let i = 0; i < n; i++) {
        const ci = cells[i];
        if (mark[ci]) continue;
        comps++;
        floodQ[tail++] = ci;
        mark[ci] = 1;
        while (head < tail) {
          const cell = floodQ[head++];
          const base = cell * 4;
          for (let j = 0; j < 4; j++) {
            const nb = CELL_NEI[base + j];
            if (nb >= 0 && grid[nb] !== 0 && mark[nb] === 0) { mark[nb] = 1; floodQ[tail++] = nb; }
          }
        }
      }
      return comps;
    },

    // Win test for the decoded state: uniform top colour (the target one, if
    // given) and a single connected block. Matches isWon() on object states.
    isWonNow(targetColor) {
      if (n === 0) return false;
      counts.fill(0);
      let max = 0;
      for (let i = 0; i < n; i++) {
        const t = ORI_TOP[oris[i]];
        if (++counts[t] > max) max = counts[t];
      }
      const uniform = targetColor == null ? max === n : counts[targetColor] === n;
      return uniform && this.componentsAll() === 1;
    },
  };
}

// Turn a winning node's parent chain of (fromCell, dir) moves back into
// [{id, dir}, …] with the caller's cube ids, by replaying the cell trail from
// the initial state. (The search drops cube identity — see the header.)
function movesFromTrail(endIdx, parents, moveFroms, moveDirs, initialState) {
  const trail = [];
  for (let k = endIdx; parents[k] !== -1; k = parents[k]) trail.push(k);
  const cellId = new Array(CELLS);
  for (const c of initialState.cubes) cellId[c.r * BOARD + c.c] = c.id;
  const path = [];
  for (let j = trail.length - 1; j >= 0; j--) {
    const k = trail[j], from = moveFroms[k], d = moveDirs[k];
    path.push({ id: cellId[from], dir: DIRS[d] });
    cellId[CELL_NEXT[from * 4 + d]] = cellId[from];
    cellId[from] = undefined;
  }
  return path;
}

/* --- Low-level helpers for the object-state solvers (greedy) ------------------ */

function topColor(cube) { return cube.faces[2]; }

// All cubes 4-connected to `id` (the cursor's island).
function getIsland(cubes, id) {
  const start = cubes.find(c => c.id === id);
  return start ? islandOf(cubes, start) : [];
}

function isContiguous(cubes) {
  if (cubes.length <= 1) return true;
  return getIsland(cubes, cubes[0].id).length === cubes.length;
}

// Exported for catalog-solve's win-replay verification (same win rule and the
// same derived roll permutations the solvers — and therefore the game — use).
export function isWon(state, targetColor = null) {
  const { cubes } = state;
  if (!cubes.length) return false;
  const t = targetColor ?? topColor(cubes[0]);
  return cubes.every(c => topColor(c) === t) && isContiguous(cubes);
}

// Immutable single-roll application; cursor follows the rolled cube.
export function applyRoll(state, cubeId, dir) {
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

// Canonical key for cycle detection on object states (greedySolve). Same
// equivalence as the search core's keys: cubes sorted by position, cursor
// represented by the smallest board-index in its island.
function stateKey(state) {
  const sorted = state.cubes.slice().sort((a, b) => a.r * BOARD + a.c - (b.r * BOARD + b.c));
  const cubeStr = sorted.map(c => `${c.r}${c.c}${c.faces.join("")}`).join("|");
  const island = getIsland(state.cubes, state.cursorId);
  const minPos = island.reduce((m, c) => Math.min(m, c.r * BOARD + c.c), BOARD * BOARD);
  return `${cubeStr}@${minPos}`;
}

/* --- Optimal solver (A*) -------------------------------------------------------
 *
 * Provably-optimal shortest roll sequence, like the breadth-first search it
 * replaces (the exported name is kept), but ordered by f = depth + h where h is
 * an admissible, consistent heuristic — so it reaches the same answers while
 * expanding a small fraction of the states:
 *
 *   h = max( colour term , connectivity term )
 *     colour term: Σ over cubes of MIN_ROLLS[ori][t] — each cube individually
 *       needs at least that many rolls before t shows on top; minimised over t
 *       when no target colour is fixed. Admissible: every roll advances exactly
 *       one cube by one step.
 *     connectivity term: ceil((islands−1)/3) — one roll merges at most 3 other
 *       islands into the moved cube's (the landing cell has at most 3 occupied
 *       neighbours, since the vacated cell is one of the 4).
 *   Both terms change by at most 1 per roll, so h is consistent and the first
 *   goal POPPED from the f-ordered queue is optimal. h = 0 ⟺ won, so the goal
 *   test is free. Unit edge costs + small integer f ⇒ a bucket queue.
 *
 * Duplicate handling: gBest maps each canonical key to the best depth reached;
 * generations that don't improve it are dropped, and a popped node whose depth
 * exceeds its gBest entry is a stale duplicate, skipped. (With a consistent h
 * an improving re-generation can only arrive before the state is expanded, so
 * this keeps optimality without a decrease-key queue.)
 * ------------------------------------------------------------------------------ */

// Returns [{id, dir}, …] (an optimal roll sequence of length ≤ maxDepth) or
// null if no solution was found within the depth/node budget. maxNodes bounds
// EXPANSIONS; stored nodes are capped at 8× that so memory stays bounded.
export function bfsSolve(initialState, { maxDepth = 30, maxNodes = 60000, targetColor = null } = {}) {
  const enc = encodeState(initialState);
  const n = enc.n;
  const core = makeCore(n);
  core.decode(enc.baseKey);
  if (core.isWonNow(targetColor)) return [];
  if (enc.cursor < 0) return null; // cursorId matches no cube: nothing can move

  core.islandFrom(enc.cursor);
  const rootKey = enc.baseKey + String.fromCharCode(core.islandMin);

  // Node store (parallel arrays; parent pointers for path reconstruction).
  const keys = [rootKey], cursors = [enc.cursor], depths = [0], parents = [-1],
    moveFroms = [0], moveDirs = [0];
  const gBest = new Map([[rootKey, 0]]);
  const maxStored = maxNodes * 8;

  // Root heuristic seeds the first bucket.
  const sums = new Int16Array(6); // Σ MIN_ROLLS per colour, for the expanded node
  let h0;
  {
    for (let t = 0; t < 6; t++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += MIN_ROLLS[core.oris[i] * 6 + t];
      sums[t] = s;
    }
    let colorLB = sums[targetColor ?? 0];
    if (targetColor == null) for (let t = 1; t < 6; t++) colorLB = Math.min(colorLB, sums[t]);
    h0 = Math.max(colorLB, ((core.componentsAll() + 1) / 3) | 0);
  }
  const buckets = [];
  (buckets[h0] ??= []).push(0);
  let highestF = h0; // stop once every reachable bucket is drained

  let expansions = 0;
  for (let f = h0; f <= maxDepth && f <= highestF; f++) {
    const bucket = buckets[f];
    if (!bucket) continue;
    // Children with f' = f land in this same bucket and are drained here too.
    for (let bi = 0; bi < bucket.length; bi++) {
      const ni = bucket[bi];
      const g = depths[ni];
      if (g > gBest.get(keys[ni])) continue;                          // stale duplicate
      if (g === f) return movesFromTrail(ni, parents, moveFroms, moveDirs, initialState); // h=0 ⇒ solved
      if (expansions++ >= maxNodes) return null;                      // search budget blown

      core.decode(keys[ni]);
      for (let t = 0; t < 6; t++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += MIN_ROLLS[core.oris[i] * 6 + t];
        sums[t] = s;
      }
      core.islandFrom(cursors[ni]);
      const islandSize = core.islandSize;
      const undoFrom = parents[ni] !== -1 ? cursors[ni] : -1;
      const undoDir = parents[ni] !== -1 ? OPP_DIR[moveDirs[ni]] : -1;

      for (let ci = 0; ci < islandSize; ci++) {
        const from = core.islandCells[ci];
        const i = core.grid[from] - 1;
        const oldOri = core.oris[i];
        for (let d = 0; d < 4; d++) {
          if (from === undoFrom && d === undoDir) continue; // would recreate the grandparent state
          const to = CELL_NEXT[from * 4 + d];
          if (to < 0 || core.grid[to] !== 0) continue;
          const newOri = ORI_NEXT[oldOri][d];

          let colorLB;
          if (targetColor != null) {
            colorLB = sums[targetColor] - MIN_ROLLS[oldOri * 6 + targetColor] + MIN_ROLLS[newOri * 6 + targetColor];
          } else {
            colorLB = 99;
            for (let t = 0; t < 6; t++) {
              const v = sums[t] - MIN_ROLLS[oldOri * 6 + t] + MIN_ROLLS[newOri * 6 + t];
              if (v < colorLB) colorLB = v;
            }
          }
          core.childStats(i, from, to);
          const h = Math.max(colorLB, ((core.childComps + 1) / 3) | 0);
          const childG = g + 1;
          if (childG + h > maxDepth) continue; // provably cannot finish within maxDepth

          const key = core.childKey(i, to, newOri);
          const known = gBest.get(key);
          if (known !== undefined && known <= childG) continue;
          gBest.set(key, childG);

          if (keys.length >= maxStored) return null; // memory budget blown — bail out
          const idx = keys.length;
          keys.push(key); cursors.push(to); depths.push(childG); parents.push(ni);
          moveFroms.push(from); moveDirs.push(d);
          const childF = childG + h;
          if (childF > highestF) highestF = childF;
          (buckets[childF] ??= []).push(idx);
        }
      }
    }
  }
  return null;
}

/* --- Beam search (approximate, tight upper bound) ----------------------------- */

// Greedy best-first beam: keep the `width` most promising states per depth
// layer, ranked by colour gap + extra islands (lower = closer to solved). The
// colour gap counts cubes NOT showing the goal top colour — the required
// targetColor when one is set, otherwise the most-common one. Not optimal, but
// it solves boards the simple greedy solver gets stuck on and returns a tight
// upper bound on the roll count.
//
// Determinism matters here: beam results feed the persisted per-puzzle
// difficulty signals, so the expansion order (cursor-island cells in islandOf
// order, then DIRS order), the dedup equivalence and the stable ranking sort
// are kept exactly as they have always been.
// Returns [{id, dir}, …] or null if no solution was found within the budget.
export function beamSolve(initialState, { width = 300, maxDepth = 80, targetColor = null } = {}) {
  const enc = encodeState(initialState);
  const n = enc.n;
  const core = makeCore(n);
  core.decode(enc.baseKey);
  if (core.isWonNow(targetColor)) return [];
  if (enc.cursor < 0) return null;

  core.islandFrom(enc.cursor);
  const rootKey = enc.baseKey + String.fromCharCode(core.islandMin);

  const keys = [rootKey], cursors = [enc.cursor], parents = [-1], moveFroms = [0], moveDirs = [0];
  const seen = new Set([rootKey]);
  let frontier = [0]; // indices into the node store

  for (let depth = 0; depth < maxDepth; depth++) {
    const children = [];
    const ests = [];
    for (const ni of frontier) {
      core.decode(keys[ni]);
      core.islandFrom(cursors[ni]);
      const islandSize = core.islandSize;
      const undoFrom = parents[ni] !== -1 ? cursors[ni] : -1;
      const undoDir = parents[ni] !== -1 ? OPP_DIR[moveDirs[ni]] : -1;

      for (let ci = 0; ci < islandSize; ci++) {
        const from = core.islandCells[ci];
        const i = core.grid[from] - 1;
        for (let d = 0; d < 4; d++) {
          if (from === undoFrom && d === undoDir) continue; // grandparent state, always in `seen`
          const to = CELL_NEXT[from * 4 + d];
          if (to < 0 || core.grid[to] !== 0) continue;
          const newOri = ORI_NEXT[core.oris[i]][d];

          core.childStats(i, from, to);
          const key = core.childKey(i, to, newOri);
          if (seen.has(key)) continue;
          seen.add(key);

          const idx = keys.length;
          keys.push(key); cursors.push(to); parents.push(ni);
          moveFroms.push(from); moveDirs.push(d);

          const modeCount = core.childTopCounts(i, newOri);
          const uniform = targetColor == null ? modeCount === n : core.counts[targetColor] === n;
          if (uniform && core.childComps === 1) {
            return movesFromTrail(idx, parents, moveFroms, moveDirs, initialState);
          }
          children.push(idx);
          const gapCount = targetColor != null ? core.counts[targetColor] : modeCount;
          ests.push(n - gapCount + core.childComps - 1);
        }
      }
    }
    if (!children.length) return null;
    // Keep only the most promising `width` states for the next layer. Scores
    // were computed once per child, not inside the comparator, and
    // Array.prototype.sort is spec-guaranteed stable (ES2019), so ties resolve
    // by insertion order — keeping this solver deterministic, which matters
    // for reproducible difficulty values.
    const order = children.map((_, j) => j);
    order.sort((a, b) => ests[a] - ests[b]);
    frontier = [];
    for (let j = 0; j < order.length && j < width; j++) frontier.push(children[order[j]]);
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
export function greedySolve(initialState, { maxMoves = 300, targetColor: wanted = null } = {}) {
  let state = initialState;
  const allMoves = [];
  const targetColor = wanted ?? pickTargetColor(state.cubes);
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
