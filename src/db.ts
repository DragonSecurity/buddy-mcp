import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * BUDDY_HOME lets tests (and curious users) point at a throwaway buddy.
 * Deliberately not `~/.buddy` — that belongs to @fiorastudio/buddy.
 */
export function stateDir(): string {
  return process.env.BUDDY_HOME || join(homedir(), '.buddy-mcp');
}

export function dbPath(): string {
  return join(stateDir(), 'buddy.db');
}

const SCHEMA_VERSION = 6;

let handle: DatabaseSync | null = null;
let handlePath = '';

/**
 * Node's built-in SQLite — no native compilation, so a Node major upgrade can
 * never leave this unloadable the way an ABI-compiled driver would.
 */
export function getDb(): DatabaseSync {
  const path = dbPath();
  if (handle && handlePath === path) return handle;
  if (handle) handle.close();

  mkdirSync(stateDir(), { recursive: true });
  handle = new DatabaseSync(path);
  handlePath = path;

  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA foreign_keys = ON');
  migrate(handle);
  return handle;
}

/** Test hook: drop the cached handle so a new BUDDY_HOME takes effect. */
export function closeDb(): void {
  if (handle) handle.close();
  handle = null;
  handlePath = '';
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * All steps run inside one transaction. SQLite DDL is transactional, so a
 * crash mid-migration rolls back rather than leaving a half-applied schema —
 * which previously could not be re-applied (migrateV3 rebuilds a table, so a
 * second attempt hit "table skills_v3 already exists"), and a throw here makes
 * load() quarantine the database and hatch a replacement buddy.
 */
function migrate(db: DatabaseSync): void {
  const from = userVersion(db);
  if (from >= SCHEMA_VERSION) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (from < 1) migrateV1(db);
    if (from < 2) migrateV2(db);
    if (from < 3) migrateV3(db);
    if (from < 4) migrateV4(db);
    if (from < 5) migrateV5(db);
    if (from < 6) migrateV6(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing to roll back */
    }
    throw err;
  }
}

function migrateV1(db: DatabaseSync): void {
  db.exec(`
    -- Single-row table; the CHECK makes a second buddy unrepresentable rather
    -- than merely unreachable.
    CREATE TABLE IF NOT EXISTS buddy (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      name              TEXT    NOT NULL,
      personality       TEXT    NOT NULL,
      born_at           INTEGER NOT NULL,
      level             INTEGER NOT NULL DEFAULT 1,
      xp                INTEGER NOT NULL DEFAULT 0,
      total_xp          INTEGER NOT NULL DEFAULT 0,
      energy            REAL    NOT NULL DEFAULT 100,
      streak            INTEGER NOT NULL DEFAULT 1,
      longest_streak    INTEGER NOT NULL DEFAULT 1,
      last_seen_at      INTEGER NOT NULL,
      last_seen_day     TEXT    NOT NULL,
      last_observed_day TEXT    NOT NULL DEFAULT '',
      last_reaction     TEXT    NOT NULL DEFAULT '',
      imported_from     TEXT
    );

    -- Times are epoch milliseconds throughout. SQLite's CURRENT_TIMESTAMP is a
    -- zone-less UTC string that JS parses as local time; integers dodge that.
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      kind    TEXT    NOT NULL,
      xp      INTEGER NOT NULL DEFAULT 0,
      summary TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS events_at ON events (at);

    CREATE TABLE IF NOT EXISTS milestones (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      at   INTEGER NOT NULL,
      text TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      name         TEXT    PRIMARY KEY,
      source       TEXT    NOT NULL,
      description  TEXT    NOT NULL DEFAULT '',
      first_seen   INTEGER NOT NULL,
      uses         INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS skill_uses (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      skill TEXT    NOT NULL,
      at    INTEGER NOT NULL,
      kind  TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS skill_uses_skill ON skill_uses (skill);

    -- Suggestions the buddy has already made, so it stops nagging about a
    -- skill the user has visibly declined to adopt.
    CREATE TABLE IF NOT EXISTS nudges (
      skill TEXT    PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      at    INTEGER NOT NULL
    );
  `);
}

/**
 * `bio` carries a rescued buddy's original free-text personality description —
 * the one thing a five-personality system can't reconstruct.
 */
function migrateV2(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(buddy)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'bio')) {
    db.exec(`ALTER TABLE buddy ADD COLUMN bio TEXT NOT NULL DEFAULT ''`);
  }
}

/**
 * Scopes project-local skills to the project they were found in.
 *
 * Plugin and personal skills are genuinely global and keep project_root = ''.
 * A skill from ./.claude/skills belongs to one repo only — without this it
 * would be listed, suggested and advised in every other repo too.
 *
 * The key becomes (name, project_root) so two repos can each define a skill of
 * the same name without one silently shadowing the other. Requires a table
 * rebuild; `uses` and `last_used_at` are the only real data here and are
 * carried across, with existing rows treated as global.
 */
function migrateV3(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(skills)').all() as { name: string }[];
  if (columns.some((c) => c.name === 'project_root')) return;

  db.exec(`
    DROP TABLE IF EXISTS skills_v3;

    CREATE TABLE skills_v3 (
      name         TEXT    NOT NULL,
      project_root TEXT    NOT NULL DEFAULT '',
      source       TEXT    NOT NULL,
      description  TEXT    NOT NULL DEFAULT '',
      first_seen   INTEGER NOT NULL,
      uses         INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      PRIMARY KEY (name, project_root)
    );

    INSERT INTO skills_v3 (name, project_root, source, description, first_seen, uses, last_used_at)
      SELECT name, '', source, description, first_seen, uses, last_used_at FROM skills;

    DROP TABLE skills;
    ALTER TABLE skills_v3 RENAME TO skills;
  `);
}

