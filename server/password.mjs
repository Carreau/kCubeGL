/* ============================================================================
 * Password hashing — scrypt via node:crypto (no native dependency).
 *
 * The project rule is "Node built-ins only": the Docker image runs the server
 * without an npm install, so password hashes use Node's built-in memory-hard
 * scrypt rather than an npm argon2 binding.
 *
 * Stored format (every parameter explicit, so work factors can be raised later
 * without invalidating existing hashes):
 *   scrypt:N:r:p:<salt base64url>:<hash base64url>
 * ========================================================================== */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP-recommended scrypt work factor (N=2^15, r=8, p=3): ~32 MiB and a few
// tens of ms per hash. maxmem must sit above 128·N·r bytes or node refuses.
const N = 1 << 15, R = 8, P = 3;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

const scryptAsync = (password, salt, keylen, opts) =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

// Recompute with the hash's stored parameters and compare in constant time.
// Returns false — never throws — on a malformed or foreign hash, so the login
// path can treat any failure as "wrong password".
export async function verifyPassword(stored, password) {
  try {
    const [tag, n, r, p, saltB64, hashB64] = String(stored).split(":");
    if (tag !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    if (!salt.length || !expected.length || expected.length > 128) return false;
    const key = await scryptAsync(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
