/* Unit tests for the pure engine modules (no server, no browser, no Three.js).
 *
 * Covers:
 *   1. Catalogue determinism — buildCatalog() is stable call-to-call AND across
 *      time: a few entries are snapshot-asserted against hardcoded values so an
 *      accidental PRNG/word-list change (which would silently reshuffle every
 *      puzzle and break all leaderboards) fails loudly here.
 *   2. Solvability — for EVERY catalogue puzzle, generateLevel() then replay of
 *      the stored reverse solution lands on a uniform-top, connected board.
 *   3. Solver sanity — on small boards, bfsSolve finds a solution no longer
 *      than beamSolve's, and applying it actually wins.
 *   4. Solver/engine equivalence — the face permutation a roll induces matches
 *      the quaternion tip-over math for arbitrary orientations.
 *
 * Same conventions as test/api.mjs: ok/eq helpers, exit non-zero on failure.
 */
import { buildCatalog, CATALOG_SIZE, OPPOSITE, budgetFor, cellsConnected } from "../src/shared.mjs";
import { generateLevel, quatToFaces, qMul, qAxisAngle, DIRS } from "../src/level-gen.mjs";
import { bfsSolve, beamSolve } from "../src/solver.mjs";
import { buildCatalogState } from "../src/catalog-solve.mjs";

