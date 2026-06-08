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
 * Served as plain static files instead (no server), the game still works on
 * localStorage; the API simply isn't there and the client degrades gracefully.
 * ========================================================================== */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { openDb } from "./db.mjs";

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
const clampLevel = (n) => (Number.isInteger(n) && n >= 1 && n <= 10000 ? n : null);
const VALID_OUTCOME = new Set(["won", "lost", "abandoned"]);

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

  // GET /api/levels?count=N   (auth optional — adds yourBest)
  if (method === "GET" && parts[1] === "levels" && parts.length === 2) {
    const count = Math.max(1, Math.min(60, toInt(searchParams.get("count")) || 12));
    const u = user();
    return sendJson(res, 200, db.listLevels(u ? u.id : null, count));
  }

  // GET /api/levels/:level   (auth optional)
  if (method === "GET" && parts[1] === "levels" && parts.length === 3) {
    const level = clampLevel(toInt(parts[2]));
    if (!level) return sendJson(res, 400, { error: "bad level" });
    const u = user();
    const meta = db.levelMeta(level);
    return sendJson(res, 200, {
      ...meta,
      worldBest: db.worldBest(level),
      yourBest: u ? db.userBest(u.id, level) : null,
      leaderboard: db.leaderboard(level, 10).map((r) => ({
        username: r.username,
        best: r.best,
        durationMs: r.durationMs,
        attempts: r.attempts,
        you: u ? r.user_id === u.id : false,
      })),
      stats: db.levelStats(level),
    });
  }

  // POST /api/attempts  { level, numCubes, par, optimal }
  if (method === "POST" && parts[1] === "attempts" && parts.length === 2) {
    const u = requireUser(); if (!u) return;
    const body = await readJson(req);
    const level = clampLevel(toInt(body.level));
    if (!level) return sendJson(res, 400, { error: "bad level" });
    db.ensureLevel(level, {
      numCubes: toInt(body.numCubes) ?? undefined,
      par: toInt(body.par) ?? undefined,
      optimal: toInt(body.optimal) ?? undefined,
    });
    const { puzzleId } = db.levelMeta(level);
    return sendJson(res, 201, { attemptId: db.startAttempt(u.id, level, puzzleId) });
  }

  // PATCH /api/attempts/:id  { outcome, movesUsed, durationMs }
  if (method === "PATCH" && parts[1] === "attempts" && parts.length === 3) {
    const u = requireUser(); if (!u) return;
    const id = toInt(parts[2]);
    const body = await readJson(req);
    if (!id || !VALID_OUTCOME.has(body.outcome)) {
      return sendJson(res, 400, { error: "bad attempt update" });
    }
    // Find the attempt's level (and confirm it's the caller's own open attempt).
    const row = db.db
      .prepare("SELECT level FROM attempts WHERE id = ? AND user_id = ? AND outcome = 'in_progress'")
      .get(id, u.id);
    if (!row) return sendJson(res, 404, { error: "no such open attempt" });
    const level = row.level;
    const movesUsed = Math.max(0, toInt(body.movesUsed) ?? 0);
    const durationMs = Math.max(0, toInt(body.durationMs) ?? 0);
    // Player's recorded cursor path (R/L/U/D). Keep only the four codes and cap
    // the length so a stray/oversized payload can't bloat the row.
    const moveSeq = typeof body.moveSeq === "string"
      ? body.moveSeq.replace(/[^RLUD]/g, "").slice(0, 4096) || null
      : null;
    const prevBest = db.userBest(u.id, level); // before recording this outcome
    db.finishAttempt(id, u.id, { outcome: body.outcome, movesUsed, durationMs, moveSeq });
    return sendJson(res, 200, {
      best: db.userBest(u.id, level),
      worldBest: db.worldBest(level),
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
      const url = `http://${host}:${addr.port}/`;
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
