/* ============================================================================
 * Shared, dependency-free game math.
 *
 * This module is imported BOTH by the browser game (src/main.js) and by the
 * Node backend (server/*). It therefore must not import Three.js or touch the
 * DOM — only pure functions a server can run too.
 *
 * Its job is to make every level a *stable, named puzzle*: level N is the same
 * board for every player, so best-scores can be compared on a leaderboard and a
 * puzzle's difficulty can be measured across users. We get that by seeding all
 * the level's randomness from the level number with a small deterministic PRNG.
 * ========================================================================== */

export const BOARD = 5; // 5×5 grid (kept in sync with src/main.js)

/* mulberry32 — a tiny, fast, deterministic 32-bit PRNG. Same seed ⇒ same
 * stream on every machine, which is what makes a level reproducible. Returns a
 * function yielding floats in [0, 1) just like Math.random. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Spread a small, sequential level index into a well-distributed 32-bit seed so
 * neighbouring levels don't produce near-identical scrambles. */
export function hashLevelSeed(level) {
  let h = (level >>> 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/* A fresh seeded PRNG for a given level. */
export function levelRng(level) {
  return mulberry32(hashLevelSeed(level));
}

/* How many cubes and how hard a scramble a level uses. Deterministic in the
 * level number alone — the single source of truth for both the game and the
 * server's level metadata. */
export function levelParams(level) {
  const numCubes = Math.min(25, 2 + level);
  const scramble = 3 + Math.floor(level * 1.6);
  return { numCubes, scramble };
}

/* The base move budget ("par") for a level, before any carried bonus. Mirrors
 * the budget the game grants: scramble length + 3 per cube (herding slack) + 4.
 * Exposed so the server can show par on the level grid without running the game
 * engine. */
export function baseBudget(level) {
  const { numCubes, scramble } = levelParams(level);
  return scramble + numCubes * 3 + 4;
}

/* In-place Fisher–Yates shuffle driven by a supplied rng (so shuffles are part
 * of the level's reproducible random stream). Returns the same array. */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
