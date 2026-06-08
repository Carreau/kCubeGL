/* Backend API integration test (no browser needed).
 *
 * Boots the real server against an in-memory SQLite DB and drives the JSON API
 * with fetch: registration, attempts, best-score/leaderboard bookkeeping and
 * the difficulty / skill aggregates. Exits non-zero on the first failure.
 */
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

const win = (token, level, movesUsed, durationMs, optimal = 5) =>
  play(token, level, "won", movesUsed, durationMs, optimal);
async function play(token, level, outcome, movesUsed, durationMs, optimal = 5) {
  const start = await call("POST", "/attempts", { token, body: { level, numCubes: 3, par: 13, optimal } });
  const fin = await call("PATCH", `/attempts/${start.body.attemptId}`, { token, body: { outcome, movesUsed, durationMs } });
  return fin.body;
}

try {
  // health
  eq((await call("GET", "/health")).body.ok, true, "health ok");

  // registration + case-insensitive uniqueness
  const a = await call("POST", "/users", { body: { username: "alice" } });
  eq(a.status, 201, "create alice → 201");
  ok(a.body.token, "alice got a token");
  const tokenA = a.body.token;
  eq((await call("POST", "/users", { body: { username: "Alice" } })).status, 409, "duplicate name → 409");
  eq((await call("POST", "/users", { body: { username: "  " } })).status, 400, "blank name → 400");

  // identity
  eq((await call("GET", "/me", { token: tokenA })).body.username, "alice", "me = alice");
  eq((await call("GET", "/me")).status, 401, "me without token → 401");

  // levels grid (unauth): metadata present, no personal best
  const grid = (await call("GET", "/levels?count=5")).body;
  eq(grid.length, 5, "grid has 5 levels");
  ok(grid[0].par > 0, "level 1 has a par");
  eq(grid[0].yourBest, null, "level 1 yourBest null when unauth");

  // attempts must be authenticated
  eq((await call("POST", "/attempts", { body: { level: 1 } })).status, 401, "attempt without token → 401");

  // alice: win level 1 in 7, then improve to 5, then a loss
  let r = await win(tokenA, 1, 7, 5000);
  eq(r.best, 7, "alice best 7"); eq(r.isRecord, true, "7 is a record"); eq(r.worldBest, 7, "world best 7");
  r = await win(tokenA, 1, 5, 4000);
  eq(r.best, 5, "alice best improves to 5"); eq(r.isRecord, true, "5 is a record"); eq(r.worldBest, 5, "world best 5");
  r = await play(tokenA, 1, "lost", 13, 9000);
  eq(r.isRecord, false, "a loss is not a record"); eq(r.best, 5, "best unchanged after loss");

  // bob: win level 1 in 9 (worse than alice)
  const tokenB = (await call("POST", "/users", { body: { username: "bob" } })).body.token;
  r = await win(tokenB, 1, 9, 8000);
  eq(r.worldBest, 5, "world best still 5 after bob's 9");

  // level detail: leaderboard order + difficulty stats
  const d = (await call("GET", "/levels/1", { token: tokenA })).body;
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
  ok(d.stats.avgAttemptsToBest >= 1, "avg attempts-to-best ≥ 1");

  // player skill summary
  const ms = (await call("GET", "/me/stats", { token: tokenA })).body;
  eq(ms.solved, 1, "alice solved 1 level");
  eq(ms.wins, 2, "alice has 2 wins");
  ok(ms.losses >= 1, "alice has a loss");
  ok(Math.abs(ms.avgMovesOverOptimal - 1) < 1e-9, "alice avg moves over optimal = 1");

  // authed grid now shows alice's best
  const grid2 = (await call("GET", "/levels?count=5", { token: tokenA })).body;
  eq(grid2[0].yourBest, 5, "authed grid shows yourBest 5");
  eq(grid2[0].worldBest, 5, "authed grid shows worldBest 5");
  eq(grid2[0].solvers, 2, "level 1 has 2 solvers");

  // move-sequence recording: the player's cursor path round-trips into the row,
  // and any non-R/L/U/D characters are stripped server-side before storage.
  const moveSeqOf = (id) => db.db.prepare("SELECT move_seq FROM attempts WHERE id = ?").get(id).move_seq;
  const mv = await call("POST", "/attempts", { token: tokenA, body: { level: 3, numCubes: 3, par: 13, optimal: 5 } });
  await call("PATCH", `/attempts/${mv.body.attemptId}`, {
    token: tokenA, body: { outcome: "won", movesUsed: 6, durationMs: 3000, moveSeq: "RR<bad>UULD" },
  });
  eq(moveSeqOf(mv.body.attemptId), "RRUULD", "move sequence stored, junk chars stripped");
  // A sequence of only junk characters collapses to null rather than "".
  const junk = await call("POST", "/attempts", { token: tokenA, body: { level: 4, numCubes: 3, par: 13, optimal: 5 } });
  await call("PATCH", `/attempts/${junk.body.attemptId}`, {
    token: tokenA, body: { outcome: "won", movesUsed: 6, durationMs: 3000, moveSeq: "!!!" },
  });
  eq(moveSeqOf(junk.body.attemptId), null, "junk-only move sequence stored as null");

  // abandon via beacon endpoint (token in body)
  const st = await call("POST", "/attempts", { token: tokenA, body: { level: 2, numCubes: 4, par: 16, optimal: 6 } });
  eq((await call("POST", `/attempts/${st.body.attemptId}/abandon`, { body: { token: tokenA, movesUsed: 2, durationMs: 1000 } })).status, 204, "abandon → 204");
  ok((await call("GET", "/me/stats", { token: tokenA })).body.abandoned >= 1, "abandoned counted");
} catch (e) {
  fails.push("threw: " + (e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  close();
}

if (fails.length) { console.error(`\nAPI test FAILED — ${fails.length} failed, ${passed} passed.`); process.exit(1); }
console.log(`✓ API test passed (${passed} assertions).`);
