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

/* ----------------------------------------------------------------------------
 * Gravatar avatars
 *
 * Gravatar keys an account off the (trimmed, lowercased) email hashed with MD5.
 * We don't collect emails, so by default we hash the player's username and lean
 * on Gravatar's generated fallback art (`d=retro`): every player gets a stable,
 * unique little icon with no signup. Pass a real email to surface their actual
 * Gravatar when they have one. Kept pure + dependency-free so the browser and
 * the server agree on the same URL.
 * ------------------------------------------------------------------------- */

/* Minimal MD5 (RFC 1321) over a UTF-8 string → 32-char lowercase hex digest.
 * Self-contained so shared.mjs keeps its no-dependency, browser+Node contract. */
export function md5(str) {
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
  const add = (a, b) => (a + b) | 0;

  // Per-round left-rotate amounts and the sine-derived additive constants.
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  // UTF-8 encode, then pad to a multiple of 64 bytes with the 64-bit length.
  const bytes = Array.from(new TextEncoder().encode(String(str)));
  let bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) { bytes.push(bitLen & 0xff); bitLen = Math.floor(bitLen / 256); }

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = add(add(add(F, A), K[i]), M[g]);
      A = D; D = C; C = B;
      B = add(B, rotl(F, S[i]));
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }

  // Little-endian hex of each 32-bit word.
  const hex = (n) => {
    let h = "";
    for (let i = 0; i < 4; i++) h += (((n >>> (8 * i)) & 0xff).toString(16).padStart(2, "0"));
    return h;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/* The Gravatar hash for an identifier: the trimmed, lowercased value (an email
 * or, for us, a username) run through MD5. This is exactly the public key a
 * Gravatar URL embeds, so it's safe to expose even when the raw email isn't. */
export function gravatarHash(identifier) {
  return md5(String(identifier ?? "").trim().toLowerCase());
}

/* Build a Gravatar avatar URL from an already-computed hash (see gravatarHash).
 * Options: `size` (px), `def` (default-image style for unknown hashes, e.g.
 * "retro", "identicon", "mp"), and `rating`. */
export function gravatarUrlForHash(hash, { size = 80, def = "retro", rating = "g" } = {}) {
  const q = `s=${encodeURIComponent(size)}&d=${encodeURIComponent(def)}&r=${encodeURIComponent(rating)}`;
  return `https://www.gravatar.com/avatar/${hash}?${q}`;
}

/* Build a Gravatar avatar URL for an identifier (a username or an email).
 * Convenience wrapper around gravatarHash + gravatarUrlForHash. */
export function gravatarUrl(identifier, opts) {
  return gravatarUrlForHash(gravatarHash(identifier), opts);
}
