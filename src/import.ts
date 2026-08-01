import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getDb } from './db.js';
import { localDay, save } from './state.js';
import { PERSONALITY_IDS } from './types.js';
import type { BuddyState, ObservationKind, PersonalityId } from './types.js';

export const FIORA_DB = join(homedir(), '.buddy', 'buddy.db');
export const CLAUDE_JSON = join(homedir(), '.claude.json');

/**
 * Identity fields render verbatim on every status card, so they are bounded
 * where they enter rather than where they are drawn. `buddy_rename` already
 * enforces 32 through zod; these import paths were the way around it.
 */
export const MAX_NAME = 32;
export const MAX_BIO = 500;

export function clampName(value: unknown, fallback: string): string {
  const s = String(value ?? '').trim().slice(0, MAX_NAME);
  return s || fallback;
}

export function clampBio(value: unknown): string {
  return String(value ?? '').slice(0, MAX_BIO);
}

/**
 * Runs a destructive rewrite as one unit.
 *
 * These paths delete the buddy, its events and its milestones before writing
 * the replacement. Outside a transaction, a throw between the deletes and the
 * write leaves nothing at all — and unlike a corrupt database, which `load()`
 * quarantines by renaming, there would be nothing left to quarantine. Carrying
 * a companion's history intact is the entire point of this file.
 */
function atomically<T>(db: ReturnType<typeof getDb>, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing to roll back */
    }
    throw err;
  }
}

export interface OriginalBuddy {
  name: string;
  bio: string;
  /** Epoch ms. Anthropic stored this directly, so it needs no parsing. */
  hatchedAt: number | null;
}

/**
 * Reads the companion Anthropic's `/buddy` left behind in ~/.claude.json.
 * The feature was removed on 2026-04-09 but the record was never deleted.
 * Key names mirror the shapes @fiorastudio/buddy's rescue path accepts.
 */
export function parseClaudeCompanion(jsonPath: string = CLAUDE_JSON): OriginalBuddy | null {
  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf8');
  } catch {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const nested = (data.companion ?? data.buddy ?? data.buddyCompanion) as
    | Record<string, unknown>
    | undefined;

  const name =
    (nested && typeof nested.name === 'string' && nested.name) ||
    (typeof data.buddyName === 'string' ? data.buddyName : '');
  if (!name) return null;

  const bio =
    (nested && typeof nested.personality === 'string' && nested.personality) ||
    (typeof data.buddyPersonality === 'string' ? data.buddyPersonality : '');

  const hatchedAt =
    nested && typeof nested.hatchedAt === 'number' && Number.isFinite(nested.hatchedAt)
      ? nested.hatchedAt
      : null;

  // Clamped at the parse boundary: ~/.claude.json is not written by this
  // process, and both fields render on every status card.
  return { name: clampName(name, name.slice(0, MAX_NAME)), bio: clampBio(bio), hatchedAt };
}

/**
 * Anthropic stored a free-text personality, not one of our five. Rather than
 * roll at random, read the description — it usually says plainly what it is.
 */
const PERSONALITY_KEYWORDS: Record<PersonalityId, RegExp> = {
  gremlin: /\b(chaos|chaotic|wreck\w*|feral|menace|frantic|gnaw\w*|mischief\w*|smug\w*|goblin|unhinged|chonk)\b/i,
  snarky: /\b(snark\w*|sarcas\w*|sardonic|judg\w*|unimpressed|dry wit|witty|cutting|deadpan)\b/i,
  zen: /\b(zen|calm|serene|still\w*|mindful|patient|balance\w*|tranquil|meditat\w*)\b/i,
  stoic: /\b(stoic|steady|quiet|unmoved|endur\w*|disciplin\w*|methodical|unflappable|reserved)\b/i,
  cheerful: /\b(cheer\w*|happy|enthusias\w*|excit\w*|sunny|delight\w*|bubbly|upbeat|eager)\b/i,
};

export function inferPersonality(bio: string): PersonalityId | null {
  if (!bio) return null;
  let best: { id: PersonalityId; hits: number } | null = null;
  for (const id of PERSONALITY_IDS) {
    const matches = bio.match(new RegExp(PERSONALITY_KEYWORDS[id], 'gi'));
    const hits = matches ? matches.length : 0;
    if (hits > 0 && (!best || hits > best.hits)) best = { id, hits };
  }
  return best ? best.id : null;
}

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

export interface RescueResult extends ImportResult {
  identitySource: string;
  eventsSource: string | null;
  personalityInferred: boolean;
}

export interface RescueOptions extends ImportOptions {
  /** ~/.claude.json — supplies name, bio and the true hatch date. */
  identityFrom?: string;
  /** A @fiorastudio/buddy database whose XP history is grafted on. */
  eventsFrom?: string | null;
}

