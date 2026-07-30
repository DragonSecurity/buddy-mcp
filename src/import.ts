import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getDb } from './db.js';
import { localDay, save } from './state.js';
import { PERSONALITY_IDS } from './types.js';
import type { BuddyState, ObservationKind, PersonalityId } from './types.js';

export const FIORA_DB = join(homedir(), '.buddy', 'buddy.db');

/** @fiorastudio/buddy event types mapped onto ours. */
const KIND_MAP: Record<string, ObservationKind> = {
  bug_fix: 'bugfix',
  deploy: 'deploy',
  commit: 'other',
  observe: 'other',
  session: 'other',
  hatch: 'other',
};

/**
 * SQLite's CURRENT_TIMESTAMP is zone-less UTC; JS would read it as local time.
 * The upstream server has this bug — don't inherit it along with the data.
 */
function parseUtc(value: string, fallback: number): number {
  if (!value) return fallback;
  const raw = String(value).trim();
  const iso = /[TZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

/** Longest run of consecutive local days that saw at least one event. */
export function longestStreakFrom(timestamps: number[]): number {
  const days = [...new Set(timestamps.map((t) => localDay(new Date(t))))].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;

  for (const day of days) {
    if (prev === null) {
      run = 1;
    } else {
      const expected = new Date(`${prev}T00:00:00`);
      expected.setDate(expected.getDate() + 1);
      run = localDay(expected) === day ? run + 1 : 1;
    }
    best = Math.max(best, run);
    prev = day;
  }
  return best;
}

export interface ImportResult {
  name: string;
  level: number;
  totalXp: number;
  events: number;
  longestStreak: number;
  bornAt: string;
  personality: PersonalityId;
  bio: string;
}

export interface ImportOptions {
  source?: string;
  personality?: PersonalityId;
  force?: boolean;
}

export function importFromFiora(opts: ImportOptions = {}): ImportResult {
  const source = opts.source || FIORA_DB;
  const target = getDb();

  const existing = target.prepare('SELECT name FROM buddy WHERE id = 1').get() as
    | { name: string }
    | undefined;
  if (existing && !opts.force) {
    throw new Error(
      `A buddy named ${existing.name} already lives here. Re-run with --force to replace it.`,
    );
  }

  const src = new DatabaseSync(source, { readOnly: true });
  let companion: Record<string, string | number> | undefined;
  let events: { event_type: string; xp_gained: number; created_at: string }[];
  try {
    companion = src
      .prepare('SELECT * FROM companions ORDER BY created_at ASC LIMIT 1')
      .get() as Record<string, string | number> | undefined;
    if (!companion) throw new Error(`No companion found in ${source}`);
    events = src
      .prepare('SELECT event_type, xp_gained, created_at FROM xp_events ORDER BY created_at ASC')
      .all() as { event_type: string; xp_gained: number; created_at: string }[];
  } finally {
    src.close();
  }

  const now = Date.now();
  const bornAt = parseUtc(String(companion.created_at ?? ''), now);
  const stamps = events.map((e) => parseUtc(e.created_at, bornAt));
  const lastSeenAt = stamps.length ? Math.max(...stamps) : bornAt;
  const longestStreak = longestStreakFrom(stamps);

  const personality =
    opts.personality || (PERSONALITY_IDS[Math.floor(Math.random() * PERSONALITY_IDS.length)] as PersonalityId);
  const bio = String(companion.personality_bio ?? '');

  // Level is carried across verbatim; `xp` is progress toward the *next* level
  // under our curve, so it resets to 0. totalXp stays the lifetime figure.
  const state: BuddyState = {
    version: 1,
    name: String(companion.name ?? 'Imported'),
    personality,
    bornAt: new Date(bornAt).toISOString(),
    level: Math.max(1, Number(companion.level ?? 1)),
    xp: 0,
    totalXp: Math.max(0, Number(companion.xp ?? 0)),
    energy: 100,
    streak: 1,
    longestStreak: Math.max(1, longestStreak),
    lastSeenAt: new Date(lastSeenAt).toISOString(),
    lastSeenDay: localDay(new Date(lastSeenAt)),
    lastObservedDay: '',
    observations: events.length,
    kindCounts: {} as Record<ObservationKind, number>,
    milestones: [
      { at: new Date(bornAt).toISOString(), text: 'Hatched.' },
      {
        at: new Date(now).toISOString(),
        text: `Imported from @fiorastudio/buddy at level ${companion.level} with ${events.length} events.`,
      },
    ],
    lastReaction: '',
  };

  target.exec('DELETE FROM buddy');
  target.exec('DELETE FROM events');
  target.exec('DELETE FROM milestones');
  save(state);

  const insert = target.prepare('INSERT INTO events (at, kind, xp, summary) VALUES (?, ?, ?, ?)');
  events.forEach((e, i) => {
    insert.run(
      stamps[i]!,
      KIND_MAP[e.event_type] ?? 'other',
      Number(e.xp_gained ?? 0),
      `imported: ${e.event_type}`,
    );
  });

  target.prepare('UPDATE buddy SET imported_from = ? WHERE id = 1').run(source);

  return {
    name: state.name,
    level: state.level,
    totalXp: state.totalXp,
    events: events.length,
    longestStreak: state.longestStreak,
    bornAt: state.bornAt,
    personality,
    bio,
  };
}
