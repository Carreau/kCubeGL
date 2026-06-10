/* ============================================================================
 * kCube backend — HTTP server (Node built-ins only).
 *
 * One process serves BOTH the static game (index.html / play.html / src/*) and
 * a small JSON API under /api. There's no framework and no build step, in
 * keeping with the rest of the project — just node:http, node:sqlite (via
 * db.mjs) and the standard library.
 *
 *   npm start            # run it on http://localhost:8080
 *   KCUBE_DB=:memory: …  # use an in-memory DB (tests do this)
 *
 * This server is the norm. Served as plain static files instead (no backend),
 * the game still renders from its cold-start cache and localStorage — the API
 * simply isn't there — but accounts, leaderboards and stats need it running.
 * ========================================================================== */

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize, extname, sep } from "node:path";
import { openDb } from "./db.mjs";
import { hashPassword, verifyPassword } from "./password.mjs";
import { generateChallenge, verifyRegistration, verifyAssertion } from './webauthn.mjs';

// Pre-compute a dummy hash so we can always spend the same time in the login
// path regardless of whether the username exists (prevents user-enumeration via timing).
const dummyHashPromise = hashPassword("_kcube_no_password_placeholder_");

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Paths we never serve as static files (source/secrets/deps).
const BLOCKED = ["/server", "/.git", "/node_modules"];

/* --- tiny http helpers ------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

// An error the top-level catch maps to a specific HTTP status (client fault),
// as opposed to an unexpected failure (500 + a logged stack).
function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// Read and JSON-parse a request body (cap size to avoid abuse). Returns {} for
// an empty body; rejects with a 400/413 httpError on malformed/oversized input
// so the client gets a real status instead of a 500 or a connection reset.
function readJson(req, limit = 1 << 16) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        // Stop reading (backpressure via pause) but keep the socket alive so
        // the 413 can reach the client; the catch handler closes it after.
        req.off("data", onData);
        req.pause();
        reject(httpError(413, "payload too large"));
        return;
      }
      data += c;
    };
    req.on("data", onData);
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(httpError(400, "malformed JSON body")); }
    });
    req.on("error", reject);
  });
}

const bearer = (req) => {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
};

const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};
// Puzzle names are the public key: lowercase words/digits joined by hyphens.
const cleanName = (v) => {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return /^[a-z0-9-]{1,64}$/.test(s) ? s : null;
};
const VALID_OUTCOME = new Set(["won", "lost", "abandoned"]);
// Stored cursor-path cap. Generous: budgets top out around ~100 paid rolls, and
// free cursor switches are the only way past a few hundred codes in practice.
const MOVE_SEQ_MAX = 4096;

// Bootstrap secret: a user who presents this at registration becomes admin.
// Unset (the default) means no new admins can be minted via the API. Read at
// use-time (not cached) so tests can set it before the first request.
const adminToken = () => process.env.KCUBE_ADMIN_TOKEN || null;

// Constant-time string comparison for secrets. Hashing both sides first makes
// the buffers equal-length (timingSafeEqual requires that), so neither the
// length nor the content of the attacker's guess leaks through timing.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
// Only trust X-Forwarded-* when we're knowingly behind a proxy. Otherwise a
// client could spoof those headers to steer the WebAuthn origin/RP-ID.
const trustProxy = () =>
  process.env.KCUBE_TRUST_PROXY === "1" || process.env.KCUBE_TRUST_PROXY === "true";

// X-Forwarded-Host/Proto are typically SET (replaced) by the proxy, so the
// first entry is the meaningful one when several hops each add their own.
const firstForwarded = (v) => String(v).split(',')[0].trim();

// X-Forwarded-For is APPENDED to by each proxy hop, so earlier entries are
// whatever the client claimed they were. The only trustworthy entry is the
// LAST one — the address our own trusted proxy saw and appended. Using the
// first entry would let a client spoof arbitrary "IPs" past the rate limiter.
const lastForwarded = (v) => String(v).split(',').pop().trim();

function fwdHost(req) {
  const fwd = trustProxy() && req.headers['x-forwarded-host'];
  return (fwd && firstForwarded(fwd)) || req.headers.host || 'localhost';
}

// Validate an optional Gravatar email. Returns null for "no email" (empty/absent),
// a normalised address for a valid one, or undefined for something malformed (so
// the caller can answer 400 rather than silently dropping it). The address is
// only used to derive a hash — it is never stored.
const cleanEmail = (v) => {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : undefined;
};

function getOrigin(req) {
  const fwdProto = trustProxy() && req.headers['x-forwarded-proto'];
  const proto = (fwdProto && firstForwarded(fwdProto)) ||
    (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${fwdHost(req)}`;
}

function getRpId(req) {
  return fwdHost(req).split(':')[0];
}

// Map a wildcard/loopback bind address to "localhost" for display: it's
// reachable, clickable, a secure context, and a valid WebAuthn RP ID (a bare
// IP is none of those for passkeys).
const LOOPBACK_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::', '::1', '']);
function displayHost(host) {
  return LOOPBACK_HOSTS.has(host) ? 'localhost' : host;
}

/* --- rate limiting ------------------------------------------------------------
 * Tiny in-memory per-IP sliding window (no deps). Applied to the abuse-prone
 * auth endpoints: registration, password login and the passkey ceremonies.
 * Defaults are deliberately generous (they only need to stop hammering, not
 * shape normal traffic); KCUBE_RATE_LIMIT overrides the per-minute cap for all
 * buckets (0 disables limiting entirely).
 * --------------------------------------------------------------------------- */

