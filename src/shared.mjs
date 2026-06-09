/* ============================================================================
 * Shared, dependency-free game math.
 *
 * This module is imported BOTH by the browser game (src/main.js) and by the
 * Node backend (server/*). It therefore must not import Three.js or touch the
 * DOM — only pure functions a server can run too.
 *
 * Its job is to define a *fixed catalogue of named puzzles*. Every puzzle is a
 * (seed, numCubes, scramble) tuple fed to mulberry32 to reproduce the exact
 * board on every device, plus a stable human-friendly name. The catalogue is
 * derived deterministically from one master seed, so the browser (even with no
 * backend) and the server agree on the same list of puzzles — the prerequisite
 * for comparable best-scores and per-puzzle difficulty.
 *
 * Note: cube count and scramble depth are drawn *independently* and within a
 * bounded range. We deliberately do NOT keep growing the cube count: more cubes
 * is not obviously harder, so difficulty comes from varied scrambles, not size.
 * ========================================================================== */

export const BOARD = 5; // 5×5 grid (kept in sync with src/main.js)

/* mulberry32 — a tiny, fast, deterministic 32-bit PRNG. Same seed ⇒ same
 * stream on every machine, which is what makes a puzzle reproducible. Returns a
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

/* In-place Fisher–Yates shuffle driven by a supplied rng (so shuffles are part
 * of the puzzle's reproducible random stream). Returns the same array. */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* The base move budget ("par") for a puzzle, before any carried bonus: the
 * scramble length + 3 per cube (herding slack, since the cursor can't jump
 * between disjoint clusters) + a small buffer. */
export function budgetFor(numCubes, scramble) {
  return scramble + numCubes * 3 + 4;
}

/* ----------------------------------------------------------------------------
 * The catalogue
 * ------------------------------------------------------------------------- */

export const CATALOG_SIZE = 40; // a fixed pool — no infinite auto-create

// One master seed spreads into every puzzle's parameters and name. Changing it
// reshuffles the whole catalogue, so keep it stable once players have scores.
const CATALOG_SEED = 0x6b437542; // "kCuB"

// Word lists for memorable, URL-safe names like "amber-otter". Kept small and
// dependency-free; enough combinations that 40 names rarely collide (and we
// dedupe anyway).
const ADJECTIVES = [
  "amber", "brisk", "cobalt", "dapper", "ember", "fuzzy", "glassy", "hazel",
  "ivory", "jolly", "keen", "lunar", "mossy", "nimble", "ochre", "plucky",
  "quirky", "rusty", "silken", "tidal", "umber", "velvet", "witty", "zesty",
];
const NOUNS = [
  "otter", "comet", "maple", "falcon", "pebble", "willow", "badger", "harbor",
  "cinder", "marble", "thistle", "lantern", "meadow", "raven", "quartz", "fjord",
  "bramble", "cobble", "ripple", "summit", "tundra", "vortex", "wisp", "zephyr",
];

const NUM_CUBES_MIN = 2;
const NUM_CUBES_MAX = 16; // bounded — bigger boards aren't the difficulty lever
const SCRAMBLE_MIN = 4;
const SCRAMBLE_MAX = 30;

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pickName(rng, used) {
  for (let tries = 0; tries < 100; tries++) {
    const base = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)] +
      "-" + NOUNS[Math.floor(rng() * NOUNS.length)];
    if (!used.has(base)) return base;
    const suffixed = base + "-" + randInt(rng, 2, 99);
    if (!used.has(suffixed)) return suffixed;
  }
  // Extremely unlikely fallback: guarantee uniqueness with the set size.
  return "puzzle-" + (used.size + 1);
}

/* Build the fixed catalogue: an ordered array of puzzle definitions. Pure and
 * deterministic — every caller (browser offline, server seeding) gets the same
 * list. `order` is the natural/default position (1-based). */
export function buildCatalog(size = CATALOG_SIZE) {
  const rng = mulberry32(CATALOG_SEED);
  const used = new Set();
  const out = [];
  for (let i = 0; i < size; i++) {
    const numCubes = randInt(rng, NUM_CUBES_MIN, NUM_CUBES_MAX);
    const scramble = randInt(rng, SCRAMBLE_MIN, SCRAMBLE_MAX);
    const seed = (Math.floor(rng() * 0xffffffff)) >>> 0;
    const name = pickName(rng, used);
    used.add(name);
    out.push({
      order: i + 1,
      name,
      seed,
      numCubes,
      scramble,
      par: budgetFor(numCubes, scramble),
    });
  }
  return out;
}

/* Look up one puzzle definition by name from the deterministic catalogue.
 * Used by the browser offline (no backend) to reproduce a board from its name. */
export function catalogByName(name, size = CATALOG_SIZE) {
  return buildCatalog(size).find((p) => p.name === name) || null;
}
