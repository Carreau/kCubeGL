/* ============================================================================
 * level-gen.mjs — pure, dependency-free level generation.
 *
 * THE single source of truth for how a catalogue puzzle's board is built and
 * scrambled. It is imported by BOTH:
 *   - the browser game (src/main.js), which lifts the plain-array quaternions
 *     this module returns into THREE.Quaternion at the edge for rendering, and
 *   - the pure solver bridge (src/catalog-solve.mjs), which turns the result
 *     into a solver state.
 *
 * Because both consumers share this code, the board a player sees and the board
 * the server solves for difficulty signals can never drift apart. Keep it pure:
 * no THREE.js, no DOM — just seeded math, like src/shared.mjs and src/solver.mjs.
 *
 * Orientation is stored as a quaternion [x, y, z, w] (Three.js conventions) so
 * the browser can hand it straight to THREE.Quaternion.fromArray().
 * ========================================================================== */

import { mulberry32, shuffle, BOARD, NEI, OPPOSITE, inBounds } from "./shared.mjs";

// Fixed mapping from a cube's LOCAL face axis -> colour id. Order matches a
// BoxGeometry's material groups (+X,-X,+Y,-Y,+Z,-Z) and main.js's FACE_MATERIALS.
//   +X red(2), -X orange(3), +Y white(0), -Y yellow(1), +Z blue(4), -Z green(5)
export const FACE_AXES = [
  { v: [1, 0, 0], color: 2 },
  { v: [-1, 0, 0], color: 3 },
  { v: [0, 1, 0], color: 0 }, // solved colour: +Y up
  { v: [0, -1, 0], color: 1 },
  { v: [0, 0, 1], color: 4 },
  { v: [0, 0, -1], color: 5 },
];
const WORLD_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Arrow directions: board delta (dr/dc) + the tip-over rotation (axis + angle).
// Key ORDER is significant — scrambleRoll() shuffles Object.keys(DIRS) from the
// seeded PRNG, so the order is part of the reproducible random stream.
export const DIRS = {
  ArrowRight: { dr: 0, dc: 1, axis: [0, 0, 1], angle: -Math.PI / 2 },
  ArrowLeft: { dr: 0, dc: -1, axis: [0, 0, 1], angle: Math.PI / 2 },
  ArrowUp: { dr: -1, dc: 0, axis: [1, 0, 0], angle: -Math.PI / 2 },
  ArrowDown: { dr: 1, dc: 0, axis: [1, 0, 0], angle: Math.PI / 2 },
};

/* --- minimal quaternion math, stored as [x, y, z, w] (Three.js conventions) - */

