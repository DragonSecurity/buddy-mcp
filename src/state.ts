import { renameSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { closeDb, dbPath, getDb, stateDir } from './db.js';
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

export function load(now: Date): LoadResult {
  let db: DatabaseSync;
  try {
    db = getDb();
  } catch (err) {
    // Don't silently destroy whatever was there — park it and start fresh.
    closeDb();
    try {
      renameSync(dbPath(), `${dbPath()}.corrupt-${now.getTime()}`);
    } catch {
      throw err;
    }
    db = getDb();
  }

  const row = db.prepare('SELECT * FROM buddy WHERE id = 1').get() as BuddyRow | undefined;
  if (!row) {
    const state = hatch(now);
    save(state);
    return { state, hatched: true };
  }

  return { state: rowToState(db, row), hatched: false };
}

export function save(state: BuddyState): void {
  const db = getDb();
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
