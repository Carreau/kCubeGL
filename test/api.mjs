/* Backend API integration test (no browser needed).
 *
 * Boots the real server against an in-memory SQLite DB and drives the JSON API
 * with fetch: registration, the puzzle catalogue, attempts, best-score /
 * leaderboard bookkeeping, the difficulty / skill aggregates, and the admin
 * pin/order endpoints. Exits non-zero on the first failure.
 */
// Set the admin-bootstrap secret before booting so we can mint an admin user.
const ADMIN_TOKEN = "test-admin-secret";
process.env.KCUBE_ADMIN_TOKEN = ADMIN_TOKEN;

import { startServer } from "../server/server.mjs";

let passed = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { passed++; } else { fails.push(msg); console.error("✗ " + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const { url, db, close } = await startServer({ dbPath: ":memory:", port: 0 });
const api = url.replace(/\/$/, "") + "/api";

// fetch helper: returns { status, body }
async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(api + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const win = (token, puzzle, movesUsed, durationMs, optimal = 5) =>
  play(token, puzzle, "won", movesUsed, durationMs, optimal);
async function play(token, puzzle, outcome, movesUsed, durationMs, optimal = 5) {
  const start = await call("POST", "/attempts", { token, body: { puzzle, optimal } });
  const fin = await call("PATCH", `/attempts/${start.body.attemptId}`, { token, body: { outcome, movesUsed, durationMs } });
  return fin.body;
}

try {
  // health
  eq((await call("GET", "/health")).body.ok, true, "health ok");

  // catalogue (unauth): a fixed pool of named puzzles with metadata, no best.
  const cat = (await call("GET", "/puzzles")).body;
  ok(Array.isArray(cat) && cat.length >= 40, "catalogue has the full pool");
  ok(cat.every((p) => typeof p.name === "string" && p.par > 0), "every puzzle has a name + par");
  ok(cat.every((p) => "fullOptimal" in p && "beamMoves" in p && "solvedAt" in p), "every puzzle carries solver difficulty fields");
  ok(cat.every((p) => p.solvedAt == null), "solver values unset until the solver is run");
  eq(cat[0].yourBest, null, "yourBest null when unauth");
  const P0 = cat[0].name, P1 = cat[1].name, P2 = cat[2].name, P3 = cat[3].name;

  // registration + case-insensitive uniqueness. Admin is granted only with the
  // bootstrap secret — there's no "first user wins" magic.
  const a = await call("POST", "/users", { body: { username: "alice", adminToken: ADMIN_TOKEN } });
  eq(a.status, 201, "create alice → 201");
  ok(a.body.token, "alice got a token");
  ok(a.body.isAdmin, "alice presented the bootstrap secret → admin");
  const tokenA = a.body.token;
  eq((await call("POST", "/users", { body: { username: "Alice" } })).status, 409, "duplicate name → 409");
  eq((await call("POST", "/users", { body: { username: "  " } })).status, 400, "blank name → 400");
  // A plain registration (no/incorrect secret) is never admin.
  const plain = await call("POST", "/users", { body: { username: "carol", adminToken: "wrong" } });
  ok(!plain.body.isAdmin, "wrong bootstrap secret → not admin");

  // identity
  eq((await call("GET", "/me", { token: tokenA })).body.username, "alice", "me = alice");
  eq((await call("GET", "/me")).status, 401, "me without token → 401");

  // attempts must be authenticated; unknown puzzles are rejected
  eq((await call("POST", "/attempts", { body: { puzzle: P0 } })).status, 401, "attempt without token → 401");
  eq((await call("POST", "/attempts", { token: tokenA, body: { puzzle: "no-such-puzzle" } })).status, 404, "unknown puzzle → 404");

  // alice: win P0 in 7, then improve to 5, then a loss
  let r = await win(tokenA, P0, 7, 5000);
  eq(r.best, 7, "alice best 7"); eq(r.isRecord, true, "7 is a record"); eq(r.worldBest, 7, "world best 7");
  r = await win(tokenA, P0, 5, 4000);
  eq(r.best, 5, "alice best improves to 5"); eq(r.isRecord, true, "5 is a record"); eq(r.worldBest, 5, "world best 5");
  r = await play(tokenA, P0, "lost", 13, 9000);
  eq(r.isRecord, false, "a loss is not a record"); eq(r.best, 5, "best unchanged after loss");

  // bob: win P0 in 9 (worse than alice)
  const tokenB = (await call("POST", "/users", { body: { username: "bob" } })).body.token;
  r = await win(tokenB, P0, 9, 8000);
  eq(r.worldBest, 5, "world best still 5 after bob's 9");

  // puzzle detail: leaderboard order + difficulty stats
  const d = (await call("GET", `/puzzles/${P0}`, { token: tokenA })).body;
  eq(d.worldBest, 5, "detail world best 5");
  eq(d.yourBest, 5, "detail your best 5 (alice)");
  eq(d.leaderboard[0].username, "alice", "leaderboard #1 is alice");
  eq(d.leaderboard[0].best, 5, "leaderboard #1 best 5");
  eq(d.leaderboard[0].you, true, "leaderboard marks you");
  eq(d.leaderboard[1].username, "bob", "leaderboard #2 is bob");
  eq(d.stats.solves, 2, "2 distinct solvers");
  eq(d.stats.players, 2, "2 players");
  ok(d.stats.attempts >= 4, "at least 4 attempts recorded");
  ok(d.stats.winRate > 0 && d.stats.winRate <= 1, "win rate in (0,1]");
  ok(Math.abs(d.stats.winRate + d.stats.failRate - 1) < 1e-9, "win + fail rate = 1");
  ok(d.stats.avgAttemptsToBest >= 1, "avg attempts-to-best ≥ 1");

  // player skill summary
  const ms = (await call("GET", "/me/stats", { token: tokenA })).body;
  eq(ms.solved, 1, "alice solved 1 puzzle");
  eq(ms.wins, 2, "alice has 2 wins");
  ok(ms.losses >= 1, "alice has a loss");
  ok(Math.abs(ms.avgMovesOverOptimal - 1) < 1e-9, "alice avg moves over optimal = 1");

  // authed catalogue now shows alice's best for P0
  const cat2 = (await call("GET", "/puzzles", { token: tokenA })).body;
  const p0row = cat2.find((p) => p.name === P0);
  eq(p0row.yourBest, 5, "authed catalogue shows yourBest 5");
  eq(p0row.worldBest, 5, "authed catalogue shows worldBest 5");
  eq(p0row.solvers, 2, "P0 has 2 solvers");

  // move-sequence recording: the player's cursor path round-trips into the row,
  // and any non-R/L/U/D characters are stripped server-side before storage.
  const moveSeqOf = (id) => db.db.prepare("SELECT move_seq FROM attempts WHERE id = ?").get(id).move_seq;
  const mv = await call("POST", "/attempts", { token: tokenA, body: { puzzle: P2, optimal: 5 } });
  await call("PATCH", `/attempts/${mv.body.attemptId}`, {
    token: tokenA, body: { outcome: "won", movesUsed: 6, durationMs: 3000, moveSeq: "RR<bad>UULD" },
  });
  eq(moveSeqOf(mv.body.attemptId), "RRUULD", "move sequence stored, junk chars stripped");
  // A sequence of only junk characters collapses to null rather than "".
  const junk = await call("POST", "/attempts", { token: tokenA, body: { puzzle: P3, optimal: 5 } });
  await call("PATCH", `/attempts/${junk.body.attemptId}`, {
    token: tokenA, body: { outcome: "won", movesUsed: 6, durationMs: 3000, moveSeq: "!!!" },
  });
  eq(moveSeqOf(junk.body.attemptId), null, "junk-only move sequence stored as null");

  // abandon via beacon endpoint (token in body)
  const st = await call("POST", "/attempts", { token: tokenA, body: { puzzle: P1, optimal: 6 } });
  eq((await call("POST", `/attempts/${st.body.attemptId}/abandon`, { body: { token: tokenA, movesUsed: 2, durationMs: 1000 } })).status, 204, "abandon → 204");
  ok((await call("GET", "/me/stats", { token: tokenA })).body.abandoned >= 1, "abandoned counted");

  // --- admin: pin + order puzzles ---
  eq((await call("GET", "/admin/puzzles")).status, 401, "admin puzzles needs auth");
  eq((await call("GET", "/admin/puzzles", { token: tokenB })).status, 403, "non-admin → 403");
  const adminCat = (await call("GET", "/admin/puzzles", { token: tokenA })).body;
  const id1 = adminCat.find((p) => p.name === P1).id;
  const id2 = adminCat.find((p) => p.name === P2).id;
  // Feature P2 then P1 (in that order).
  eq((await call("PUT", "/admin/puzzles/order", { token: tokenA, body: { ids: [id2, id1] } })).status, 200, "reorder → 200");
  const pinned = (await call("GET", "/puzzles")).body;
  eq(pinned[0].name, P2, "P2 is featured first");
  eq(pinned[1].name, P1, "P1 is featured second");
  ok(pinned[0].pinned && pinned[1].pinned, "first two are pinned");
  ok(!pinned[2].pinned, "the rest are not pinned");
  // Unpin everything via PATCH on P2.
  eq((await call("PATCH", `/admin/puzzles/${id2}`, { token: tokenA, body: { pinned: false } })).status, 200, "patch unpin → 200");
  const afterUnpin = (await call("GET", "/puzzles")).body.find((p) => p.name === P2);
  ok(!afterUnpin.pinned, "P2 no longer pinned");

  // --- admin: run the BFS + beam solver for one puzzle ---
  const easy = adminCat.reduce((a, b) => (b.numCubes < a.numCubes ? b : a));
  eq((await call("POST", `/admin/puzzles/${easy.id}/solve`)).status, 401, "solve needs auth");
  eq((await call("POST", `/admin/puzzles/${easy.id}/solve`, { token: tokenB })).status, 403, "non-admin can't solve");
  const solved = (await call("POST", `/admin/puzzles/${easy.id}/solve`, { token: tokenA })).body;
  ok(solved.solvedAt > 0, "solve stamps solvedAt");
  ok(typeof solved.beamMoves === "number", "beam solver found a solution");
  const reloaded = (await call("GET", "/admin/puzzles", { token: tokenA })).body.find((p) => p.id === easy.id);
  ok(reloaded.solvedAt > 0 && reloaded.beamMoves === solved.beamMoves, "solver values persisted to the catalogue");
} catch (e) {
  fails.push("threw: " + (e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  close();
}

if (fails.length) { console.error(`\nAPI test FAILED — ${fails.length} failed, ${passed} passed.`); process.exit(1); }
console.log(`✓ API test passed (${passed} assertions).`);
