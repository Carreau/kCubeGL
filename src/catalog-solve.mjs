/* ============================================================================
 * catalog-solve.mjs — pure (no Three.js, no DOM) reproduction of a catalogue
 * puzzle's scrambled board, plus its BFS-optimal and greedy solve lengths.
 *
 * The browser game builds boards with Three.js quaternions (src/main.js); the
 * Node backend has no Three.js. This module reproduces buildLevel() faithfully
 * with a tiny self-contained quaternion implementation, drawing every random
 * choice from the same seeded PRNG in the same order. The board it produces —
 * and therefore the solver lengths — match exactly what a player sees, so the
 * admin panel can show real difficulty signals.
 *
 * Imported by both the server (difficulty seeding) and, in principle, any tool;
 * it is dependency-free and pure, like src/shared.mjs and src/solver.mjs.
 * ========================================================================== */

import { mulberry32, shuffle } from "./shared.mjs";
import { bfsSolve, beamSolve } from "./solver.mjs";

const BOARD = 5;
const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Local face axis -> colour id (mirrors FACE_AXES in main.js).
//   +X red(2), -X orange(3), +Y white(0), -Y yellow(1), +Z blue(4), -Z green(5)
const FACE_AXES = [
  { v: [1, 0, 0], color: 2 },
  { v: [-1, 0, 0], color: 3 },
  { v: [0, 1, 0], color: 0 },
  { v: [0, -1, 0], color: 1 },
  { v: [0, 0, 1], color: 4 },
  { v: [0, 0, -1], color: 5 },
];
const WORLD_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Arrow directions with board deltas and tip-over rotation (axis + angle),
// matching DIRS in main.js. Key ORDER matters: shuffle() draws from the PRNG in
// this exact order, so it must equal Object.keys(DIRS) in main.js.
const DIRS = {
  ArrowRight: { dr: 0, dc: 1, axis: [0, 0, 1], angle: -Math.PI / 2 },
  ArrowLeft: { dr: 0, dc: -1, axis: [0, 0, 1], angle: Math.PI / 2 },
  ArrowUp: { dr: -1, dc: 0, axis: [1, 0, 0], angle: -Math.PI / 2 },
  ArrowDown: { dr: 1, dc: 0, axis: [1, 0, 0], angle: Math.PI / 2 },
};
const OPPOSITE = {
  ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight",
  ArrowUp: "ArrowDown", ArrowDown: "ArrowUp",
};

/* --- minimal quaternion math, stored as [x, y, z, w] (Three.js conventions) - */

function qAxisAngle(axis, angle) {
  const h = angle / 2, s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

// a * b (Three.js multiplyQuaternions).
function qMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

// Three.js Quaternion.setFromUnitVectors(from -> to); from/to are unit vectors.
function qFromUnitVectors(from, to) {
  const EPS = 0.000001;
  let r = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + 1;
  let x, y, z, w;
  if (r < EPS) {
    // from and to point in opposite directions: pick any perpendicular axis.
    r = 0;
    if (Math.abs(from[0]) > Math.abs(from[2])) { x = -from[1]; y = from[0]; z = 0; w = r; }
    else { x = 0; y = -from[2]; z = from[1]; w = r; }
  } else {
    x = from[1] * to[2] - from[2] * to[1];
    y = from[2] * to[0] - from[0] * to[2];
    z = from[0] * to[1] - from[1] * to[0];
    w = r;
  }
  return qNorm([x, y, z, w]);
}

// Three.js Vector3.applyQuaternion: rotate v by quaternion q.
function applyQuat(q, v) {
  const [vx, vy, vz] = v, [qx, qy, qz, qw] = q;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

// Quaternion -> solver face array [+X,-X,+Y,-Y,+Z,-Z] of colour ids (matches
// quatToFaces in main.js). faces[2] is the top colour.
function quatToFaces(q) {
  const faces = new Array(6);
  for (const fa of FACE_AXES) {
    const w = applyQuat(q, fa.v);
    let best = 0, bestDot = -Infinity;
    for (let i = 0; i < 6; i++) {
      const d = w[0] * WORLD_DIRS[i][0] + w[1] * WORLD_DIRS[i][1] + w[2] * WORLD_DIRS[i][2];
      if (d > bestDot) { bestDot = d; best = i; }
    }
    faces[best] = fa.color;
  }
  return faces;
}

function faceUpQuat(colorId) {
  const face = FACE_AXES.find((f) => f.color === colorId);
  return qFromUnitVectors(face.v, [0, 1, 0]);
}

/* --- board helpers (pure mirrors of the same helpers in main.js) ------------ */

function inBounds(r, c) { return r >= 0 && r < BOARD && c >= 0 && c < BOARD; }
function cubeAt(cubes, r, c) { return cubes.find((k) => k.row === r && k.col === c) || null; }
function occupied(cubes, r, c) { return cubes.some((k) => k.row === r && k.col === c); }

function connectedCells(n, rint) {
  const mid = Math.floor(BOARD / 2);
  const inSet = new Set([mid * BOARD + mid]);
  const chosen = [[mid, mid]];
  const frontier = [];
  const pushNei = (r, c) => {
    for (const [dr, dc] of NEI) {
      const nr = r + dr, nc = c + dc;
      if (inBounds(nr, nc) && !inSet.has(nr * BOARD + nc)) frontier.push([nr, nc]);
    }
  };
  pushNei(mid, mid);
  while (chosen.length < n && frontier.length) {
    const [r, c] = frontier.splice(rint(frontier.length), 1)[0];
    const k = r * BOARD + c;
    if (inSet.has(k)) continue;
    inSet.add(k);
    chosen.push([r, c]);
    pushNei(r, c);
  }
  return chosen;
}

function islandOf(cubes, cube) {
  const island = [cube];
  const seen = new Set([cube]);
  for (let i = 0; i < island.length; i++) {
    const c = island[i];
    for (const [dr, dc] of NEI) {
      const n = cubeAt(cubes, c.row + dr, c.col + dc);
      if (n && !seen.has(n)) { seen.add(n); island.push(n); }
    }
  }
  return island;
}

function cellsConnected(cells) {
  if (cells.length <= 1) return true;
  const set = new Set(cells.map(([r, c]) => r * BOARD + c));
  const seen = new Set();
  const stack = [cells[0]];
  seen.add(cells[0][0] * BOARD + cells[0][1]);
  while (stack.length) {
    const [r, c] = stack.pop();
    for (const [dr, dc] of NEI) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const k = nr * BOARD + nc;
      if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push([nr, nc]); }
    }
  }
  return seen.size === set.size;
}