const RATE_WINDOW_MS = 60_000;
const rateHits = new Map(); // "bucket:ip" -> [timestamps]
let rateLastSweep = 0;

const rateMax = (def) => {
  const v = process.env.KCUBE_RATE_LIMIT;
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

function clientIp(req) {
  if (trustProxy() && req.headers["x-forwarded-for"]) {
    return lastForwarded(req.headers["x-forwarded-for"]) || "unknown";
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// True when this hit pushes `bucket` past `max` events per window for this IP.
function rateLimited(bucket, ip, max) {
  if (!(max > 0)) return false; // 0/negative = disabled
  const t = Date.now();
  if (t - rateLastSweep > RATE_WINDOW_MS) { // keep the map from growing unbounded
    rateLastSweep = t;
    for (const [k, arr] of rateHits) {
      const live = arr.filter((x) => t - x < RATE_WINDOW_MS);
      if (live.length) rateHits.set(k, live); else rateHits.delete(k);
    }
  }
  const key = bucket + ":" + ip;
  const hits = (rateHits.get(key) || []).filter((x) => t - x < RATE_WINDOW_MS);
  if (hits.length >= max) { rateHits.set(key, hits); return true; }
  hits.push(t);
  rateHits.set(key, hits);
  return false;
}

/* --- solver worker ------------------------------------------------------------
 * The BFS/beam solvers can pin the CPU for seconds on the hardest boards, so
 * the admin solve endpoint runs them in a worker thread instead of blocking
 * the event loop. The worker module is pure (no Three.js, no DOM, no DB).
 * --------------------------------------------------------------------------- */

const SOLVE_WORKER_URL = new URL("./solve-worker.mjs", import.meta.url);

// Hard ceiling on one solve run. Without it a pathological board would leave
// the worker thread burning a CPU core forever (the promise just never
// settles), and repeated admin calls could stack such threads up.
const SOLVE_TIMEOUT_MS = 5 * 60_000;

function runSolverWorker(config) {
  return new Promise((resolve, reject) => {
    // execArgv: [] — don't inherit parent CLI flags (e.g. --input-type/--eval
    // flags from an embedding process), which can break module workers.
    const w = new Worker(SOLVE_WORKER_URL, { workerData: config, execArgv: [] });
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      settle(reject, new Error("solver timed out"));
      w.terminate();
    }, SOLVE_TIMEOUT_MS);
    w.once("message", (r) => settle(resolve, r));
    w.once("error", (e) => settle(reject, e));
    w.once("exit", (code) => settle(reject, new Error(`solver worker exited with code ${code}`)));
  });
}

/* --- static files ----------------------------------------------------------- */

async function serveStatic(req, res, pathname) {
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  // Resolve against ROOT *first*: normalize() collapses any "../" so a request
  // like /x/../server/db.mjs can't slip a blocked path past the checks below or
  // escape ROOT entirely.
  const full = normalize(join(ROOT, pathname));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    res.writeHead(403); return res.end("forbidden");
  }
  const rel = full.slice(ROOT.length).split(sep).join("/"); // e.g. "/server/db.mjs"
  if (BLOCKED.some((p) => rel === p || rel.startsWith(p + "/"))) {
    res.writeHead(403); return res.end("forbidden");
  }
  try {
    const body = await readFile(full);
    res.writeHead(200, {
      "Content-Type": MIME[extname(full)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

/* --- API routing -------------------------------------------------------------
 * Declarative route table instead of a wall of if-chains. Each entry says what
 * it needs and the dispatcher provides it centrally:
 *   method / path — path is exact segments plus ":param" placeholders.
 *   auth          — null (open), 'user' (401 without a token) or 'admin'
 *                   (401 without a token, then 403 for non-admins).
 *   body          — true ⇒ the JSON body is parsed before the handler runs.
 *   limit         — { bucket, max } ⇒ per-IP rate limit (429), checked first
 *                   (before auth, so unauthenticated hammering is also capped).
 * Handlers get ctx = { req, res, db, params, body, user } — `user` is resolved
 * from the bearer token for every route, so auth-optional handlers can use it.
 * --------------------------------------------------------------------------- */

// Match one route pattern against the request path segments, extracting :params.
// Strict segment count: no prefix matching, so unknown paths fall through to 404.
function matchPath(patSegs, segs) {
  if (patSegs.length !== segs.length) return null;
  const params = {};
  for (let i = 0; i < patSegs.length; i++) {
    if (patSegs[i].startsWith(":")) params[patSegs[i].slice(1)] = segs[i];
    else if (patSegs[i] !== segs[i]) return null;
  }
  return params;
}

async function handleApi(req, res, url, db) {
  const segs = url.pathname.split("/").filter(Boolean); // ["api", ...]
  let params = null, route = null;
  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    params = matchPath(r.segs, segs);
    if (params) { route = r; break; }
  }
  if (!route) return sendJson(res, 404, { error: "not found" });
  if (route.limit && rateLimited(route.limit.bucket, clientIp(req), rateMax(route.limit.max))) {
    return sendJson(res, 429, { error: "too many requests — slow down" });
  }
  const user = db.userByToken(bearer(req));
  if (route.auth && !user) return sendJson(res, 401, { error: "sign in first" });
  if (route.auth === "admin" && !user.isAdmin) return sendJson(res, 403, { error: "admin required" });
  const body = route.body ? await readJson(req) : null;
  return route.handler({ req, res, db, params, body, user });
}

/* --- API handlers ------------------------------------------------------------- */

const ROUTES = [
  // GET /api/health
  { method: "GET", path: "/api/health", handler({ res }) {
    return sendJson(res, 200, { ok: true });
  } },

  // POST /api/users  { username, adminToken?, email?, password? }
  // Anyone can register a username. Admin is granted only when the request
  // carries the bootstrap secret KCUBE_ADMIN_TOKEN. An optional email is used
  // only to derive a Gravatar hash and is never stored. An optional password is
  // hashed with scrypt before storage — username-only accounts remain valid.
  { method: "POST", path: "/api/users", body: true, limit: { bucket: "users", max: 30 },
    async handler({ res, db, body }) {
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (username.length < 1 || username.length > 24) {
        return sendJson(res, 400, { error: "name must be 1–24 characters" });
      }
      // Usernames appear on shared surfaces (leaderboards, admin lists): reject
      // control characters and bidi overrides, which exist only to spoof or
      // mangle whatever is rendered around them.
      if (/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(username)) {
        return sendJson(res, 400, { error: "name contains invalid characters" });
      }
      const email = cleanEmail(body.email);
      if (email === undefined) return sendJson(res, 400, { error: "invalid email" });
      const password = typeof body.password === "string" ? body.password : null;
      if (password !== null && (password.length < 8 || password.length > 128)) {
        return sendJson(res, 400, { error: "password must be 8–128 characters" });
      }
      const secret = adminToken();
      // Constant-time compare: the bootstrap secret must not leak through timing.
      const admin = !!secret && safeEqual(body.adminToken, secret);
      const passwordHash = password ? await hashPassword(password) : null;
      try {
        return sendJson(res, 201, db.createUser(username, { admin, email, passwordHash }));
      } catch (e) {
        if (e.code === "DUP") return sendJson(res, 409, { error: "name taken" });
        throw e;
      }
    } },

  // GET /api/me
  { method: "GET", path: "/api/me", auth: "user", handler({ res, user }) {
    return sendJson(res, 200, user);
  } },

  // PATCH /api/me  { email }  — set/update/clear the Gravatar email.
  { method: "PATCH", path: "/api/me", auth: "user", body: true, handler({ res, db, body, user }) {
    const email = cleanEmail(body.email);
    if (email === undefined) return sendJson(res, 400, { error: "invalid email" });
    return sendJson(res, 200, { ...user, ...db.setUserEmail(user.id, email) });
  } },

  // GET /api/me/stats
  { method: "GET", path: "/api/me/stats", auth: "user", handler({ res, db, user }) {
    return sendJson(res, 200, db.userStats(user.id));
  } },

  // GET /api/puzzles   (auth optional — adds yourBest). The whole catalogue.
  { method: "GET", path: "/api/puzzles", handler({ res, db, user }) {
    return sendJson(res, 200, db.listPuzzles(user ? user.id : null));
  } },

  // GET /api/puzzles/:name   (auth optional)
  { method: "GET", path: "/api/puzzles/:name", handler({ res, db, params, user }) {
    const name = cleanName(params.name);
    if (!name) return sendJson(res, 400, { error: "bad puzzle" });
    const meta = db.puzzleMeta(name);
    if (!meta) return sendJson(res, 404, { error: "no such puzzle" });
    return sendJson(res, 200, {
      ...meta,
      worldBest: db.worldBest(meta.id),
      yourBest: user ? db.userBest(user.id, meta.id) : null,
      leaderboard: db.leaderboard(meta.id, 10).map((r) => ({
        username: r.username,
        avatarHash: r.avatarHash ?? null,
        best: r.best,
        durationMs: r.durationMs,
        attempts: r.attempts,
        you: user ? r.user_id === user.id : false,
      })),
      stats: db.puzzleStats(meta.id),
    });
  } },

  // POST /api/attempts  { puzzle }
  // Note: a client-supplied `optimal` used to be accepted here, but anyone can
  // register a token, so that let any visitor permanently poison a puzzle's
  // shortest-known-solve. `optimal` is now seeded from the generator's solution
  // length and only ever lowered by validated wins (see the PATCH handler).
  { method: "POST", path: "/api/attempts", auth: "user", body: true, limit: { bucket: "attempts", max: 60 },
    handler({ res, db, body, user }) {
    const name = cleanName(body.puzzle);
    if (!name) return sendJson(res, 400, { error: "bad puzzle" });
    const puzzle = db.puzzleByName(name);
    if (!puzzle) return sendJson(res, 404, { error: "no such puzzle" });
    return sendJson(res, 201, { attemptId: db.startAttempt(user.id, puzzle.id) });
  } },

  // PATCH /api/attempts/:id  { outcome, movesUsed, durationMs }
  { method: "PATCH", path: "/api/attempts/:id", auth: "user", body: true, limit: { bucket: "attempts", max: 60 },
    handler({ res, db, params, body, user }) {
    const id = toInt(params.id);
    if (!id || !VALID_OUTCOME.has(body.outcome)) {
      return sendJson(res, 400, { error: "bad attempt update" });
    }
    // Find the attempt's puzzle (and confirm it's the caller's own open attempt).
    const row = db.openAttempt(id, user.id);
    if (!row) return sendJson(res, 404, { error: "no such open attempt" });
    const puzzleId = row.puzzle_id;
    // Clamp into sane ranges: moveSeq is capped at 4096 rolls, and no attempt
    // plausibly runs a week — uncapped values would let one bogus submission
    // skew the avgMoves/avgDuration difficulty aggregates arbitrarily.
    const MAX_DURATION_MS = 7 * 24 * 3600 * 1000;
    const movesUsed = Math.min(MOVE_SEQ_MAX, Math.max(0, toInt(body.movesUsed) ?? 0));
    const durationMs = Math.min(MAX_DURATION_MS, Math.max(0, toInt(body.durationMs) ?? 0));
    // Player's recorded cursor path (R/L/U/D). Keep only the four codes and cap
    // the length so a stray/oversized payload can't bloat the row.
    const rawSeq = typeof body.moveSeq === "string" ? body.moveSeq.replace(/[^RLUD]/g, "") : "";
    const moveSeq = rawSeq.slice(0, MOVE_SEQ_MAX) || null;
    // Wins feed best-scores and the world record, so they are not taken on
    // trust: the recorded path is REPLAYED against the server's own copy of
    // the deterministic board (db.replayWin), and the claim is accepted only
    // if the sequence is legal, ends solved, and its paid roll count matches
    // movesUsed exactly. A truncated sequence can't be verified, so a path
    // past the cap rejects the win rather than silently storing a corrupt one.
    // The verified win's top colour (0-5), recorded so the landing page can
    // break a player's bests down per colour. Stays null for non-wins.
    let winColor = null;
    if (body.outcome === "won") {
      const mu = toInt(body.movesUsed);
      if (mu == null || mu < 1) return sendJson(res, 400, { error: "bad movesUsed for a win" });
      if (!moveSeq || rawSeq.length > MOVE_SEQ_MAX) {
        return sendJson(res, 400, { error: "a win needs its recorded move sequence" });
      }
      const replay = db.replayWin(puzzleId, moveSeq);
      if (!replay || !replay.won || replay.rolls !== mu) {
        return sendJson(res, 400, { error: "move sequence does not replay to that win" });
      }
      winColor = replay.color;
    }
    const prevBest = db.userBest(user.id, puzzleId); // before recording this outcome
    db.finishAttempt(id, user.id, { outcome: body.outcome, movesUsed, durationMs, moveSeq, winColor });
    // A replay-verified win is the only client input allowed to improve the
    // shortest-known-solve (recordOptimal re-checks the bounds anyway).
    if (body.outcome === "won") db.recordOptimal(puzzleId, movesUsed);
    return sendJson(res, 200, {
      best: db.userBest(user.id, puzzleId),
      worldBest: db.worldBest(puzzleId),
      isRecord: body.outcome === "won" && (prevBest == null || movesUsed < prevBest),
    });
  } },

  // POST /api/attempts/:id/abandon  { token, movesUsed, durationMs }  (beacon)
  // No auth guard: sendBeacon can't set headers, so the token rides in the body.
  { method: "POST", path: "/api/attempts/:id/abandon", body: true, limit: { bucket: "attempts", max: 60 },
    handler({ req, res, db, params, body }) {
    const id = toInt(params.id);
    const u = db.userByToken(body.token || bearer(req));
    if (u && id) {
      db.finishAttempt(id, u.id, {
        outcome: "abandoned",
        movesUsed: Math.max(0, toInt(body.movesUsed) ?? 0),
        durationMs: Math.max(0, toInt(body.durationMs) ?? 0),
      });
    }
    res.writeHead(204); return res.end();
  } },

  // GET /api/tutorials   — public list (name, title, mode, sortOrder only)
  { method: "GET", path: "/api/tutorials", handler({ res, db }) {
    return sendJson(res, 200, db.listTutorials());
  } },

  // GET /api/tutorials/:name   — full tutorial data for the player
  { method: "GET", path: "/api/tutorials/:name", handler({ res, db, params }) {
    const name = cleanName(params.name);
    if (!name) return sendJson(res, 400, { error: "bad tutorial name" });
    const t = db.tutorialByName(name);
    if (!t) return sendJson(res, 404, { error: "no such tutorial" });
    return sendJson(res, 200, t);
  } },

  // POST /api/auth/passkey/register/options  (requires auth)
  { method: "POST", path: "/api/auth/passkey/register/options", auth: "user", limit: { bucket: "passkey", max: 30 },
    handler({ req, res, db, user }) {
      const challenge = generateChallenge();
      db.saveChallenge(challenge, user.id, 'register');
      const rpId = getRpId(req);
      const userIdBuf = Buffer.alloc(8);
      userIdBuf.writeBigInt64BE(BigInt(user.id));
      return sendJson(res, 200, {
        challenge,
        rp: { name: 'kCubeGL', id: rpId },
        user: { id: userIdBuf.toString('base64url'), name: user.username, displayName: user.username },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
      });
    } },

  // POST /api/auth/passkey/register/verify  (requires auth)
  { method: "POST", path: "/api/auth/passkey/register/verify", auth: "user", body: true, limit: { bucket: "passkey", max: 30 },
    handler({ req, res, db, body, user }) {
      if (!body.credential?.response) return sendJson(res, 400, { error: 'missing credential' });
      let clientData;
      try {
        clientData = JSON.parse(Buffer.from(body.credential.response.clientDataJSON, 'base64url').toString('utf8'));
      } catch { return sendJson(res, 400, { error: 'invalid clientDataJSON' }); }
      const challengeRow = db.consumeChallenge(clientData.challenge, 'register');
      if (!challengeRow) return sendJson(res, 400, { error: 'invalid or expired challenge' });
      if (challengeRow.user_id !== user.id) return sendJson(res, 400, { error: 'challenge user mismatch' });
      try {
        const result = verifyRegistration(body.credential, challengeRow.challenge, getOrigin(req), getRpId(req));
        db.createPasskey(user.id, result.credentialId, result.publicKey, result.counter);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        console.error("[kcube] passkey registration failed", e);
        return sendJson(res, 400, { error: "passkey registration failed" });
      }
    } },

  // POST /api/auth/passkey/login/options
  { method: "POST", path: "/api/auth/passkey/login/options", limit: { bucket: "passkey", max: 30 },
    handler({ req, res, db }) {
      const challenge = generateChallenge();
      db.saveChallenge(challenge, null, 'login');
      return sendJson(res, 200, {
        challenge,
        timeout: 60000,
        rpId: getRpId(req),
        userVerification: 'preferred',
        allowCredentials: [],
      });
    } },

  // POST /api/auth/passkey/login/verify
  { method: "POST", path: "/api/auth/passkey/login/verify", body: true, limit: { bucket: "passkey", max: 30 },
    handler({ req, res, db, body }) {
      if (!body.assertion?.response) return sendJson(res, 400, { error: 'missing assertion' });
      let clientData;
      try {
        clientData = JSON.parse(Buffer.from(body.assertion.response.clientDataJSON, 'base64url').toString('utf8'));
      } catch { return sendJson(res, 400, { error: 'invalid clientDataJSON' }); }
      const challengeRow = db.consumeChallenge(clientData.challenge, 'login');
      if (!challengeRow) return sendJson(res, 400, { error: 'invalid or expired challenge' });
      const credentialId = body.assertion.id || body.assertion.rawId;
      const passkey = db.getPasskeyById(credentialId);
      if (!passkey) return sendJson(res, 400, { error: 'unknown credential' });
      try {
        const { counter } = verifyAssertion(body.assertion, passkey.public_key, passkey.counter, challengeRow.challenge, getOrigin(req), getRpId(req));
        db.updatePasskeyCounter(credentialId, counter);
        const user = db.getUserByIdFull(passkey.user_id);
        if (!user) return sendJson(res, 500, { error: 'user not found' });
        // Tokens are stored hashed, so a login can't echo the old one back —
        // it mints a fresh token (signing other devices out; the single-token
        // model has always meant one live session per account).
        const token = db.rotateToken(user.id);
        return sendJson(res, 200, { token, username: user.username, userId: user.id, isAdmin: user.isAdmin });
      } catch (e) {
        console.error("[kcube] passkey login failed", e);
        return sendJson(res, 400, { error: "passkey login failed" });
      }
    } },

  // POST /api/auth/password/login  { username, password }
  { method: "POST", path: "/api/auth/password/login", body: true, limit: { bucket: "login", max: 30 },
    async handler({ res, db, body }) {
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || !password) return sendJson(res, 400, { error: 'username and password required' });
      const dummyHash = await dummyHashPromise;
      const user = db.getUserByUsername(username);
      // Always run verify (even against a dummy hash) to prevent user-enumeration via timing.
      const valid = await verifyPassword(user?.passwordHash ?? dummyHash, password);
      if (!valid || !user?.passwordHash) return sendJson(res, 401, { error: 'invalid credentials' });
      // Tokens are stored hashed, so a login mints a fresh one (see the
      // passkey login above for the trade-off).
      const token = db.rotateToken(user.id);
      return sendJson(res, 200, { token, username: user.username, userId: user.id, isAdmin: user.isAdmin });
    } },

  // GET /api/admin/users
  { method: "GET", path: "/api/admin/users", auth: "admin", handler({ res, db }) {
    return sendJson(res, 200, db.listUsers());
  } },

  // PATCH /api/admin/users/:id  { isAdmin }
  { method: "PATCH", path: "/api/admin/users/:id", auth: "admin", body: true, handler({ res, db, params, body, user }) {
    const targetId = toInt(params.id);
    if (!targetId) return sendJson(res, 400, { error: 'bad user id' });
    // Require a real boolean: a truthy string like "false" must not grant admin.
    if (typeof body.isAdmin !== 'boolean') return sendJson(res, 400, { error: 'isAdmin must be a boolean' });
    if (targetId === user.id && body.isAdmin === false) {
      return sendJson(res, 400, { error: "can't remove your own admin status" });
    }
    db.setUserAdmin(targetId, body.isAdmin);
    return sendJson(res, 200, { ok: true });
  } },

  // DELETE /api/admin/users/:id
  { method: "DELETE", path: "/api/admin/users/:id", auth: "admin", handler({ res, db, params, user }) {
    const targetId = toInt(params.id);
    if (!targetId) return sendJson(res, 400, { error: 'bad user id' });
    if (targetId === user.id) return sendJson(res, 400, { error: "can't delete yourself" });
    db.deleteUser(targetId);
    return sendJson(res, 200, { ok: true });
  } },

  // POST /api/admin/users/:id/reset-password  { newPassword }
  // Set a new password for any user. Pass newPassword as empty/null to clear it.
  // Rate-limited like the other credential endpoints: it feeds password login.
  { method: "POST", path: "/api/admin/users/:id/reset-password", auth: "admin", body: true, limit: { bucket: "admin", max: 30 },
    async handler({ res, db, params, body }) {
      const targetId = toInt(params.id);
      if (!targetId) return sendJson(res, 400, { error: 'bad user id' });
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : null;
      if (newPassword !== null && newPassword !== '' && (newPassword.length < 8 || newPassword.length > 128)) {
        return sendJson(res, 400, { error: 'password must be 8–128 characters' });
      }
      const passwordHash = (newPassword && newPassword.length >= 8)
        ? await hashPassword(newPassword)
        : null;
      db.setUserPassword(targetId, passwordHash);
      // A password reset usually means "lock the old credentials out", so the
      // bearer token rotates with it — otherwise a leaked token would survive
      // the reset. The user signs back in with the new password.
      db.rotateToken(targetId);
      return sendJson(res, 200, { ok: true, hasPassword: !!passwordHash });
    } },

  // GET /api/admin/puzzles  — full catalogue with stats, for the ordering UI.
  { method: "GET", path: "/api/admin/puzzles", auth: "admin", handler({ res, db, user }) {
    return sendJson(res, 200, db.listPuzzles(user.id));
  } },

  // POST /api/admin/puzzles/:id/solve  — run the full (BFS) + beam solvers for
  // one puzzle and persist the results. Explicit, admin-triggered step; it can
  // block for a few seconds on the hardest boards, so it's never run at boot.
  // Tighter rate limit than the auth endpoints: each call ties up a worker thread.
  { method: "POST", path: "/api/admin/puzzles/:id/solve", auth: "admin", limit: { bucket: "solve", max: 10 },
    async handler({ res, db, params }) {
      const id = toInt(params.id);
      if (!id) return sendJson(res, 400, { error: 'bad puzzle id' });
      const row = db.puzzleById(id);
      if (!row) return sendJson(res, 404, { error: `puzzle ${id} not found` });
      try {
        // Run the CPU-heavy solvers off the event loop, then persist the result.
        const r = await runSolverWorker({ seed: row.seed, numCubes: row.num_cubes, scramble: row.scramble });
        return sendJson(res, 200, db.saveSolveResult(id, r));
      } catch (e) {
        console.error('[kcube] solver worker failed', e && e.stack ? e.stack : e);
        return sendJson(res, 500, { error: 'solver failed' });
      }
    } },

  // PUT /api/admin/puzzles/order  { ids: [...] }  — set the exact pinned order.
  { method: "PUT", path: "/api/admin/puzzles/order", auth: "admin", body: true, handler({ res, db, body }) {
    const ids = Array.isArray(body.ids) ? body.ids.map(toInt).filter((n) => n != null) : null;
    if (!ids) return sendJson(res, 400, { error: 'bad ids' });
    db.reorderPinned(ids);
    return sendJson(res, 200, { ok: true });
  } },

  // PATCH /api/admin/puzzles/:id  { pinned, sortOrder }
  { method: "PATCH", path: "/api/admin/puzzles/:id", auth: "admin", body: true, handler({ res, db, params, body }) {
    const id = toInt(params.id);
    if (!id) return sendJson(res, 400, { error: 'bad puzzle id' });
    try {
      db.setPuzzleOrder(id, {
        pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
        sortOrder: toInt(body.sortOrder) ?? undefined,
      });
    } catch (e) {
      if (e.code === "NOT_FOUND") return sendJson(res, 404, { error: e.message });
      throw e;
    }
    return sendJson(res, 200, { ok: true });
  } },

  // GET /api/admin/tutorials   — list (with full data) for the designer
  { method: "GET", path: "/api/admin/tutorials", auth: "admin", handler({ res, db }) {
    return sendJson(res, 200, db.listTutorials());
  } },

  // POST /api/admin/tutorials  — create a new tutorial
  { method: "POST", path: "/api/admin/tutorials", auth: "admin", body: true,
    handler({ res, db, body }) {
      const name = cleanName(body.name);
      if (!name) return sendJson(res, 400, { error: "bad tutorial name" });
      if (db.tutorialByName(name)) return sendJson(res, 409, { error: "name taken" });
      const id = db.upsertTutorial(name, {
        title:        String(body.title || '').slice(0, 120),
        cursorIndex:  toInt(body.cursorIndex) ?? 0,
        initialBoard: Array.isArray(body.initialBoard) ? body.initialBoard : [],
        steps:        Array.isArray(body.steps) ? body.steps : [],
        mode:         body.mode === 'guided' ? 'guided' : 'hint',
        sortOrder:    toInt(body.sortOrder) ?? 0,
      });
      return sendJson(res, 201, { id, name });
    } },

  // PUT /api/admin/tutorials/:name  — full replace / save from designer
  { method: "PUT", path: "/api/admin/tutorials/:name", auth: "admin", body: true,
    handler({ res, db, params, body }) {
      const name = cleanName(params.name);
      if (!name) return sendJson(res, 400, { error: "bad tutorial name" });
      const id = db.upsertTutorial(name, {
        title:        String(body.title || '').slice(0, 120),
        cursorIndex:  toInt(body.cursorIndex) ?? 0,
        initialBoard: Array.isArray(body.initialBoard) ? body.initialBoard : [],
        steps:        Array.isArray(body.steps) ? body.steps : [],
        mode:         body.mode === 'guided' ? 'guided' : 'hint',
        sortOrder:    toInt(body.sortOrder) ?? 0,
      });
      return sendJson(res, 200, { id, name });
    } },

  // DELETE /api/admin/tutorials/:name
  { method: "DELETE", path: "/api/admin/tutorials/:name", auth: "admin",
    handler({ res, db, params }) {
      const name = cleanName(params.name);
      if (!name) return sendJson(res, 400, { error: "bad tutorial name" });
      db.deleteTutorial(name);
      return sendJson(res, 200, { ok: true });
    } },

  // GET /api/admin/tutorials/:name/export  — download as JSON file
  { method: "GET", path: "/api/admin/tutorials/:name/export", auth: "admin",
    handler({ res, db, params }) {
      const name = cleanName(params.name);
      if (!name) return sendJson(res, 400, { error: "bad tutorial name" });
      const t = db.tutorialByName(name);
      if (!t) return sendJson(res, 404, { error: "no such tutorial" });
      const body = JSON.stringify(t, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}.json"`,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    } },
];

// Pre-split every route pattern once so per-request matching is just an array walk.
for (const r of ROUTES) r.segs = r.path.split("/").filter(Boolean);

/* --- server ----------------------------------------------------------------- */

export function startServer({ dbPath, port = 8080, host = "127.0.0.1" } = {}) {
  const db = openDb(dbPath);
  const server = http.createServer(async (req, res) => {
    try {
      // Inside the try: a malformed Host header (e.g. "a b") makes new URL()
      // throw, which must be a 400 — not an unhandled rejection that kills the
      // process. Likewise a bad %-escape in the path (URIError) is the
      // client's fault, not a 500.
      const url = new URL(req.url, `http://${req.headers.host || host}`);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, db);
      } else {
        await serveStatic(req, res, decodeURIComponent(url.pathname));
      }
    } catch (e) {
      const badRequest = e instanceof URIError || (e && e.code === "ERR_INVALID_URL");
      const status = (e && e.httpStatus) || (badRequest ? 400 : 500);
      if (!res.headersSent) {
        sendJson(res, status, { error: e && e.httpStatus ? e.message : (status === 500 ? "server error" : "bad request") });
      }
      // An oversized body leaves unread data on the wire: close the connection
      // once the 413 has flushed rather than letting the client keep streaming.
      if (status === 413) res.once("finish", () => req.destroy());
      if (status === 500) console.error("[kcube]", e && e.stack ? e.stack : e);
    }
  });
  return new Promise((resolve, reject) => {
    const onListenError = (e) => { db.close(); reject(e); };
    server.once("error", onListenError);
    server.listen(port, host, () => {
      server.removeListener("error", onListenError); // listen succeeded
      const addr = server.address();
      // Prefer "localhost" in the URL when bound to a wildcard/loopback
      // address. Browsers treat localhost as a secure context AND accept it as
      // a WebAuthn RP ID, whereas a bare IP (0.0.0.0 / 127.0.0.1) is rejected
      // as an RP ID — which would make passkey registration fail.
      const url = `http://${displayHost(host)}:${addr.port}/`;
      const close = () => {
        // Drop keep-alive connections so close() actually completes, and only
        // close the DB once the server has fully shut down.
        server.closeAllConnections();
        server.close(() => db.close());
      };
      resolve({ server, db, url, port: addr.port, close });
    });
  });
}

// Run directly: node server/server.mjs
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || "0.0.0.0";
  startServer({ port, host }).then(({ url }) => {
    console.log(`kCube server listening on ${url}  (db: ${process.env.KCUBE_DB || "server/kcube.sqlite"})`);
  });
}
