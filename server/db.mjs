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
 *
 * Level ordering design
 * ─────────────────────
 * `puzzles`  — the actual puzzle content: a (seed, num_cubes, scramble, par)
 *              tuple that the client feeds to mulberry32 to reproduce the board
 *              deterministically. Decoupled from slot ordering.
 * `levels`   — ordered slots (level 1, 2, 3 …). Each slot points to a puzzle
 *              via puzzle_id. Swapping puzzle_id reorders without touching
 *              puzzle content or historical attempt data.
 * `attempts` — records both the slot (level) and the puzzle (puzzle_id) so
 *              per-puzzle difficulty stats survive reordering.
 * ========================================================================== */

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { baseBudget, hashLevelSeed, levelParams } from "../src/shared.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,   -- case-insensitive uniqueness
  token          TEXT NOT NULL UNIQUE,   -- bearer token (this app's only secret)
  created_at     INTEGER NOT NULL,
  is_admin       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id  TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key     TEXT NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge   TEXT PRIMARY KEY,
  user_id     INTEGER,
  expires_at  INTEGER NOT NULL
);

-- Puzzle content: decoupled from slot ordering. seed feeds mulberry32 in the
-- browser; num_cubes/scramble/par describe the board size and difficulty.
CREATE TABLE IF NOT EXISTS puzzles (
  id         INTEGER PRIMARY KEY,
  seed       INTEGER NOT NULL,           -- PRNG seed; deterministically reproduces the board
  num_cubes  INTEGER NOT NULL,
  scramble   INTEGER NOT NULL,
  par        INTEGER NOT NULL,           -- bonus-free move budget
  optimal    INTEGER,                    -- shortest known solve (client-reported)
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Level slots: the ordered list players navigate as "level 1, 2, 3 …".
-- puzzle_id may be reassigned to reorder without touching attempt history.
CREATE TABLE IF NOT EXISTS levels (
  level      INTEGER PRIMARY KEY,        -- slot number shown to players
  puzzle_id  INTEGER REFERENCES puzzles(id),
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
  puzzle_id   INTEGER REFERENCES puzzles(id),           -- which puzzle was actually played
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
CREATE INDEX IF NOT EXISTS idx_attempts_puzzle      ON attempts(puzzle_id, outcome, moves_used);
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
  ensureColumn(db, "levels", "puzzle_id", "INTEGER");
  ensureColumn(db, "attempts", "puzzle_id", "INTEGER");
  ensureColumn(db, "users", "is_admin", "INTEGER NOT NULL DEFAULT 0");

  // Back-fill puzzle rows for any level slots that predate the puzzles table.
  // Uses the same seed formula the client falls back to offline, so existing
  // boards are reproduced identically.
  const unpopulated = db.prepare("SELECT * FROM levels WHERE puzzle_id IS NULL").all();
  if (unpopulated.length > 0) {
    const insertPuzzle = db.prepare(
      "INSERT INTO puzzles (seed, num_cubes, scramble, par, optimal, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const updateLevel = db.prepare("UPDATE levels SET puzzle_id = ? WHERE level = ?");
    for (const row of unpopulated) {
      const seed = hashLevelSeed(row.level);
      const result = insertPuzzle.run(seed, row.num_cubes, row.scramble, row.par, row.optimal, row.created_at);
      updateLevel.run(Number(result.lastInsertRowid), row.level);
    }
  }
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

  // Register a username, returning { id, username, token, isAdmin }. Throws an
  // Error with .code === "DUP" if the name (case-insensitively) is taken.
  // The very first user created automatically becomes admin.
  createUser(username) {
    const token = randomBytes(24).toString("base64url");
    const isFirst = this.db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0;
    const isAdmin = isFirst ? 1 : 0;
    try {
      const r = this.db
        .prepare("INSERT INTO users (username, username_lower, token, created_at, is_admin) VALUES (?, ?, ?, ?, ?)")
        .run(username, username.toLowerCase(), token, now(), isAdmin);
      return { id: Number(r.lastInsertRowid), username, token, isAdmin: isAdmin === 1 };
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
    const row = this.db.prepare("SELECT id, username, is_admin FROM users WHERE token = ?").get(token);
    if (!row) return null;
    return { id: row.id, username: row.username, isAdmin: row.is_admin === 1 };
  }

  // Returns full user info including token (for passkey login).
  getUserByIdFull(userId) {
    const row = this.db.prepare("SELECT id, username, token, is_admin FROM users WHERE id = ?").get(userId);
    if (!row) return null;
    return { id: row.id, username: row.username, token: row.token, isAdmin: row.is_admin === 1 };
  }

  /* --- passkeys --------------------------------------------------------------- */

  createPasskey(userId, credentialId, publicKey, counter) {
    this.db.prepare(
      "INSERT INTO passkeys (credential_id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(credentialId, userId, publicKey, counter, now());
  }

  getPasskeyById(credentialId) {
    return this.db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").get(credentialId) || null;
  }

  updatePasskeyCounter(credentialId, counter) {
    this.db.prepare("UPDATE passkeys SET counter = ? WHERE credential_id = ?").run(counter, credentialId);
  }

  getUserPasskeys(userId) {
    return this.db.prepare(
      "SELECT credential_id, created_at FROM passkeys WHERE user_id = ? ORDER BY created_at DESC"
    ).all(userId);
  }

  deletePasskey(credentialId, userId) {
    const r = this.db.prepare("DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?").run(credentialId, userId);
    return r.changes > 0;
  }

  /* --- webauthn challenges ---------------------------------------------------- */

  saveChallenge(challenge, userId = null) {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    this.db.prepare(
      "INSERT OR REPLACE INTO webauthn_challenges (challenge, user_id, expires_at) VALUES (?, ?, ?)"
    ).run(challenge, userId, expiresAt);
  }

  consumeChallenge(challenge) {
    const row = this.db.prepare("SELECT * FROM webauthn_challenges WHERE challenge = ?").get(challenge);
    if (!row) return null;
    this.db.prepare("DELETE FROM webauthn_challenges WHERE challenge = ?").run(challenge);
    if (row.expires_at < Date.now()) return null;
    return row;
  }

  /* --- admin ------------------------------------------------------------------ */

  listUsers() {
    return this.db.prepare(`
      SELECT u.id, u.username, u.is_admin AS isAdmin, u.created_at AS createdAt,
             COUNT(p.credential_id) AS passkeyCount
      FROM users u LEFT JOIN passkeys p ON p.user_id = u.id
      GROUP BY u.id ORDER BY u.id ASC
    `).all().map(r => ({ ...r, isAdmin: r.isAdmin === 1 }));
  }

  setUserAdmin(userId, isAdmin) {
    this.db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, userId);
  }

  deleteUser(userId) {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }

  /* --- puzzles ------------------------------------------------------------- */

  // Find or create a puzzle by seed. Returns the puzzle id.
  ensurePuzzle({ seed, numCubes, scramble, par, optimal = null }) {
    const existing = this.db.prepare("SELECT id FROM puzzles WHERE seed = ?").get(seed);
    if (existing) {
      if (optimal != null) {
        this.db.prepare(
          "UPDATE puzzles SET optimal = ? WHERE id = ? AND (optimal IS NULL OR optimal > ?)"
        ).run(optimal, existing.id, optimal);
      }
      return existing.id;
    }
    const r = this.db
      .prepare("INSERT INTO puzzles (seed, num_cubes, scramble, par, optimal, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(seed, numCubes, scramble, par, optimal, now());
    return Number(r.lastInsertRowid);
  }

  /* --- levels -------------------------------------------------------------- */

  // Upsert a level slot's metadata. Creates a puzzle row on first touch so the
  // slot always points to a stored puzzle (enabling later reordering).
  ensureLevel(level, { numCubes, par, optimal } = {}) {
    const params = levelParams(level);
    const nc = numCubes ?? params.numCubes;
    const sc = params.scramble;
    const pr = par ?? baseBudget(level);
    const seed = hashLevelSeed(level);

    const row = this.db.prepare("SELECT * FROM levels WHERE level = ?").get(level);
    if (!row) {
      const puzzleId = this.ensurePuzzle({ seed, numCubes: nc, scramble: sc, par: pr, optimal });
      this.db
        .prepare("INSERT INTO levels (level, puzzle_id, num_cubes, scramble, par, optimal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(level, puzzleId, nc, sc, pr, optimal ?? null, now());
      return;
    }

    // Level exists: propagate a better optimal to both tables.
    if (optimal != null && (row.optimal == null || optimal < row.optimal)) {
      this.db.prepare("UPDATE levels SET optimal = ? WHERE level = ?").run(optimal, level);
      if (row.puzzle_id) {
        this.db.prepare(
          "UPDATE puzzles SET optimal = ? WHERE id = ? AND (optimal IS NULL OR optimal > ?)"
        ).run(optimal, row.puzzle_id, optimal);
      }
    }
  }

  // Level metadata, falling back to the deterministic params when the level has
  // never been touched (so the grid can show par for unplayed levels). Always
  // returns a seed so the client can reproduce the board without the game engine.
  levelMeta(level) {
    const row = this.db.prepare(
      `SELECT l.level, l.puzzle_id, l.num_cubes, l.scramble, l.par, l.optimal, p.seed
         FROM levels l LEFT JOIN puzzles p ON p.id = l.puzzle_id
        WHERE l.level = ?`
    ).get(level);
    if (row) {
      return {
        level,
        puzzleId: row.puzzle_id,
        seed: row.seed ?? hashLevelSeed(level),
        numCubes: row.num_cubes,
        scramble: row.scramble,
        par: row.par,
        optimal: row.optimal,
      };
    }
    // Unplayed level: compute from slot number (same formula the client uses offline).
    const p = levelParams(level);
    return {
      level,
      puzzleId: null,
      seed: hashLevelSeed(level),
      numCubes: p.numCubes,
      scramble: p.scramble,
      par: baseBudget(level),
      optimal: null,
    };
  }

  /* --- attempts ------------------------------------------------------------ */

  startAttempt(userId, level, puzzleId = null) {
    const r = this.db
      .prepare("INSERT INTO attempts (user_id, level, puzzle_id, outcome, started_at) VALUES (?, ?, ?, 'in_progress', ?)")
      .run(userId, level, puzzleId, now());
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
    // Join via puzzles so the optimal reflects the puzzle content, not the slot.
    const over = this.db.prepare(
      `SELECT AVG(a.moves_used - p.optimal) AS d
         FROM attempts a JOIN puzzles p ON p.id = a.puzzle_id
        WHERE a.user_id = ? AND a.outcome = 'won' AND p.optimal IS NOT NULL`
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

  // Assign a different puzzle to a level slot — the core reordering operation.
  // The slot's play history (attempts) is unaffected; future plays get the new
  // puzzle. Throws if puzzleId doesn't reference a known puzzle.
  assignPuzzle(slot, puzzleId) {
    const puzzle = this.db.prepare("SELECT id FROM puzzles WHERE id = ?").get(puzzleId);
    if (!puzzle) throw new Error(`puzzle ${puzzleId} not found`);
    const p = this.db.prepare("SELECT * FROM puzzles WHERE id = ?").get(puzzleId);
    const row = this.db.prepare("SELECT * FROM levels WHERE level = ?").get(slot);
    if (!row) {
      this.db.prepare(
        "INSERT INTO levels (level, puzzle_id, num_cubes, scramble, par, optimal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(slot, puzzleId, p.num_cubes, p.scramble, p.par, p.optimal, now());
    } else {
      this.db.prepare(
        "UPDATE levels SET puzzle_id = ?, num_cubes = ?, scramble = ?, par = ?, optimal = ? WHERE level = ?"
      ).run(puzzleId, p.num_cubes, p.scramble, p.par, p.optimal, slot);
    }
  }

  // Pre-populate puzzle rows and level slots for 1..maxSlot so they can be
  // reordered before anyone plays. Safe to call repeatedly (idempotent).
  seedSlots(maxSlot) {
    for (let slot = 1; slot <= maxSlot; slot++) {
      const params = levelParams(slot);
      const seed = hashLevelSeed(slot);
      const par = baseBudget(slot);
      const puzzleId = this.ensurePuzzle({ seed, ...params, par });
      const row = this.db.prepare("SELECT puzzle_id FROM levels WHERE level = ?").get(slot);
      if (!row) {
        this.db.prepare(
          "INSERT INTO levels (level, puzzle_id, num_cubes, scramble, par, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(slot, puzzleId, params.numCubes, params.scramble, par, now());
      } else if (!row.puzzle_id) {
        this.db.prepare("UPDATE levels SET puzzle_id = ? WHERE level = ?").run(puzzleId, slot);
      }
    }
  }

  // Level grid for the landing page: 1..count with your best + world best.
  listLevels(userId, count) {
    const out = [];
    for (let level = 1; level <= count; level++) {
      const meta = this.levelMeta(level);
      out.push({
        level,
        puzzleId: meta.puzzleId,
        seed: meta.seed,
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
