/* ============================================================================
 * kCube backend — SQLite data layer (built on Node's built-in node:sqlite).
 *
 * No native modules, no npm install: node:sqlite ships with Node ≥ 22.5. The
 * schema is deliberately attempt-centric — every time a player starts a board
 * we store one `attempts` row and later stamp it with an outcome (won / lost /
 * abandoned), its move count and its duration. Best-scores are then just
 * MIN(moves) over winning attempts, and the richer questions the project wants
 * to answer later — "how skilled is this player?", "how hard is this puzzle?" —
 * are aggregate queries over the same rows (see userStats / levelStats below).
 * ========================================================================== */

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { baseBudget, levelParams } from "../src/shared.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,   -- case-insensitive uniqueness
  token          TEXT NOT NULL UNIQUE,   -- bearer token (this app's only secret)
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS levels (
  level      INTEGER PRIMARY KEY,        -- the puzzle id (deterministic board)
  num_cubes  INTEGER NOT NULL,
  scramble   INTEGER NOT NULL,
  par        INTEGER NOT NULL,           -- bonus-free move budget
  optimal    INTEGER,                    -- shortest known solve (client-reported)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  level       INTEGER NOT NULL REFERENCES levels(level),
  outcome     TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|won|lost|abandoned
  moves_used  INTEGER,
  duration_ms INTEGER,
  move_seq    TEXT,                                 -- player's cursor path (R/L/U/D)
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempts_level       ON attempts(level);
CREATE INDEX IF NOT EXISTS idx_attempts_user_level  ON attempts(user_id, level);
CREATE INDEX IF NOT EXISTS idx_attempts_won         ON attempts(level, outcome, moves_used);
`;

const now = () => Date.now();

export function openDb(path = process.env.KCUBE_DB || "server/kcube.sqlite") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return new Db(db);
}

// Lightweight, idempotent migrations for DBs created before a column existed.
// CREATE TABLE IF NOT EXISTS won't add new columns to an existing table, so we
// ALTER them in by hand when missing.
function migrate(db) {
  ensureColumn(db, "attempts", "move_seq", "TEXT");
}

function ensureColumn(db, table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

export class Db {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }

  /* --- users --------------------------------------------------------------- */

  // Register a username, returning { id, username, token }. Throws an Error with
  // .code === "DUP" if the name (case-insensitively) is taken.
  createUser(username) {
    const token = randomBytes(24).toString("base64url");
    try {
      const r = this.db
        .prepare("INSERT INTO users (username, username_lower, token, created_at) VALUES (?, ?, ?, ?)")
        .run(username, username.toLowerCase(), token, now());
      return { id: Number(r.lastInsertRowid), username, token };
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) {
        const err = new Error("username taken");
        err.code = "DUP";
        throw err;
      }
      throw e;
    }
  }

  userByToken(token) {
    if (!token) return null;
    return this.db.prepare("SELECT id, username FROM users WHERE token = ?").get(token) || null;
  }

  /* --- levels -------------------------------------------------------------- */

  // Upsert a level's metadata. `optimal` is kept as the smallest value reported
  // (the deterministic board has one solution length, so this just pins it).
  ensureLevel(level, { numCubes, par, optimal } = {}) {
    const params = levelParams(level);
    const nc = numCubes ?? params.numCubes;
    const pr = par ?? baseBudget(level);
    const row = this.db.prepare("SELECT * FROM levels WHERE level = ?").get(level);
    if (!row) {
      this.db
        .prepare("INSERT INTO levels (level, num_cubes, scramble, par, optimal, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(level, nc, params.scramble, pr, optimal ?? null, now());
      return;
    }
    if (optimal != null && (row.optimal == null || optimal < row.optimal)) {
      this.db.prepare("UPDATE levels SET optimal = ? WHERE level = ?").run(optimal, level);
    }
  }

  // Level metadata, falling back to the deterministic params when the level has
  // never been touched (so the grid can show par for unplayed levels).
  levelMeta(level) {
    const row = this.db.prepare("SELECT * FROM levels WHERE level = ?").get(level);
    if (row) return { level, numCubes: row.num_cubes, scramble: row.scramble, par: row.par, optimal: row.optimal };
    const p = levelParams(level);
    return { level, numCubes: p.numCubes, scramble: p.scramble, par: baseBudget(level), optimal: null };
  }

  /* --- attempts ------------------------------------------------------------ */

  startAttempt(userId, level) {
    const r = this.db
      .prepare("INSERT INTO attempts (user_id, level, outcome, started_at) VALUES (?, ?, 'in_progress', ?)")
      .run(userId, level, now());
    return Number(r.lastInsertRowid);
  }

  // Finalise the caller's own in-progress attempt. Returns true if a row was
  // updated (false if it wasn't theirs / already closed).
  finishAttempt(id, userId, { outcome, movesUsed, durationMs, moveSeq }) {
    const r = this.db
      .prepare(
        "UPDATE attempts SET outcome = ?, moves_used = ?, duration_ms = ?, move_seq = ?, ended_at = ? " +
        "WHERE id = ? AND user_id = ? AND outcome = 'in_progress'"
      )
      .run(outcome, movesUsed ?? null, durationMs ?? null, moveSeq ?? null, now(), id, userId);
    return r.changes > 0;
  }

  userBest(userId, level) {
    const r = this.db
      .prepare("SELECT MIN(moves_used) AS best FROM attempts WHERE user_id = ? AND level = ? AND outcome = 'won'")
      .get(userId, level);
    return r && r.best != null ? r.best : null;
  }

  worldBest(level) {
    const r = this.db
      .prepare("SELECT MIN(moves_used) AS best FROM attempts WHERE level = ? AND outcome = 'won'")
      .get(level);
    return r && r.best != null ? r.best : null;
  }

  solverCount(level) {
    const r = this.db
      .prepare("SELECT COUNT(DISTINCT user_id) AS n FROM attempts WHERE level = ? AND outcome = 'won'")
      .get(level);
    return r ? r.n : 0;
  }

  /* --- aggregates: leaderboard, puzzle difficulty, player skill ------------ */

  // Top scores for a level: each player's fewest moves, the time of that best
  // run, and how many attempts they've made on the level.
  leaderboard(level, limit = 10) {
    return this.db.prepare(
      `WITH best AS (
         SELECT user_id, MIN(moves_used) AS best
         FROM attempts WHERE level = ? AND outcome = 'won' GROUP BY user_id
       ),
       best_run AS (              -- the specific winning run that hit that best
         SELECT a.user_id, a.duration_ms,
                ROW_NUMBER() OVER (PARTITION BY a.user_id ORDER BY a.id) AS rn
         FROM attempts a JOIN best b ON a.user_id = b.user_id
         WHERE a.level = ? AND a.outcome = 'won' AND a.moves_used = b.best
       )
       SELECT u.id AS user_id, u.username, b.best AS best,
              br.duration_ms AS durationMs,
              (SELECT COUNT(*) FROM attempts a2 WHERE a2.level = ? AND a2.user_id = u.id) AS attempts
       FROM best b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN best_run br ON br.user_id = b.user_id AND br.rn = 1
       ORDER BY b.best ASC, br.duration_ms ASC
       LIMIT ?`
    ).all(level, level, level, limit);
  }

  // Difficulty signals for one puzzle, aggregated across everyone who tried it.
  levelStats(level) {
    const base = this.db.prepare(
      `SELECT
         COUNT(*)                                                  AS attempts,
         COUNT(DISTINCT user_id)                                   AS players,
         SUM(CASE WHEN outcome = 'won'  THEN 1 ELSE 0 END)         AS winAttempts,
         COUNT(DISTINCT CASE WHEN outcome = 'won' THEN user_id END) AS solves,
         AVG(CASE WHEN outcome = 'won' THEN moves_used END)        AS avgMoves,
         MIN(CASE WHEN outcome = 'won' THEN moves_used END)        AS minMoves,
         AVG(CASE WHEN outcome = 'won' THEN duration_ms END)       AS avgDurationMs
       FROM attempts WHERE level = ? AND outcome <> 'in_progress'`
    ).get(level);

    const attempts = base.attempts || 0;
    return {
      players: base.players || 0,
      attempts,
      solves: base.solves || 0,
      winRate: attempts ? (base.winAttempts || 0) / attempts : 0,
      avgMoves: base.avgMoves ?? null,
      minMoves: base.minMoves ?? null,
      avgDurationMs: base.avgDurationMs ?? null,
      // How many tries it typically takes to crack / to optimise this puzzle.
      avgAttemptsToSolve: this._avgAttemptsToReach(level, "first"),
      avgAttemptsToBest: this._avgAttemptsToReach(level, "best"),
    };
  }

  // Average over players of "attempts up to and including the run that first
  // solved (mode='first') or that achieved their personal best (mode='best')".
  _avgAttemptsToReach(level, mode) {
    const target =
      mode === "best"
        ? `SELECT a.user_id, MIN(a.id) AS target_id
             FROM attempts a
             JOIN (SELECT user_id, MIN(moves_used) AS bm FROM attempts
                   WHERE level = ? AND outcome = 'won' GROUP BY user_id) b
               ON a.user_id = b.user_id AND a.moves_used = b.bm
            WHERE a.level = ? AND a.outcome = 'won'
            GROUP BY a.user_id`
        : `SELECT user_id, MIN(id) AS target_id
             FROM attempts WHERE level = ? AND outcome = 'won' GROUP BY user_id`;
    const args = mode === "best" ? [level, level, level] : [level, level];
    const r = this.db.prepare(
      `WITH t AS (${target})
       SELECT AVG(cnt) AS avg FROM (
         SELECT (SELECT COUNT(*) FROM attempts a
                 WHERE a.level = ? AND a.user_id = t.user_id AND a.id <= t.target_id) AS cnt
         FROM t)`
    ).get(...args);
    return r && r.avg != null ? r.avg : null;
  }

  // One player's overall skill summary.
  userStats(userId) {
    const r = this.db.prepare(
      `SELECT
         COUNT(*)                                            AS attempts,
         SUM(CASE WHEN outcome = 'won'       THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN outcome = 'lost'      THEN 1 ELSE 0 END) AS losses,
         SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
         COUNT(DISTINCT CASE WHEN outcome = 'won' THEN level END) AS solved,
         AVG(CASE WHEN outcome = 'won' THEN duration_ms END)      AS avgDurationMs
       FROM attempts WHERE user_id = ? AND outcome <> 'in_progress'`
    ).get(userId);

    // Average moves-over-best-known across winning runs (efficiency signal).
    const over = this.db.prepare(
      `SELECT AVG(a.moves_used - l.optimal) AS d
         FROM attempts a JOIN levels l ON l.level = a.level
        WHERE a.user_id = ? AND a.outcome = 'won' AND l.optimal IS NOT NULL`
    ).get(userId);

    const attempts = r.attempts || 0;
    return {
      attempts,
      wins: r.wins || 0,
      losses: r.losses || 0,
      abandoned: r.abandoned || 0,
      solved: r.solved || 0,
      winRate: attempts ? (r.wins || 0) / attempts : 0,
      avgDurationMs: r.avgDurationMs ?? null,
      avgMovesOverOptimal: over && over.d != null ? over.d : null,
    };
  }

  // Level grid for the landing page: 1..count with your best + world best.
  listLevels(userId, count) {
    const out = [];
    for (let level = 1; level <= count; level++) {
      const meta = this.levelMeta(level);
      out.push({
        level,
        numCubes: meta.numCubes,
        par: meta.par,
        optimal: meta.optimal,
        yourBest: userId ? this.userBest(userId, level) : null,
        worldBest: this.worldBest(level),
        solvers: this.solverCount(level),
      });
    }
    return out;
  }
}
