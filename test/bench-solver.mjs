/* Solver benchmark + behaviour fingerprint. Not part of `npm test` — run by hand:
 *
 *   node test/bench-solver.mjs            # quick set (small/medium boards)
 *   node test/bench-solver.mjs --full     # adds the hardest catalogue boards
 *
 * Prints per-puzzle timings for bfsSolve / beamSolve / minBeamWidthToSolve plus
 * a fingerprint of every beam solution (cube-id + dir sequence). The fingerprint
 * is the contract check for refactors: beamSolve feeds the persisted difficulty
 * signals, so a rewrite must reproduce the exact same move sequences.
 */
import { buildCatalog } from "../src/shared.mjs";
import { bfsSolve, beamSolve, minBeamWidthToSolve } from "../src/solver.mjs";
import { buildCatalogState } from "../src/catalog-solve.mjs";

const FULL = process.argv.includes("--full");

const cat = buildCatalog();
// A spread of difficulties: every puzzle keyed by cubes×scramble buckets.
const byLoad = cat.slice().sort((a, b) => a.numCubes * a.scramble - b.numCubes * b.scramble);
const picks = FULL
  ? [...byLoad.slice(0, 4), ...byLoad.slice(18, 22), ...byLoad.slice(-4)]
  : [...byLoad.slice(0, 4), ...byLoad.slice(18, 22)];

function ms(t0) { return (performance.now() - t0).toFixed(1).padStart(8); }
function fingerprint(moves) {
  if (!moves) return "null";
  return moves.map((m) => `${m.id}${m.dir.replace("Arrow", "")[0]}`).join(".");
}

let totalMs = 0;
const fingerprints = {};
for (const p of picks) {
  const { state } = buildCatalogState(p);
  const label = `${p.name} (${p.numCubes}c/${p.scramble}s)`.padEnd(28);

  let t0 = performance.now();
  const bfs = bfsSolve(state);
  const bfsMs = performance.now() - t0;

  t0 = performance.now();
  const beam = beamSolve(state);
  const beamMs = performance.now() - t0;

  t0 = performance.now();
  const eff = minBeamWidthToSolve(state);
  const effMs = performance.now() - t0;

  totalMs += bfsMs + beamMs + effMs;
  fingerprints[p.name] = fingerprint(beam);
  console.log(
    `${label} bfs ${String(bfs ? bfs.length : "-").padStart(3)} ${bfsMs.toFixed(1).padStart(8)}ms` +
    ` | beam ${String(beam ? beam.length : "-").padStart(3)} ${beamMs.toFixed(1).padStart(8)}ms` +
    ` | width ${String(eff ? eff.width : "-").padStart(4)} ${effMs.toFixed(1).padStart(8)}ms`
  );
}
console.log(`\nTOTAL ${totalMs.toFixed(0)}ms`);
console.log("beam fingerprints (must be stable across refactors):");
console.log(JSON.stringify(fingerprints, null, 1));
