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

const SCHEMA_VERSION = 1;

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
  if (userVersion(db) >= SCHEMA_VERSION) return;

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

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