/**
 * Marks whether a skill is still on disk and invokable.
 *
 * Discovery only ever upserted, so a skill that was uninstalled — or that
 * turned out never to have been installed — stayed in the registry forever and
 * kept being recommended. Flagging rather than deleting keeps usage counters
 * intact across an uninstall/reinstall cycle.
 */
function migrateV4(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(skills)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'available')) {
    db.exec('ALTER TABLE skills ADD COLUMN available INTEGER NOT NULL DEFAULT 1');
  }
}

/**
 * Records that the buddy was running on a given day, separately from whether
 * any work was recorded.
 *
 * Without this, a stretch of silence is ambiguous: it could mean the user was
 * away, or it could mean the server was broken. That ambiguity is not
 * theoretical — this buddy's predecessor was unloadable for 20 days after a
 * Node upgrade while the user was at peak activity. Any rhythm measurement
 * that reads that hole as absence draws exactly the wrong conclusion, so days
 * with no heartbeat must be treated as UNKNOWN rather than scored.
 *
 * Existing history is backfilled: a day that recorded an observation self
 * evidently had a working buddy.
 */
/**
 * Reprices imported history at this engine's rates.
 *
 * A rescued companion arrives with its previous host's XP values attached to
 * every event. Those numbers meant something there and nothing here — this
 * buddy's lifetime total was a blend of two economies, averaging 7.5 XP against
 * an engine whose cheapest observation kind pays 14. The level was carried
 * across verbatim at import, so it floated free of the XP entirely: a level 14
 * buddy holding less earned XP than level 9 requires.
 *
 * Imported events are identifiable by timestamp. They keep their original dates,
 * which necessarily precede the import itself, so anything older than the import
 * milestone came from elsewhere. The transcript backfill already recovered the
 * real `kind` for those it could match, and `kind` is what pricing needs.
 *
 * Every constant here is frozen deliberately. A migration describes the data at
 * one moment; referencing the live curve or the live BASE_XP would mean this
 * step produced different results depending on when it ran, which is the one
 * thing a migration must never do.
 */
function migrateV6(db: DatabaseSync): void {
  const BASE_XP: Record<string, number> = {
    deploy: 30, feature: 26, bugfix: 24, test: 22,
    refactor: 20, other: 18, docs: 16, config: 14,
  };
  const xpForLevel = (level: number) => 100 + 150 * Math.max(0, level - 1);
  const cumulativeTo = (level: number) => {
    let total = 0;
    for (let l = 1; l < level; l++) total += xpForLevel(l);
    return total;
  };

  const imported = db
    .prepare(
      `SELECT at FROM milestones
        WHERE text LIKE 'Rescued%' OR text LIKE 'Imported%'
        ORDER BY at DESC LIMIT 1`,
    )
    .get() as { at: number } | undefined;
  // Nothing was ever imported, so every event was priced by this engine already.
  if (!imported) return;

  const before = db
    .prepare("SELECT count(*) n, coalesce(sum(xp), 0) total FROM events WHERE kind != 'milestone'")
    .get() as { n: number; total: number };

  const reprice = db.prepare("UPDATE events SET xp = ? WHERE at < ? AND kind = ?");
  for (const [kind, xp] of Object.entries(BASE_XP)) reprice.run(xp, imported.at, kind);

  const after = db
    .prepare("SELECT coalesce(sum(xp), 0) total FROM events WHERE kind != 'milestone'")
    .get() as { total: number };
  if (after.total === before.total) return;

  const buddy = db.prepare('SELECT level FROM buddy WHERE id = 1').get() as
    | { level: number }
    | undefined;
  if (!buddy) return;

  // Levels may be owed once the history is worth what it should be. They are
  // never taken back: the level was granted at import and removing it would
  // punish the user for a correction they did not ask for and cannot see.
  let level = Math.max(1, Math.floor(buddy.level));
  while (after.total >= cumulativeTo(level + 1)) level++;
  const progress = Math.max(0, Math.min(after.total - cumulativeTo(level), xpForLevel(level) - 1));

  db.prepare('UPDATE buddy SET total_xp = ?, xp = ?, level = ? WHERE id = 1').run(
    after.total,
    progress,
    level,
  );
  db.prepare('INSERT INTO milestones (at, text) VALUES (?, ?)').run(
    Date.now(),
    `History repriced at the current economy: ${before.total} → ${after.total} xp across ${before.n} events.`,
  );
}

function migrateV5(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      day      TEXT    PRIMARY KEY,
      first_at INTEGER NOT NULL,
      last_at  INTEGER NOT NULL,
      beats    INTEGER NOT NULL DEFAULT 1,
      source   TEXT    NOT NULL DEFAULT 'live'
    );

    INSERT OR IGNORE INTO heartbeats (day, first_at, last_at, beats, source)
      SELECT date(at / 1000, 'unixepoch', 'localtime'),
             min(at), max(at), count(*), 'backfill'
        FROM events
       GROUP BY 1;
  `);
}