/**
 * Restores the companion Anthropic removed, optionally grafting on the XP
 * history a later buddy accumulated. Identity (name, bio, birth date) comes
 * from ~/.claude.json; progression and events come from the SQLite database.
 */
export function rescueOriginal(opts: RescueOptions = {}): RescueResult {
  const identityPath = opts.identityFrom || CLAUDE_JSON;
  const eventsPath = opts.eventsFrom === null ? null : opts.eventsFrom || FIORA_DB;
  const target = getDb();

  const existing = target.prepare('SELECT name FROM buddy WHERE id = 1').get() as
    | { name: string }
    | undefined;
  if (existing && !opts.force) {
    throw new Error(
      `A buddy named ${existing.name} already lives here. Re-run with --force to replace it.`,
    );
  }

  const original = parseClaudeCompanion(identityPath);
  if (!original) {
    throw new Error(`No original companion found in ${identityPath}`);
  }

  const inferred = inferPersonality(original.bio);
  const personality =
    opts.personality ||
    inferred ||
    (PERSONALITY_IDS[Math.floor(Math.random() * PERSONALITY_IDS.length)] as PersonalityId);

  // Progression is optional: without an events database this is a plain rescue.
  let level = 1;
  let totalXp = 0;
  let events: { kind: ObservationKind; at: number; xp: number; type: string }[] = [];

  if (eventsPath) {
    const src = new DatabaseSync(eventsPath, { readOnly: true });
    try {
      const companion = src
        .prepare('SELECT level, xp, created_at FROM companions ORDER BY created_at ASC LIMIT 1')
        .get() as { level?: number; xp?: number } | undefined;
      if (companion) {
        level = Math.max(1, Number(companion.level ?? 1));
        totalXp = Math.max(0, Number(companion.xp ?? 0));
      }
      const rows = src
        .prepare('SELECT event_type, xp_gained, created_at FROM xp_events ORDER BY created_at ASC')
        .all() as { event_type: string; xp_gained: number; created_at: string }[];
      events = rows.map((e) => ({
        kind: KIND_MAP[e.event_type] ?? 'other',
        at: parseUtc(e.created_at, Date.now()),
        xp: Number(e.xp_gained ?? 0),
        type: e.event_type,
      }));
    } finally {
      src.close();
    }
  }

  const now = Date.now();
  const bornAt = original.hatchedAt ?? (events.length ? events[0]!.at : now);
  const lastSeenAt = events.length ? events[events.length - 1]!.at : bornAt;
  const longestStreak = longestStreakFrom(events.map((e) => e.at));

  const milestones = [
    { at: new Date(bornAt).toISOString(), text: `Hatched as ${original.name}.` },
  ];
  if (events.length) {
    milestones.push({
      at: new Date(now).toISOString(),
      text: `Rescued with ${events.length} events of history carried over.`,
    });
  }

  const state: BuddyState = {
    version: 1,
    name: original.name,
    personality,
    bio: original.bio,
    bornAt: new Date(bornAt).toISOString(),
    level,
    xp: 0,
    totalXp,
    energy: 100,
    streak: 1,
    longestStreak: Math.max(1, longestStreak),
    lastSeenAt: new Date(lastSeenAt).toISOString(),
    lastSeenDay: localDay(new Date(lastSeenAt)),
    lastObservedDay: '',
    observations: events.length,
    kindCounts: {} as Record<ObservationKind, number>,
    milestones,
    lastReaction: '',
  };

  atomically(target, () => {
    target.exec('DELETE FROM buddy');
    target.exec('DELETE FROM events');
    target.exec('DELETE FROM milestones');
    save(state);

    const insert = target.prepare('INSERT INTO events (at, kind, xp, summary) VALUES (?, ?, ?, ?)');
    for (const e of events) insert.run(e.at, e.kind, e.xp, `imported: ${e.type}`);

    target
      .prepare('UPDATE buddy SET imported_from = ? WHERE id = 1')
      .run(eventsPath ? `${identityPath} + ${eventsPath}` : identityPath);
  });

  return {
    name: state.name,
    level: state.level,
    totalXp: state.totalXp,
    events: events.length,
    longestStreak: state.longestStreak,
    bornAt: state.bornAt,
    personality,
    bio: state.bio,
    identitySource: identityPath,
    eventsSource: eventsPath,
    personalityInferred: !opts.personality && inferred !== null,
  };
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
  // Both render verbatim on every status card, and both arrive from a database
  // this process does not own. buddy_rename already bounds the name at 32 via
  // zod; the import path was bypassing that entirely.
  const bio = clampBio(companion.personality_bio);

  // Level is carried across verbatim; `xp` is progress toward the *next* level
  // under our curve, so it resets to 0. totalXp stays the lifetime figure.
  const state: BuddyState = {
    version: 1,
    name: clampName(companion.name, 'Imported'),
    personality,
    bio,
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

  atomically(target, () => {
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
  });

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
