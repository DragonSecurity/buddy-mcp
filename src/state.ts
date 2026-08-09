import { existsSync, renameSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { closeDb, dbPath, getDb, openReadOnly, stateDir } from './db.js';
import { NAMES, PERSONALITIES } from './personality.js';
import { PERSONALITY_IDS } from './types.js';
import type { BuddyState, Milestone, ObservationKind, PersonalityId } from './types.js';

export { stateDir, dbPath, closeDb };
/** Kept for callers that just want a human-facing location. */
export function statePath(): string {
  return dbPath();
}

export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Rolls a brand-new buddy. Personality is fixed for life — that's the point. */
export function hatch(now: Date): BuddyState {
  return {
    version: 1,
    name: pick(NAMES),
    personality: pick(PERSONALITY_IDS) as PersonalityId,
    bio: '',
    bornAt: now.toISOString(),
    level: 1,
    xp: 0,
    totalXp: 0,
    energy: 100,
    streak: 1,
    longestStreak: 1,
    lastSeenAt: now.toISOString(),
    lastSeenDay: localDay(now),
    lastObservedAt: now.toISOString(),
    lastObservedDay: '',
    observations: 0,
    kindCounts: {} as Record<ObservationKind, number>,
    milestones: [{ at: now.toISOString(), text: 'Hatched.' }],
    lastReaction: '',
  };
}

interface BuddyRow {
  name: string;
  personality: string;
  bio: string | null;
  born_at: number;
  level: number;
  xp: number;
  total_xp: number;
  energy: number;
  streak: number;
  longest_streak: number;
  last_seen_at: number;
  last_observed_at: number;
  last_seen_day: string;
  last_observed_day: string;
  last_reaction: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (isoStr: string, fallback: number) => {
  const t = Date.parse(isoStr);
  return Number.isFinite(t) ? t : fallback;
};

function rowToState(db: DatabaseSync, row: BuddyRow): BuddyState {
  const counts = db
    .prepare("SELECT kind, count(*) AS n FROM events WHERE kind != 'milestone' GROUP BY kind")
    .all() as { kind: string; n: number }[];
  const kindCounts = {} as Record<ObservationKind, number>;
  for (const c of counts) kindCounts[c.kind as ObservationKind] = Number(c.n);

  const observations = db
    .prepare("SELECT count(*) AS n FROM events WHERE kind != 'milestone'")
    .get() as { n: number };

  const milestones = (
    db.prepare('SELECT at, text FROM milestones ORDER BY at ASC, id ASC').all() as {
      at: number;
      text: string;
    }[]
  ).map((m) => ({ at: iso(m.at), text: m.text }));

  const personality = PERSONALITY_IDS.includes(row.personality as PersonalityId)
    ? (row.personality as PersonalityId)
    : pick(PERSONALITY_IDS);

  return {
    version: 1,
    name: row.name || pick(NAMES),
    personality,
    bio: row.bio || '',
    bornAt: iso(row.born_at),
    level: Math.max(1, Math.floor(row.level)),
    xp: Math.max(0, row.xp),
    totalXp: Math.max(0, row.total_xp),
    energy: clamp(row.energy, 0, 100),
    streak: Math.max(0, Math.floor(row.streak)),
    longestStreak: Math.max(0, Math.floor(row.longest_streak)),
    lastSeenAt: iso(row.last_seen_at),
    lastObservedAt: iso(row.last_observed_at || row.last_seen_at),
    lastSeenDay: row.last_seen_day,
    lastObservedDay: row.last_observed_day,
    observations: Number(observations?.n ?? 0),
    kindCounts,
    milestones,
    lastReaction: row.last_reaction,
  };
}

export interface LoadResult {
  state: BuddyState;
  /** True on the very first load, so the caller can show the hatch message. */
  hatched: boolean;
}

/**
 * Open the database, quarantining it first if it will not open at all.
 *
 * Separate from reading the buddy because the recovery path closes and reopens
 * the handle, which no open transaction survives — so it has to happen before
 * withBuddy() takes the write lock, never inside it.
 */
function ensureDb(now: Date): DatabaseSync {
  try {
    return getDb();
  } catch (err) {
    // Don't silently destroy whatever was there — park it and start fresh.
    closeDb();
    try {
      renameSync(dbPath(), `${dbPath()}.corrupt-${now.getTime()}`);
    } catch {
      throw err;
    }
    return getDb();
  }
}

function readState(db: DatabaseSync, now: Date): LoadResult {
  const row = db.prepare('SELECT * FROM buddy WHERE id = 1').get() as BuddyRow | undefined;
  if (!row) {
    const state = hatch(now);
    saveTo(db, state);
    return { state, hatched: true };
  }

  return { state: rowToState(db, row), hatched: false };
}

export function load(now: Date): LoadResult {
  return readState(ensureDb(now), now);
}

/**
 * Read the buddy, let the caller change it, and write it back — all under one
 * write lock.
 *
 * Every buddy server is its own process, and there is one per Claude Code
 * session, so five open sessions are five writers against the same file. save()
 * rewrites all fifteen columns of the singleton row from whatever load()
 * returned, which makes an unsynchronised read-modify-write a lost update: a
 * buddy_status that loaded before a concurrent buddy_observe committed will
 * write the pre-observation xp, level and last_observed_day back over it. The
 * XP silently reverts, and the restored last_observed_day re-arms the
 * first-of-day bonus so the next observation collects it twice.
 *
 * BEGIN IMMEDIATE takes the write lock on entry rather than on first write, so
 * the read and the write cannot be interleaved by another process. The other
 * writer blocks on busy_timeout (5s, set in db.ts) instead of racing. Anything
 * the callback writes through getDb() — recordEvent, in particular — joins this
 * transaction and commits with it, so an observation and the XP it granted can
 * no longer land separately.
 *
 * Keep the callback short and synchronous. It runs holding a lock every other
 * session needs.
 */
export function withBuddy<T>(now: Date, fn: (state: BuddyState, hatched: boolean) => T): T {
  const db = ensureDb(now);

  db.exec('BEGIN IMMEDIATE');
  try {
    const { state, hatched } = readState(db, now);
    const out = fn(state, hatched);
    saveTo(db, state);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back, or never began — the original error is the one that matters */
    }
    throw err;
  }
}

/**
 * Reads the buddy without touching it — no hatch, no migration, no write.
 *
 * `load()` is the wrong tool for an outside observer: it hatches and saves a
 * brand-new buddy when the table is empty, and `getDb()` migrates. A display
 * polling every few seconds must do neither. It must also never update
 * `lastSeenAt`, which is what `buddy_status` does — that field is what energy
 * drain and streaks are measured against, so a poller that touched it would
 * pin the buddy at "active" forever and quietly break both.
 *
 * Returns `{ state: null }` when no buddy has hatched yet, and `unreadable`
 * when the database exists but cannot be read — a corrupt file or bad
 * permissions. Those are different things and a display should be able to say
 * so: reporting "no buddy yet" for a buddy that exists but is unreachable is a
 * lie, and it points at the wrong fix.
 *
 * Never throws, never quarantines. `load()` renames a corrupt database out of
 * the way and hatches a replacement; a reader must do neither, so it reports
 * instead.
 */
export interface PeekResult {
  state: BuddyState | null;
  unreadable: boolean;
}

export function peek(): PeekResult {
  let db: DatabaseSync;
  try {
    db = openReadOnly();
  } catch (err) {
    // No file at all is "nothing to read yet"; anything else is a real fault.
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT' || !existsSync(dbPath());
    return { state: null, unreadable: !missing };
  }
  try {
    const row = db.prepare('SELECT * FROM buddy WHERE id = 1').get() as BuddyRow | undefined;
    return { state: row ? rowToState(db, row) : null, unreadable: false };
  } catch {
    return { state: null, unreadable: true };
  } finally {
    db.close();
  }
}

export function save(state: BuddyState): void {
  saveTo(getDb(), state);
}

function saveTo(db: DatabaseSync, state: BuddyState): void {
  const bornAt = ms(state.bornAt, Date.now());
  const lastSeenAt = ms(state.lastSeenAt, Date.now());

  db.prepare(
    `INSERT INTO buddy (
       id, name, personality, bio, born_at, level, xp, total_xp, energy,
       streak, longest_streak, last_seen_at, last_seen_day, last_observed_day, last_reaction
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       personality = excluded.personality,
       bio = excluded.bio,
       born_at = excluded.born_at,
       level = excluded.level,
       xp = excluded.xp,
       total_xp = excluded.total_xp,
       energy = excluded.energy,
       streak = excluded.streak,
       longest_streak = excluded.longest_streak,
       last_seen_at = excluded.last_seen_at,
       last_seen_day = excluded.last_seen_day,
       last_observed_day = excluded.last_observed_day,
       last_reaction = excluded.last_reaction`,
  ).run(
    state.name,
    state.personality,
    state.bio,
    bornAt,
    state.level,
    state.xp,
    state.totalXp,
    state.energy,
    state.streak,
    state.longestStreak,
    lastSeenAt,
    state.lastSeenDay,
    state.lastObservedDay,
    state.lastReaction,
  );

  syncMilestones(db, state.milestones);
}

/**
 * Milestones are capped and rewritten wholesale rather than appended: the
 * in-memory array is the source of truth and never exceeds a few dozen rows.
 */
function syncMilestones(db: DatabaseSync, milestones: Milestone[]): void {
  // Compared by content, not by count. Short-circuiting on COUNT(*) meant any
  // edit that preserved the number of rows — renaming one, or replacing the
  // oldest once the cap is reached — was silently never persisted.
  const existing = db.prepare('SELECT at, text FROM milestones ORDER BY at ASC, id ASC').all() as unknown as {
    at: number;
    text: string;
  }[];

  const wanted = milestones.map((m) => ({ at: ms(m.at, Date.now()), text: m.text }));
  const same =
    existing.length === wanted.length &&
    existing.every((e, i) => e.at === wanted[i]!.at && e.text === wanted[i]!.text);
  if (same) return;

  db.exec('DELETE FROM milestones');
  const insert = db.prepare('INSERT INTO milestones (at, text) VALUES (?, ?)');
  for (const m of wanted) insert.run(m.at, m.text);
}

/** Append-only history. This is what per-skill and per-kind stats are built on. */
export function recordEvent(kind: string, xp: number, summary: string, now: Date): void {
  getDb()
    .prepare('INSERT INTO events (at, kind, xp, summary) VALUES (?, ?, ?, ?)')
    .run(now.getTime(), kind, xp, summary.slice(0, 500));
}

export { PERSONALITIES };