let passed = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { passed++; } else { fails.push(msg); console.error("✗ " + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

try {
  /* --- 1. Catalogue determinism ------------------------------------------- */

  const cat = buildCatalog();
  const cat2 = buildCatalog();
  eq(cat.length, CATALOG_SIZE, "catalogue has CATALOG_SIZE puzzles");
  eq(CATALOG_SIZE, 40, "CATALOG_SIZE is 40");
  eq(JSON.stringify(cat), JSON.stringify(cat2), "buildCatalog() is deterministic call-to-call");

  // Snapshot guard: these exact values are what every deployed client/server
  // derives today. If any of these fail, the PRNG stream drifted — every
  // puzzle, name and leaderboard key would change. Do NOT "fix" the test by
  // updating the numbers unless that breakage is intended and understood.
  const SNAPSHOT = {
    0:  { name: "ochre-bramble", seed: 859324183,  numCubes: 15, scramble: 19 },
    1:  { name: "velvet-comet",  seed: 3283898973, numCubes: 11, scramble: 19 },
    19: { name: "tidal-maple",   seed: 142049399,  numCubes: 2,  scramble: 11 },
    39: { name: "plucky-falcon", seed: 3917808907, numCubes: 3,  scramble: 10 },
  };
  for (const [idx, want] of Object.entries(SNAPSHOT)) {
    const p = cat[Number(idx)];
    eq(p.name, want.name, `catalogue[${idx}].name snapshot`);
    eq(p.seed, want.seed, `catalogue[${idx}].seed snapshot`);
    eq(p.numCubes, want.numCubes, `catalogue[${idx}].numCubes snapshot`);
    eq(p.scramble, want.scramble, `catalogue[${idx}].scramble snapshot`);
  }

  eq(new Set(cat.map((p) => p.name)).size, cat.length, "all catalogue names are unique");
  ok(cat.every((p) => p.numCubes >= 2 && p.numCubes <= 16), "numCubes within 2..16 for every puzzle");
  ok(cat.every((p) => p.scramble >= 4 && p.scramble <= 30), "scramble within 4..30 for every puzzle");
  ok(cat.every((p) => p.par === budgetFor(p.numCubes, p.scramble)), "par = budgetFor(numCubes, scramble) for every puzzle");
  ok(cat.every((p, i) => p.order === i + 1), "order is the 1-based catalogue position");
  ok(cat.every((p) => /^[a-z0-9-]+$/.test(p.name)), "names are URL-safe lowercase handles");

  /* --- helpers shared by 2–4 ----------------------------------------------- */

  // Replay one roll on a generated cube ({r, c, quat}) — exactly what the
  // game does: premultiply the tip-over quaternion and step one cell.
  function rollGenCube(cube, key) {
    const d = DIRS[key];
    return {
      r: cube.r + d.dr,
      c: cube.c + d.dc,
      quat: qMul(qAxisAngle(d.axis, d.angle), cube.quat),
    };
  }

  const topOf = (cube) => quatToFaces(cube.quat)[2];
  const isUniformConnected = (cubes) =>
    cubes.every((c) => topOf(c) === topOf(cubes[0])) &&
    cellsConnected(cubes.map((c) => [c.r, c.c]));

  /* --- 2. Solvability of every catalogue puzzle ---------------------------- */

  for (const p of cat) {
    const gen = generateLevel(p);
    eq(gen.cubes.length, p.numCubes, `${p.name}: generates numCubes cubes`);
    ok(gen.scramble.length >= p.scramble, `${p.name}: scramble has at least the configured length`);
    ok(!isUniformConnected(gen.cubes), `${p.name}: scrambled start is not already solved`);

    // The stored solution is the scramble reversed, each key flipped.
    const cubes = gen.cubes.map((c) => ({ ...c }));
    const solution = gen.scramble.slice().reverse()
      .map((m) => ({ cubeIndex: m.cubeIndex, key: OPPOSITE[m.key] }));
    let legal = true;
    const occupied = (r, c, skip) => cubes.some((k, i) => i !== skip && k.r === r && k.c === c);
    for (const m of solution) {
      const next = rollGenCube(cubes[m.cubeIndex], m.key);
      if (occupied(next.r, next.c, m.cubeIndex)) { legal = false; break; }
      cubes[m.cubeIndex] = next;
    }
    ok(legal, `${p.name}: replaying the stored solution never rolls into an occupied cell`);
    ok(isUniformConnected(cubes), `${p.name}: stored solution solves the board (uniform top + connected)`);
    ok(solution.length <= p.par, `${p.name}: solution length fits within par`);
  }

  /* --- 3. Solver sanity on small boards ------------------------------------ */

  const small = cat.filter((p) => p.scramble <= 12 && p.numCubes <= 6).slice(0, 3);
  ok(small.length >= 2, "catalogue has small boards for solver sanity checks");
  for (const p of small) {
    const { state, solutionLen } = buildCatalogState(p);
    const bfs = bfsSolve(state);
    ok(Array.isArray(bfs) && bfs.length > 0, `${p.name}: bfsSolve finds a solution`);
    if (!bfs) continue;
    ok(bfs.length <= solutionLen, `${p.name}: BFS-optimal is no longer than the stored solution`);
    const beam = beamSolve(state);
    ok(Array.isArray(beam), `${p.name}: beamSolve finds a solution`);
    if (beam) ok(bfs.length <= beam.length, `${p.name}: bfs length <= beam length`);

    // Apply the BFS solution with the engine's quaternion math (NOT the
    // solver's own permutation tables) and check it really wins — so the two
    // representations are verified against each other end-to-end.
    const gen = generateLevel(p);
    const cubes = gen.cubes.map((c) => ({ ...c }));
    const byId = (id) => cubes[id]; // catalog state ids are generation indices
    let valid = true;
    for (const mv of bfs) {
      const next = rollGenCube(byId(mv.id), mv.dir);
      if (cubes.some((k, i) => i !== mv.id && k.r === next.r && k.c === next.c)) { valid = false; break; }
      cubes[mv.id] = next;
    }
    ok(valid, `${p.name}: BFS solution is legal on the real board`);
    ok(isUniformConnected(cubes), `${p.name}: BFS solution wins on the real board`);
  }

  /* --- 4. Solver/engine roll equivalence ------------------------------------ */

  // For each direction, the face permutation induced by a roll must match the
  // engine's quaternion tip-over for ANY orientation, not just identity.
  // Walk a cube through a few rolls and check faces stay in lockstep with the
  // permutation derived from the identity orientation.
  {
    const idFaces = quatToFaces([0, 0, 0, 1]);
    const perms = {};
    for (const [key, d] of Object.entries(DIRS)) {
      const rolled = quatToFaces(qMul(qAxisAngle(d.axis, d.angle), [0, 0, 0, 1]));
      perms[key] = rolled.map((color) => idFaces.indexOf(color));
    }
    // A non-identity starting orientation: tipped right then up.
    let q = qMul(qAxisAngle(DIRS.ArrowUp.axis, DIRS.ArrowUp.angle),
      qMul(qAxisAngle(DIRS.ArrowRight.axis, DIRS.ArrowRight.angle), [0, 0, 0, 1]));
    let faces = quatToFaces(q);
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowLeft", "ArrowUp", "ArrowRight"]) {
      q = qMul(qAxisAngle(DIRS[key].axis, DIRS[key].angle), q);
      faces = perms[key].map((i) => faces[i]);
      eq(faces.join(","), quatToFaces(q).join(","), `roll permutation matches quaternion math after ${key}`);
    }
    // Rolling then unrolling is the identity permutation.
    for (const [key, opp] of Object.entries(OPPOSITE)) {
      const roundTrip = perms[key].map((i) => perms[opp][i]);
      eq(roundTrip.join(","), "0,1,2,3,4,5", `${key} then ${opp} restores the orientation`);
    }
  }
} catch (e) {
  fails.push("threw: " + (e && e.stack ? e.stack : e));
  console.error(e);
}

if (fails.length) { console.error(`\nUnit test FAILED — ${fails.length} failed, ${passed} passed.`); process.exit(1); }
console.log(`✓ Unit test passed (${passed} assertions).`);
