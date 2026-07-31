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

const SCHEMA_VERSION = 4;

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

function migrate(db: DatabaseSync): void {
  const from = userVersion(db);
  if (from >= SCHEMA_VERSION) return;

  if (from < 1) migrateV1(db);
  if (from < 2) migrateV2(db);
  if (from < 3) migrateV3(db);
  if (from < 4) migrateV4(db);

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
