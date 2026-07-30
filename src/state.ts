import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { NAMES, PERSONALITIES } from './personality.js';
import { OBSERVATION_KINDS, PERSONALITY_IDS } from './types.js';
import type { BuddyState, ObservationKind, PersonalityId } from './types.js';

/**
 * BUDDY_HOME lets tests (and curious users) point at a throwaway buddy.
 * Deliberately not `~/.buddy` — that belongs to @fiorastudio/buddy.
 */
export function stateDir(): string {
  return process.env.BUDDY_HOME || join(homedir(), '.buddy-mcp');
}

export function statePath(): string {
  return join(stateDir(), 'state.json');
}

export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyKindCounts(): Record<ObservationKind, number> {
  return Object.fromEntries(OBSERVATION_KINDS.map((k) => [k, 0])) as Record<ObservationKind, number>;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Rolls a brand-new buddy. Personality is fixed for life — that's the point. */
export function hatch(now: Date): BuddyState {
  const personality = pick(PERSONALITY_IDS) as PersonalityId;
  return {
    version: 1,
    name: pick(NAMES),
    personality,
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
    kindCounts: emptyKindCounts(),
    milestones: [{ at: now.toISOString(), text: 'Hatched.' }],
    lastReaction: '',
  };
}

/**
 * Fills in anything a hand-edited or older state file is missing, so a bad
 * field can't crash the server on every call.
 */
function coerce(raw: unknown, now: Date): BuddyState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);

  const personality = PERSONALITY_IDS.includes(o.personality as PersonalityId)
    ? (o.personality as PersonalityId)
    : pick(PERSONALITY_IDS);

  const counts = emptyKindCounts();
  if (o.kindCounts && typeof o.kindCounts === 'object') {
    for (const k of OBSERVATION_KINDS) {
      counts[k] = num((o.kindCounts as Record<string, unknown>)[k], 0);
    }
  }

  return {
    version: 1,
    name: str(o.name, pick(NAMES)),
    personality,
    bornAt: str(o.bornAt, now.toISOString()),
    level: Math.max(1, Math.floor(num(o.level, 1))),
    xp: Math.max(0, num(o.xp, 0)),
    totalXp: Math.max(0, num(o.totalXp, 0)),
    energy: Math.min(100, Math.max(0, num(o.energy, 100))),
    streak: Math.max(0, Math.floor(num(o.streak, 1))),
    longestStreak: Math.max(0, Math.floor(num(o.longestStreak, 1))),
    lastSeenAt: str(o.lastSeenAt, now.toISOString()),
    lastSeenDay: str(o.lastSeenDay, localDay(now)),
    lastObservedDay: typeof o.lastObservedDay === 'string' ? o.lastObservedDay : '',
    observations: Math.max(0, Math.floor(num(o.observations, 0))),
    kindCounts: counts,
    milestones: Array.isArray(o.milestones)
      ? (o.milestones as BuddyState['milestones'])
          .filter((m) => m && typeof m.text === 'string')
          .slice(-40)
      : [],
    lastReaction: str(o.lastReaction, ''),
  };
}

export interface LoadResult {
  state: BuddyState;
  /** True on the very first load, so the caller can show the hatch message. */
  hatched: boolean;
}

export function load(now: Date): LoadResult {
  const file = statePath();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const state = hatch(now);
      save(state);
      return { state, hatched: true };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const state = coerce(parsed, now);
  if (!state) {
    // Don't silently destroy whatever was there — park it and start fresh.
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    const fresh = hatch(now);
    save(fresh);
    return { state: fresh, hatched: true };
  }

  return { state, hatched: false };
}

/** Atomic write: a killed process can't leave a half-written buddy behind. */
export function save(state: BuddyState): void {
  const file = statePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export { PERSONALITIES };