function topColorOf(cube) { return quatToFaces(cube.quat)[2]; }

function isSolved(cubes) {
  if (!cubes.length) return false;
  const t = topColorOf(cubes[0]);
  return cubes.every((c) => topColorOf(c) === t) &&
    cellsConnected(cubes.map((c) => [c.row, c.col]));
}

// Apply a roll: premultiply the cube's orientation and move it one cell.
function applyRollLogic(cube, dir, nr, nc) {
  cube.quat = qMul(qAxisAngle(dir.axis, dir.angle), cube.quat);
  cube.row = nr;
  cube.col = nc;
}

function scrambleRoll(cubes, cube, rng, forbidKey) {
  const keys = shuffle(Object.keys(DIRS), rng);
  for (const k of keys) {
    if (k === forbidKey) continue;
    const d = DIRS[k];
    const nr = cube.row + d.dr, nc = cube.col + d.dc;
    if (!inBounds(nr, nc) || occupied(cubes, nr, nc)) continue;
    applyRollLogic(cube, d, nr, nc);
    return k;
  }
  return null;
}

/* --- the faithful buildLevel reproduction ----------------------------------- */

// Reproduce a catalogue puzzle's scrambled start as a pure solver state. Every
// PRNG draw mirrors buildLevel() in main.js, in the same order, so the board is
// identical to the one the player sees. Returns { state, solutionLen } where
// solutionLen is the stored scramble-reverse solution length.
export function buildCatalogState(config) {
  const rng = mulberry32(config.seed);
  const rint = (n) => Math.floor(rng() * n);

  const targetColorId = rint(6); // COLORS.length
  const cells = connectedCells(config.numCubes, rint);

  const baseQ = faceUpQuat(targetColorId);
  const cubes = cells.map(([r, c]) => {
    // copy(baseQ).premultiply(yQ) === yQ * baseQ
    const yQ = qAxisAngle([0, 1, 0], rint(4) * (Math.PI / 2));
    return { row: r, col: c, quat: qMul(yQ, baseQ) };
  });

  const scrambleMoves = [];
  let cursorCube = cubes[0];
  let applied = 0, guard = 0;
  const scramble = config.scramble;
  while (applied < scramble && guard < scramble * 40) {
    guard++;
    const island = shuffle(islandOf(cubes, cursorCube), rng);
    const prev = scrambleMoves[scrambleMoves.length - 1];
    let rolled = null;
    for (const cube of island) {
      const forbid = prev && prev.cube === cube ? OPPOSITE[prev.key] : null;
      const k = scrambleRoll(cubes, cube, rng, forbid);
      if (k) { rolled = { cube, key: k }; break; }
    }
    if (!rolled) continue;
    scrambleMoves.push(rolled);
    cursorCube = rolled.cube;
    applied++;
  }

  if (isSolved(cubes)) {
    const prev = scrambleMoves[scrambleMoves.length - 1];
    for (const cube of shuffle(islandOf(cubes, cursorCube), rng)) {
      const forbid = prev && prev.cube === cube ? OPPOSITE[prev.key] : null;
      const k = scrambleRoll(cubes, cube, rng, forbid);
      if (k) { scrambleMoves.push({ cube, key: k }); break; }
    }
  }

  // The game starts the cursor on solution[0].cube — the last-scrambled cube.
  const firstCube = scrambleMoves.length
    ? scrambleMoves[scrambleMoves.length - 1].cube : cubes[0];

  return {
    state: {
      cubes: cubes.map((c, i) => ({ id: i, r: c.row, c: c.col, faces: quatToFaces(c.quat) })),
      cursorId: cubes.indexOf(firstCube),
    },
    solutionLen: scrambleMoves.length,
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