export function qAxisAngle(axis, angle) {
  const h = angle / 2, s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

// a * b (Three.js multiplyQuaternions).
export function qMul(a, b) {
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

// Quaternion -> solver face array [+X,-X,+Y,-Y,+Z,-Z] of colour ids. faces[2]
// is the top colour (the win criterion). `q` is a plain [x,y,z,w] array.
export function quatToFaces(q) {
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

// A quaternion that rotates a cube so the face with `colorId` points up (+Y).
function faceUpQuat(colorId) {
  const face = FACE_AXES.find((f) => f.color === colorId);
  return qFromUnitVectors(face.v, [0, 1, 0]);
}

/* --- board helpers ---------------------------------------------------------- */

function cubeAt(cubes, r, c) { return cubes.find((k) => k.row === r && k.col === c) || null; }
function occupied(cubes, r, c) { return cubes.some((k) => k.row === r && k.col === c); }

// Grow a random 4-connected blob of n cells from the board centre. `rint(n)`
// returns an integer in [0, n) from the puzzle's seeded PRNG.
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

// All cubes 4-connected to `cube` (its island), including `cube` itself.
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

// Are the given [row,col] cells a single 4-connected (N/S/E/W) block?
export function cellsConnected(cells) {
  if (cells.length <= 1) return true;
  const set = new Set(cells.map(([r, c]) => r * BOARD + c));
  const seen = new Set();
  const stack = [cells[0]];
  seen.add(cells[0][0] * BOARD + cells[0][1]);
  while (stack.length) {
    const [r, c] = stack.pop();
    for (const [dr, dc] of NEI) {
      const nr = r + dr, nc = c + dc;
      // Bounds-check BEFORE encoding: r*BOARD+c with an off-board nc wraps onto a
      // neighbouring row's cell, which would falsely bridge two disjoint islands.
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
function applyRoll(cube, dir, nr, nc) {
  cube.quat = qMul(qAxisAngle(dir.axis, dir.angle), cube.quat);
  cube.row = nr;
  cube.col = nc;
}

// Pick a random on-board, empty direction for `cube` (skipping forbidKey, the
// exact-opposite of its last roll) and apply it. Returns the key used, or null.
function scrambleRoll(cubes, cube, rng, forbidKey) {
  const keys = shuffle(Object.keys(DIRS), rng);
  for (const k of keys) {
    if (k === forbidKey) continue;
    const d = DIRS[k];
    const nr = cube.row + d.dr, nc = cube.col + d.dc;
    if (!inBounds(nr, nc) || occupied(cubes, nr, nc)) continue;
    applyRoll(cube, d, nr, nc);
    return k;
  }
  return null;
}

/* --- the generator ---------------------------------------------------------- */

/* Build a catalogue puzzle's scrambled start. Start from a solved board (all
 * cubes the target colour up, in one contiguous block), then apply `scramble`
 * random reverse-rolls — each from the current cursor cube's island, so the
 * reversed sequence is a route a human cursor can actually walk back.
 *
 * Every random draw uses the puzzle's seeded PRNG in a fixed order, so the board
 * is identical on every device. Returns:
 *   {
 *     targetColor,                                  // the "solved" colour id
 *     cubes:    [{ row, col, quat:[x,y,z,w] }],     // scrambled state, creation order
 *     scramble: [{ cubeIndex, key }],               // the reverse-rolls, in order
 *     cursorIndex,                                  // start cursor (last-scrambled cube)
 *   }
 * The stored solution is `scramble` reversed with each key flipped via OPPOSITE. */
export function generateLevel(config) {
  const rng = mulberry32(config.seed);
  const rint = (n) => Math.floor(rng() * n);

  const targetColor = rint(FACE_AXES.length); // 6 colours
  const cells = connectedCells(config.numCubes, rint);

  // Solved orientation + a per-cube random Y-spin (0/90/180/270°) so side faces
  // vary even when the top colour is fixed. copy(baseQ).premultiply(yQ) === yQ*baseQ.
  const baseQ = faceUpQuat(targetColor);
  const cubes = cells.map(([r, c]) => {
    const yQ = qAxisAngle([0, 1, 0], rint(4) * (Math.PI / 2));
    return { row: r, col: c, quat: qMul(yQ, baseQ) };
  });

  const scrambleMoves = [];
  let cursorCube = cubes[0];
  let applied = 0, guard = 0;
  while (applied < config.scramble && guard < config.scramble * 40) {
    guard++;
    const island = shuffle(islandOf(cubes, cursorCube), rng);
    const prev = scrambleMoves[scrambleMoves.length - 1];
    let rolled = null;
    for (const cube of island) {
      const forbid = prev && prev.cube === cube ? OPPOSITE[prev.key] : null;
      const k = scrambleRoll(cubes, cube, rng, forbid);
      if (k) { rolled = { cube, key: k }; break; }
    }
    if (!rolled) continue; // island fully boxed in (rare) — retry, guard bounds it
    scrambleMoves.push(rolled);
    cursorCube = rolled.cube;
    applied++;
  }

  // If luck produced an already-solved board, nudge from the cursor's island so
  // the extra move stays cursor-reachable — and RE-CHECK: a single nudge can
  // leave the board solved (e.g. a one-cube board is uniform whatever its top),
  // so loop with a small guard rather than nudging blindly once.
  for (let nudges = 0; isSolved(cubes) && nudges < 8; nudges++) {
    const prev = scrambleMoves[scrambleMoves.length - 1];
    let rolled = null;
    for (const cube of shuffle(islandOf(cubes, cursorCube), rng)) {
      const forbid = prev && prev.cube === cube ? OPPOSITE[prev.key] : null;
      const k = scrambleRoll(cubes, cube, rng, forbid);
      if (k) { rolled = { cube, key: k }; break; }
    }
    if (!rolled) break; // island boxed in — nothing more we can do
    scrambleMoves.push(rolled);
    cursorCube = rolled.cube;
  }

  // The game starts the cursor on the last-scrambled cube (solution[0].cube).
  const firstCube = scrambleMoves.length
    ? scrambleMoves[scrambleMoves.length - 1].cube : cubes[0];

  return {
    targetColor,
    cubes: cubes.map((c) => ({ row: c.row, col: c.col, quat: c.quat })),
    scramble: scrambleMoves.map((m) => ({ cubeIndex: cubes.indexOf(m.cube), key: m.key })),
    cursorIndex: cubes.indexOf(firstCube),
  };
}
