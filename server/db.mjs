/* ============================================================================
 * kCube backend — SQLite data layer (built on Node's built-in node:sqlite).
 *
 * No native modules, no npm install: node:sqlite ships with Node ≥ 22.5. The
 * schema is deliberately attempt-centric — every time a player starts a board
 * we store one `attempts` row and later stamp it with an outcome (won / lost /
 * abandoned), its move count and its duration. Best-scores are then just
 * MIN(moves) over winning attempts, and the richer questions the project wants
 * to answer — "how skilled is this player?", "how hard is this puzzle?" — are
 * aggregate queries over the same rows (see userStats / puzzleStats below).
 *
 * Puzzle model
 * ────────────
 * `puzzles`  — the actual puzzle content AND identity. Each row is the opaque
 *              key everything else references (attempts.puzzle_id). It carries a
 *              stable random `name` (shown to players and used in URLs), the
 *              `seed` the client feeds to mulberry32 to reproduce the board, the
 *              board size/difficulty, and admin ordering (`pinned`, `sort_order`).
 *              The catalogue is a fixed pool seeded from src/shared.mjs — there
 *              is no level numbering and no infinite auto-create.
 * `attempts` — one row per started board, referencing the puzzle by id so
 *              per-puzzle difficulty stats are unambiguous.
 * ========================================================================== */

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { buildCatalog, gravatarHash } from "../src/shared.mjs";
import { solveCatalogPuzzle } from "../src/catalog-solve.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,   -- case-insensitive uniqueness
  token          TEXT NOT NULL UNIQUE,   -- bearer token (this app's only secret)
  created_at     INTEGER NOT NULL,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  -- Gravatar hash derived from the player's email. We hash the email and keep
  -- ONLY the hash (never the raw address); non-null means an email was supplied.
  avatar_hash    TEXT
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
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

-- Puzzle content + identity. The id is the opaque key everything references;
-- name is the stable, human-friendly handle shown to players and used in URLs.
CREATE TABLE IF NOT EXISTS puzzles (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,      -- random handle, also the public key
  seed        INTEGER NOT NULL,          -- PRNG seed; reproduces the board
  num_cubes   INTEGER NOT NULL,
  scramble    INTEGER NOT NULL,          -- generation depth ≈ shortest solve
  par         INTEGER NOT NULL,          -- bonus-free move budget
  optimal     INTEGER,                   -- shortest known solve (client-reported)
  pinned      INTEGER NOT NULL DEFAULT 0,-- admin "feature this first" flag
  sort_order  INTEGER NOT NULL DEFAULT 0,-- admin ordering among pinned puzzles
  full_optimal INTEGER,                  -- full solver (BFS) optimal roll count
  beam_moves   INTEGER,                  -- beam-search approximate roll count
  min_beam_width INTEGER,                -- min beam width to solve (search-effort difficulty guide)
  solved_at    INTEGER,                  -- when the solver was last run (null = never)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  puzzle_id   INTEGER NOT NULL REFERENCES puzzles(id),
  outcome     TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|won|lost|abandoned
  moves_used  INTEGER,
  duration_ms INTEGER,
  move_seq    TEXT,                                 -- player's cursor path (R/L/U/D)
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempts_puzzle      ON attempts(puzzle_id);
CREATE INDEX IF NOT EXISTS idx_attempts_user_puzzle ON attempts(user_id, puzzle_id);
CREATE INDEX IF NOT EXISTS idx_attempts_won         ON attempts(puzzle_id, outcome, moves_used);
`;

const now = () => Date.now();

// A "this id doesn't exist" error the routing layer can map to 404, distinct
// from an unexpected failure (which should surface as a 500).
function notFound(id) {
  const err = new Error(`puzzle ${id} not found`);
  err.code = "NOT_FOUND";
  return err;
}

export function openDb(path = process.env.KCUBE_DB || "server/kcube.sqlite") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // Additive migration: add color_beams if it doesn't exist yet (safe to retry).
  try { db.exec("ALTER TABLE puzzles ADD COLUMN color_beams TEXT"); } catch (_) {}
  const wrapped = new Db(db);
  wrapped.seedCatalog();
  return wrapped;
}

export class Db {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }

  /* --- users --------------------------------------------------------------- */

  // Register a username, returning { id, username, token, isAdmin, avatarHash }.
  // An optional email links a real Gravatar — we hash it and store ONLY the hash
  // (never the raw address). Throws an Error with .code === "DUP" if the name
  // (case-insensitively) is taken. Admin is granted only when the caller proves
  // the bootstrap secret (KCUBE_ADMIN_TOKEN) — see the POST /api/users route.
  createUser(username, { admin = false, email = null } = {}) {
    const token = randomBytes(24).toString("base64url");
    const isAdmin = admin ? 1 : 0;
    const hash = email ? gravatarHash(email) : null;
    try {
      const r = this.db
        .prepare("INSERT INTO users (username, username_lower, token, created_at, is_admin, avatar_hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(username, username.toLowerCase(), token, now(), isAdmin, hash);
      return { id: Number(r.lastInsertRowid), username, token, isAdmin: isAdmin === 1, avatarHash: hash };
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
    const row = this.db.prepare("SELECT id, username, is_admin, avatar_hash FROM users WHERE token = ?").get(token);
    if (!row) return null;
    return { id: row.id, username: row.username, isAdmin: row.is_admin === 1, avatarHash: row.avatar_hash ?? null };
  }

  // Set (or clear, with null/empty) a user's Gravatar by email. We hash the
  // email and store ONLY the hash — the raw address is never persisted.
  // Returns the stored { avatarHash }.
  setUserEmail(userId, email) {
    const hash = email ? gravatarHash(email) : null;
    this.db.prepare("UPDATE users SET avatar_hash = ? WHERE id = ?").run(hash, userId);
    return { avatarHash: hash };
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

  /* --- webauthn challenges ---------------------------------------------------- */

  saveChallenge(challenge, userId = null) {
    // Opportunistically sweep expired challenges so abandoned ones don't pile up.
    this.db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").run(Date.now());
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

  /* --- admin: users ----------------------------------------------------------- */

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

  // Idempotently insert the fixed catalogue (from src/shared.mjs). Matches on
  // the unique name, so re-running never duplicates and never disturbs admin
  // ordering or attempt history. New catalogue entries are appended.
  seedCatalog() {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO puzzles (name, seed, num_cubes, scramble, par, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const ts = now();
    for (const p of buildCatalog()) {
      insert.run(p.name, p.seed, p.numCubes, p.scramble, p.par, p.order, ts);
    }
  }

  puzzleById(id) {
    return this.db.prepare("SELECT * FROM puzzles WHERE id = ?").get(id) || null;
  }

  puzzleByName(name) {
    return this.db.prepare("SELECT * FROM puzzles WHERE name = ?").get(name) || null;
  }

  // Shape a stored row into the metadata the client expects.
  _puzzleMeta(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      seed: row.seed,
      numCubes: row.num_cubes,
      scramble: row.scramble,
      par: row.par,
      optimal: row.optimal,
      pinned: row.pinned === 1,
      sortOrder: row.sort_order,
    };
  }

  puzzleMeta(name) {
    return this._puzzleMeta(this.puzzleByName(name));
  }

  // Record a better optimal (shortest known solve) for a puzzle.
  recordOptimal(puzzleId, optimal) {
    if (optimal == null) return;
    this.db.prepare(
      "UPDATE puzzles SET optimal = ? WHERE id = ? AND (optimal IS NULL OR optimal > ?)"
    ).run(optimal, puzzleId, optimal);
  }

  // Run the solvers (full/BFS + beam) for one puzzle and persist the results.
  // This is an explicit, admin-triggered step: reproducing the board and running
  // BFS can take a few seconds on the hardest boards, so we never do it at boot.
  // Returns the stored difficulty signals. `fullOptimal`/`beamMoves`/
  // `minBeamWidth` are null when the corresponding solver found no solution
  // within its budget. `minBeamWidth` is the search-effort difficulty guide:
  // the smallest beam width that solves the board (1 ≈ no planning needed).
  solvePuzzle(puzzleId) {
    const row = this.puzzleById(puzzleId);
    if (!row) throw notFound(puzzleId);
    const r = solveCatalogPuzzle({
      seed: row.seed, numCubes: row.num_cubes, scramble: row.scramble,
    });
    const ts = now();
    this.db.prepare(
      "UPDATE puzzles SET full_optimal = ?, beam_moves = ?, min_beam_width = ?, color_beams = ?, solved_at = ? WHERE id = ?"
    ).run(r.bfs ?? null, r.beam ?? null, r.searchWidth ?? null, JSON.stringify(r.colorBeams), ts, puzzleId);
    return {
      fullOptimal: r.bfs ?? null, beamMoves: r.beam ?? null,
      minBeamWidth: r.searchWidth ?? null, colorBeams: r.colorBeams, solvedAt: ts,
    };
  }

  /* --- admin: puzzle ordering ------------------------------------------------- */

  // Pin / unpin a puzzle and optionally set its position among pinned puzzles.
  setPuzzleOrder(puzzleId, { pinned, sortOrder } = {}) {
    const row = this.puzzleById(puzzleId);
    if (!row) throw notFound(puzzleId);
    const p = pinned == null ? row.pinned : (pinned ? 1 : 0);
    const so = sortOrder == null ? row.sort_order : sortOrder;
    this.db.prepare("UPDATE puzzles SET pinned = ?, sort_order = ? WHERE id = ?").run(p, so, puzzleId);
  }

  // Set the exact pinned order from an ordered list of puzzle ids: those ids
  // become the pinned puzzles (in the given order), everything else is unpinned.
  reorderPinned(orderedIds) {
    const unpinAll = this.db.prepare("UPDATE puzzles SET pinned = 0");
    const pin = this.db.prepare("UPDATE puzzles SET pinned = 1, sort_order = ? WHERE id = ?");
    const tx = this.db.prepare("BEGIN");
    tx.run();
    try {
      unpinAll.run();
      orderedIds.forEach((id, i) => pin.run(i + 1, id));
      this.db.prepare("COMMIT").run();
    } catch (e) {
      this.db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  /* --- attempts ------------------------------------------------------------ */

  startAttempt(userId, puzzleId) {
    const r = this.db
      .prepare("INSERT INTO attempts (user_id, puzzle_id, outcome, started_at) VALUES (?, ?, 'in_progress', ?)")
      .run(userId, puzzleId, now());
    return Number(r.lastInsertRowid);
  }

  // The caller's own still-open attempt, or null. Keeps raw SQL in the data layer.
  openAttempt(id, userId) {
    return this.db
      .prepare("SELECT id, puzzle_id FROM attempts WHERE id = ? AND user_id = ? AND outcome = 'in_progress'")
      .get(id, userId) || null;
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

  userBest(userId, puzzleId) {
    const r = this.db
      .prepare("SELECT MIN(moves_used) AS best FROM attempts WHERE user_id = ? AND puzzle_id = ? AND outcome = 'won'")
      .get(userId, puzzleId);
    return r && r.best != null ? r.best : null;
  }

  worldBest(puzzleId) {
    const r = this.db
      .prepare("SELECT MIN(moves_used) AS best FROM attempts WHERE puzzle_id = ? AND outcome = 'won'")
      .get(puzzleId);
    return r && r.best != null ? r.best : null;
  }

  /* --- aggregates: leaderboard, puzzle difficulty, player skill ------------ */

  // Top scores for a puzzle: each player's fewest moves, the time of that best
  // run, and how many attempts they've made on the puzzle.
  leaderboard(puzzleId, limit = 10) {
    return this.db.prepare(
      `WITH best AS (
         SELECT user_id, MIN(moves_used) AS best
         FROM attempts WHERE puzzle_id = ? AND outcome = 'won' GROUP BY user_id
       ),
       best_run AS (              -- the specific winning run that hit that best
         SELECT a.user_id, a.duration_ms,
                ROW_NUMBER() OVER (PARTITION BY a.user_id ORDER BY a.id) AS rn
         FROM attempts a JOIN best b ON a.user_id = b.user_id
         WHERE a.puzzle_id = ? AND a.outcome = 'won' AND a.moves_used = b.best
       )
       SELECT u.id AS user_id, u.username, u.avatar_hash AS avatarHash, b.best AS best,
              br.duration_ms AS durationMs,
              (SELECT COUNT(*) FROM attempts a2 WHERE a2.puzzle_id = ? AND a2.user_id = u.id) AS attempts
       FROM best b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN best_run br ON br.user_id = b.user_id AND br.rn = 1
       ORDER BY b.best ASC, br.duration_ms ASC
       LIMIT ?`
    ).all(puzzleId, puzzleId, puzzleId, limit);
  }

  // Difficulty signals for one puzzle, aggregated across everyone who tried it.
  puzzleStats(puzzleId) {
    const base = this.db.prepare(
      `SELECT
         COUNT(*)                                                  AS attempts,
         COUNT(DISTINCT user_id)                                   AS players,
         SUM(CASE WHEN outcome = 'won'  THEN 1 ELSE 0 END)         AS winAttempts,
         COUNT(DISTINCT CASE WHEN outcome = 'won' THEN user_id END) AS solves,
         AVG(CASE WHEN outcome = 'won' THEN moves_used END)        AS avgMoves,
         MIN(CASE WHEN outcome = 'won' THEN moves_used END)        AS minMoves,
         AVG(CASE WHEN outcome = 'won' THEN duration_ms END)       AS avgDurationMs
       FROM attempts WHERE puzzle_id = ? AND outcome <> 'in_progress'`
    ).get(puzzleId);

    const attempts = base.attempts || 0;
    const winRate = attempts ? (base.winAttempts || 0) / attempts : 0;
    return {
      players: base.players || 0,
      attempts,
      solves: base.solves || 0,
      winRate,
      failRate: attempts ? 1 - winRate : 0,
      avgMoves: base.avgMoves ?? null,
      minMoves: base.minMoves ?? null,
      avgDurationMs: base.avgDurationMs ?? null,
      // How many tries it typically takes to crack / to optimise this puzzle.
      avgAttemptsToSolve: this._avgAttemptsToReach(puzzleId, "first"),
      avgAttemptsToBest: this._avgAttemptsToReach(puzzleId, "best"),
    };
  }

  // Average over players of "attempts up to and including the run that first
  // solved (mode='first') or that achieved their personal best (mode='best')".
  _avgAttemptsToReach(puzzleId, mode) {
    const target =
      mode === "best"
        ? `SELECT a.user_id, MIN(a.id) AS target_id
             FROM attempts a
             JOIN (SELECT user_id, MIN(moves_used) AS bm FROM attempts
                   WHERE puzzle_id = ? AND outcome = 'won' GROUP BY user_id) b
               ON a.user_id = b.user_id AND a.moves_used = b.bm
            WHERE a.puzzle_id = ? AND a.outcome = 'won'
            GROUP BY a.user_id`
        : `SELECT user_id, MIN(id) AS target_id
             FROM attempts WHERE puzzle_id = ? AND outcome = 'won' GROUP BY user_id`;
    const args = mode === "best" ? [puzzleId, puzzleId, puzzleId] : [puzzleId, puzzleId];
    const r = this.db.prepare(
      `WITH t AS (${target})
       SELECT AVG(cnt) AS avg FROM (
         SELECT (SELECT COUNT(*) FROM attempts a
                 WHERE a.puzzle_id = ? AND a.user_id = t.user_id AND a.id <= t.target_id) AS cnt
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
         COUNT(DISTINCT CASE WHEN outcome = 'won' THEN puzzle_id END) AS solved,
         AVG(CASE WHEN outcome = 'won' THEN duration_ms END)      AS avgDurationMs
       FROM attempts WHERE user_id = ? AND outcome <> 'in_progress'`
    ).get(userId);

    // Average moves-over-best-known across winning runs (efficiency signal).
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

  /* --- the catalogue for the landing page ----------------------------------- */

  // Every puzzle with its metadata, difficulty signals and the caller's best.
  // Pinned puzzles come first (in admin order); the client can re-sort the rest
  // by any difficulty metric. One pass, no N+1: stats are joined in aggregate.
  listPuzzles(userId) {
    const rows = this.db.prepare(
      `SELECT
         p.id, p.name, p.seed, p.num_cubes, p.scramble, p.par, p.optimal,
         p.pinned, p.sort_order, p.full_optimal, p.beam_moves, p.min_beam_width, p.color_beams, p.solved_at,
         (SELECT MIN(moves_used) FROM attempts a
            WHERE a.puzzle_id = p.id AND a.outcome = 'won') AS world_best,
         (SELECT COUNT(DISTINCT user_id) FROM attempts a
            WHERE a.puzzle_id = p.id AND a.outcome = 'won') AS solvers,
         (SELECT COUNT(*) FROM attempts a
            WHERE a.puzzle_id = p.id AND a.outcome <> 'in_progress') AS attempts,
         (SELECT SUM(CASE WHEN a.outcome = 'won' THEN 1 ELSE 0 END) FROM attempts a
            WHERE a.puzzle_id = p.id AND a.outcome <> 'in_progress') AS win_attempts,
         (SELECT AVG(CASE WHEN a.outcome = 'won' THEN moves_used END) FROM attempts a
            WHERE a.puzzle_id = p.id) AS avg_moves
       FROM puzzles p
       ORDER BY p.pinned DESC, p.sort_order ASC, p.id ASC`
    ).all();

    const bestStmt = userId
      ? this.db.prepare("SELECT MIN(moves_used) AS best FROM attempts WHERE user_id = ? AND puzzle_id = ? AND outcome = 'won'")
      : null;

    return rows.map((r) => {
      const attempts = r.attempts || 0;
      const winRate = attempts ? (r.win_attempts || 0) / attempts : 0;
      const yourBest = bestStmt ? (bestStmt.get(userId, r.id).best ?? null) : null;
      return {
        id: r.id,
        name: r.name,
        seed: r.seed,
        numCubes: r.num_cubes,
        scramble: r.scramble,
        par: r.par,
        optimal: r.optimal,
        pinned: r.pinned === 1,
        sortOrder: r.sort_order,
        yourBest,
        worldBest: r.world_best ?? null,
        solvers: r.solvers || 0,
        attempts,
        winRate,
        failRate: attempts ? 1 - winRate : 0,
        avgMoves: r.avg_moves ?? null,
        // Solver difficulty signals — populated by the admin-triggered solver run
        // (db.solvePuzzle). solvedAt is null until the solver has been run.
        fullOptimal: r.full_optimal ?? null,
        beamMoves: r.beam_moves ?? null,
        minBeamWidth: r.min_beam_width ?? null,
        colorBeams: r.color_beams ? JSON.parse(r.color_beams) : null,
        solvedAt: r.solved_at ?? null,
      };
    });
  }
}
