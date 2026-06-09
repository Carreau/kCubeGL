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
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { openDb } from "./db.mjs";
import { generateChallenge, verifyRegistration, verifyAssertion } from './webauthn.mjs';

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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

// Read and JSON-parse a request body (cap size to avoid abuse). Returns {} for
// an empty body; throws on malformed JSON.
function readJson(req, limit = 1 << 16) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      data += c;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
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

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function getRpId(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return host.split(':')[0];
}

// Map a wildcard/loopback bind address to "localhost" for display: it's
// reachable, clickable, a secure context, and a valid WebAuthn RP ID (a bare
// IP is none of those for passkeys).
const LOOPBACK_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::', '::1', '']);
function displayHost(host) {
  return LOOPBACK_HOSTS.has(host) ? 'localhost' : host;
}

/* --- static files ----------------------------------------------------------- */

async function serveStatic(req, res, pathname) {
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  if (BLOCKED.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    res.writeHead(403); return res.end("forbidden");
  }
  const full = normalize(join(ROOT, pathname));
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  try {
    const body = await readFile(full);
    res.writeHead(200, { "Content-Type": MIME[extname(full)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

/* --- API -------------------------------------------------------------------- */

async function handleApi(req, res, url, db) {
  const { pathname, searchParams } = url;
  const method = req.method;
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]
  const user = () => db.userByToken(bearer(req));
  const requireUser = () => {
    const u = user();
    if (!u) { sendJson(res, 401, { error: "sign in first" }); return null; }
    return u;
  };
  const requireAdmin = () => {
    const u = requireUser();
    if (!u) return null;
    if (!u.isAdmin) { sendJson(res, 403, { error: 'admin required' }); return null; }
    return u;
  };

  // GET /api/health
  if (method === "GET" && parts[1] === "health" && parts.length === 2) {
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/users  { username }
  if (method === "POST" && parts[1] === "users" && parts.length === 2) {
    const body = await readJson(req);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    if (username.length < 1 || username.length > 24) {
      return sendJson(res, 400, { error: "name must be 1–24 characters" });
    }
    try {
      return sendJson(res, 201, db.createUser(username));
    } catch (e) {
      if (e.code === "DUP") return sendJson(res, 409, { error: "name taken" });
      throw e;
    }
  }

  // GET /api/me
  if (method === "GET" && parts[1] === "me" && parts.length === 2) {
    const u = requireUser(); if (!u) return;
    return sendJson(res, 200, u);
  }

  // GET /api/me/stats
  if (method === "GET" && parts[1] === "me" && parts[2] === "stats") {
    const u = requireUser(); if (!u) return;
    return sendJson(res, 200, db.userStats(u.id));
  }

  // GET /api/puzzles   (auth optional — adds yourBest). The whole catalogue.
  if (method === "GET" && parts[1] === "puzzles" && parts.length === 2) {
    const u = user();
    return sendJson(res, 200, db.listPuzzles(u ? u.id : null));
  }

  // GET /api/puzzles/:name   (auth optional)
  if (method === "GET" && parts[1] === "puzzles" && parts.length === 3) {
    const name = cleanName(parts[2]);
    if (!name) return sendJson(res, 400, { error: "bad puzzle" });
    const meta = db.puzzleMeta(name);
    if (!meta) return sendJson(res, 404, { error: "no such puzzle" });
    const u = user();
    return sendJson(res, 200, {
      ...meta,
      worldBest: db.worldBest(meta.id),
      yourBest: u ? db.userBest(u.id, meta.id) : null,
      leaderboard: db.leaderboard(meta.id, 10).map((r) => ({
        username: r.username,
        best: r.best,
        durationMs: r.durationMs,
        attempts: r.attempts,
        you: u ? r.user_id === u.id : false,
      })),
      stats: db.puzzleStats(meta.id),
    });
  }

  // POST /api/attempts  { puzzle, optimal }
  if (method === "POST" && parts[1] === "attempts" && parts.length === 2) {
    const u = requireUser(); if (!u) return;
    const body = await readJson(req);
    const name = cleanName(body.puzzle);
    if (!name) return sendJson(res, 400, { error: "bad puzzle" });
    const puzzle = db.puzzleByName(name);
    if (!puzzle) return sendJson(res, 404, { error: "no such puzzle" });
    db.recordOptimal(puzzle.id, toInt(body.optimal) ?? undefined);
    return sendJson(res, 201, { attemptId: db.startAttempt(u.id, puzzle.id) });
  }

  // PATCH /api/attempts/:id  { outcome, movesUsed, durationMs }
  if (method === "PATCH" && parts[1] === "attempts" && parts.length === 3) {
    const u = requireUser(); if (!u) return;
    const id = toInt(parts[2]);
    const body = await readJson(req);
    if (!id || !VALID_OUTCOME.has(body.outcome)) {
      return sendJson(res, 400, { error: "bad attempt update" });
    }
    // Find the attempt's puzzle (and confirm it's the caller's own open attempt).
    const row = db.db
      .prepare("SELECT puzzle_id FROM attempts WHERE id = ? AND user_id = ? AND outcome = 'in_progress'")
      .get(id, u.id);
    if (!row) return sendJson(res, 404, { error: "no such open attempt" });
    const puzzleId = row.puzzle_id;
    const movesUsed = Math.max(0, toInt(body.movesUsed) ?? 0);
    const durationMs = Math.max(0, toInt(body.durationMs) ?? 0);
    // Player's recorded cursor path (R/L/U/D). Keep only the four codes and cap
    // the length so a stray/oversized payload can't bloat the row.
    const moveSeq = typeof body.moveSeq === "string"
      ? body.moveSeq.replace(/[^RLUD]/g, "").slice(0, 4096) || null
      : null;
    const prevBest = db.userBest(u.id, puzzleId); // before recording this outcome
    db.finishAttempt(id, u.id, { outcome: body.outcome, movesUsed, durationMs, moveSeq });
    return sendJson(res, 200, {
      best: db.userBest(u.id, puzzleId),
      worldBest: db.worldBest(puzzleId),
      isRecord: body.outcome === "won" && (prevBest == null || movesUsed < prevBest),
    });
  }

  // POST /api/attempts/:id/abandon  { token, movesUsed, durationMs }  (beacon)
  if (method === "POST" && parts[1] === "attempts" && parts[3] === "abandon") {
    const id = toInt(parts[2]);
    const body = await readJson(req);
    const u = db.userByToken(body.token || bearer(req));
    if (u && id) {
      db.finishAttempt(id, u.id, {
        outcome: "abandoned",
        movesUsed: Math.max(0, toInt(body.movesUsed) ?? 0),
        durationMs: Math.max(0, toInt(body.durationMs) ?? 0),
      });
    }
    res.writeHead(204); return res.end();
  }

  // POST /api/auth/passkey/register/options  (requires auth)
  if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'passkey' && parts[3] === 'register' && parts[4] === 'options') {
    const u = requireUser(); if (!u) return;
    const challenge = generateChallenge();
    db.saveChallenge(challenge, u.id);
    const rpId = getRpId(req);
    const userIdBuf = Buffer.alloc(8);
    userIdBuf.writeBigInt64BE(BigInt(u.id));
    return sendJson(res, 200, {
      challenge,
      rp: { name: 'kCubeGL', id: rpId },
      user: { id: userIdBuf.toString('base64url'), name: u.username, displayName: u.username },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
    });
  }

  // POST /api/auth/passkey/register/verify  (requires auth)
  if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'passkey' && parts[3] === 'register' && parts[4] === 'verify') {
    const u = requireUser(); if (!u) return;
    const body = await readJson(req);
    if (!body.credential?.response) return sendJson(res, 400, { error: 'missing credential' });
    let clientData;
    try {
      clientData = JSON.parse(Buffer.from(body.credential.response.clientDataJSON, 'base64url').toString('utf8'));
    } catch { return sendJson(res, 400, { error: 'invalid clientDataJSON' }); }
    const challengeRow = db.consumeChallenge(clientData.challenge);
    if (!challengeRow) return sendJson(res, 400, { error: 'invalid or expired challenge' });
    if (challengeRow.user_id !== u.id) return sendJson(res, 400, { error: 'challenge user mismatch' });
    try {
      const result = verifyRegistration(body.credential, challengeRow.challenge, getOrigin(req), getRpId(req));
      db.createPasskey(u.id, result.credentialId, result.publicKey, result.counter);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: `passkey registration failed: ${e.message}` });
    }
  }

  // POST /api/auth/passkey/login/options
  if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'passkey' && parts[3] === 'login' && parts[4] === 'options') {
    const challenge = generateChallenge();
    db.saveChallenge(challenge, null);
    return sendJson(res, 200, {
      challenge,
      timeout: 60000,
      rpId: getRpId(req),
      userVerification: 'preferred',
      allowCredentials: [],
    });
  }

  // POST /api/auth/passkey/login/verify
  if (method === 'POST' && parts[1] === 'auth' && parts[2] === 'passkey' && parts[3] === 'login' && parts[4] === 'verify') {
    const body = await readJson(req);
    if (!body.assertion?.response) return sendJson(res, 400, { error: 'missing assertion' });
    let clientData;
    try {
      clientData = JSON.parse(Buffer.from(body.assertion.response.clientDataJSON, 'base64url').toString('utf8'));
    } catch { return sendJson(res, 400, { error: 'invalid clientDataJSON' }); }
    const challengeRow = db.consumeChallenge(clientData.challenge);
    if (!challengeRow) return sendJson(res, 400, { error: 'invalid or expired challenge' });
    const credentialId = body.assertion.id || body.assertion.rawId;
    const passkey = db.getPasskeyById(credentialId);
    if (!passkey) return sendJson(res, 400, { error: 'unknown credential' });
    try {
      const { counter } = verifyAssertion(body.assertion, passkey.public_key, passkey.counter, challengeRow.challenge, getOrigin(req), getRpId(req));
      db.updatePasskeyCounter(credentialId, counter);
      const user = db.getUserByIdFull(passkey.user_id);
      if (!user) return sendJson(res, 500, { error: 'user not found' });
      return sendJson(res, 200, { token: user.token, username: user.username, userId: user.id, isAdmin: user.isAdmin });
    } catch (e) {
      return sendJson(res, 400, { error: `passkey login failed: ${e.message}` });
    }
  }

  // GET /api/admin/users
  if (method === 'GET' && parts[1] === 'admin' && parts[2] === 'users' && parts.length === 3) {
    const u = requireAdmin(); if (!u) return;
    return sendJson(res, 200, db.listUsers());
  }

  // PATCH /api/admin/users/:id  { isAdmin }
  if (method === 'PATCH' && parts[1] === 'admin' && parts[2] === 'users' && parts.length === 4) {
    const u = requireAdmin(); if (!u) return;
    const targetId = toInt(parts[3]);
    if (!targetId) return sendJson(res, 400, { error: 'bad user id' });
    const body = await readJson(req);
    if (targetId === u.id && body.isAdmin === false) {
      return sendJson(res, 400, { error: "can't remove your own admin status" });
    }
    db.setUserAdmin(targetId, body.isAdmin);
    return sendJson(res, 200, { ok: true });
  }

  // DELETE /api/admin/users/:id
  if (method === 'DELETE' && parts[1] === 'admin' && parts[2] === 'users' && parts.length === 4) {
    const u = requireAdmin(); if (!u) return;
    const targetId = toInt(parts[3]);
    if (!targetId) return sendJson(res, 400, { error: 'bad user id' });
    if (targetId === u.id) return sendJson(res, 400, { error: "can't delete yourself" });
    db.deleteUser(targetId);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/admin/puzzles  — full catalogue with stats, for the ordering UI.
  if (method === 'GET' && parts[1] === 'admin' && parts[2] === 'puzzles' && parts.length === 3) {
    const u = requireAdmin(); if (!u) return;
    return sendJson(res, 200, db.listPuzzles(u.id));
  }

  // PUT /api/admin/puzzles/order  { ids: [...] }  — set the exact pinned order.
  if (method === 'PUT' && parts[1] === 'admin' && parts[2] === 'puzzles' && parts[3] === 'order') {
    const u = requireAdmin(); if (!u) return;
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(toInt).filter((n) => n != null) : null;
    if (!ids) return sendJson(res, 400, { error: 'bad ids' });
    db.reorderPinned(ids);
    return sendJson(res, 200, { ok: true });
  }

  // PATCH /api/admin/puzzles/:id  { pinned, sortOrder }
  if (method === 'PATCH' && parts[1] === 'admin' && parts[2] === 'puzzles' && parts.length === 4) {
    const u = requireAdmin(); if (!u) return;
    const id = toInt(parts[3]);
    if (!id) return sendJson(res, 400, { error: 'bad puzzle id' });
    const body = await readJson(req);
    try {
      db.setPuzzleOrder(id, {
        pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
        sortOrder: toInt(body.sortOrder) ?? undefined,
      });
    } catch (e) {
      return sendJson(res, 404, { error: e.message });
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "not found" });
}

/* --- server ----------------------------------------------------------------- */

export function startServer({ dbPath, port = 8080, host = "127.0.0.1" } = {}) {
  const db = openDb(dbPath);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, db);
      } else {
        await serveStatic(req, res, decodeURIComponent(url.pathname));
      }
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: "server error" });
      console.error("[kcube]", e && e.stack ? e.stack : e);
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      // Prefer "localhost" in the URL when bound to a wildcard/loopback
      // address. Browsers treat localhost as a secure context AND accept it as
      // a WebAuthn RP ID, whereas a bare IP (0.0.0.0 / 127.0.0.1) is rejected
      // as an RP ID — which would make passkey registration fail.
      const url = `http://${displayHost(host)}:${addr.port}/`;
      resolve({ server, db, url, port: addr.port, close: () => { server.close(); db.close(); } });
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
