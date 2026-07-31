import { getDb } from './db.js';
import { localDay } from './state.js';

/**
 * Presence tracking exists to keep one distinction honest: a day the buddy was
 * running but saw no work is IDLE, a day it never ran at all is UNKNOWN. Only
 * the first is evidence about the user. Conflating them lets an outage read as
 * weeks of neglect — or, worse, as chaotic working rhythm.
 */

/** Notes that the buddy is alive right now. Cheap enough to call per tool use. */
export function recordHeartbeat(now: Date): void {
  getDb()
    .prepare(
      `INSERT INTO heartbeats (day, first_at, last_at, beats, source)
       VALUES (?, ?, ?, 1, 'live')
       ON CONFLICT(day) DO UPDATE SET
         last_at = excluded.last_at,
         beats   = beats + 1,
         source  = 'live'`,
    )
    .run(localDay(now), now.getTime(), now.getTime());
}

export interface Presence {
  /** Days in the window the buddy is known to have been running. */
  seen: number;
  /** Of those, days that recorded at least one observation. */
  active: number;
  /** Running, but nothing recorded. Genuine quiet. */
  idle: number;
  /** Never ran. Could be downtime, holiday, or another machine — unknowable. */
  unknown: number;
  /** Size of the window in days. */
  window: number;
  /** seen / window — how much of the window we can say anything about at all. */
  coverage: number;
}

function daysBack(now: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - i);
    out.push(localDay(d));
  }
  return out;
}

export function presence(now: Date, window = 30): Presence {
  const db = getDb();
  const days = new Set(daysBack(now, window));

  const seenDays = new Set(
    (db.prepare('SELECT day FROM heartbeats').all() as unknown as { day: string }[])
      .map((r) => r.day)
      .filter((d) => days.has(d)),
  );

  const activeDays = new Set(
    (
      db
        .prepare("SELECT DISTINCT date(at / 1000, 'unixepoch', 'localtime') AS day FROM events")
        .all() as unknown as { day: string }[]
    )
      .map((r) => r.day)
      .filter((d) => days.has(d)),
  );

  // An observation implies the buddy was running, even if the heartbeat row
  // predates this feature.
  for (const d of activeDays) seenDays.add(d);

  return {
    seen: seenDays.size,
    active: activeDays.size,
    idle: seenDays.size - activeDays.size,
    unknown: window - seenDays.size,
    window,
    coverage: window > 0 ? seenDays.size / window : 0,
  };
}

/**
 * Gaps between active days, in days, excluding any gap that spans a day the
 * buddy was never running. A rhythm statistic may only use these — a gap of
 * unknown provenance says nothing about how the user works.
 */
export function knownGaps(now: Date, window = 120): number[] {
  const db = getDb();
  const days = new Set(daysBack(now, window));

  const seen = new Set(
    (db.prepare('SELECT day FROM heartbeats').all() as unknown as { day: string }[]).map((r) => r.day),
  );

  const active = (
    db
      .prepare("SELECT DISTINCT date(at / 1000, 'unixepoch', 'localtime') AS day FROM events ORDER BY 1")
      .all() as unknown as { day: string }[]
  )
    .map((r) => r.day)
    .filter((d) => days.has(d));

  const gaps: number[] = [];
  for (let i = 1; i < active.length; i++) {
    const prev = new Date(`${active[i - 1]!}T00:00:00`);
    const next = new Date(`${active[i]!}T00:00:00`);
    const span = Math.round((next.getTime() - prev.getTime()) / 86_400_000);

    // Every intervening day must be accounted for, or the gap is unusable.
    let known = true;
    for (let k = 1; k < span; k++) {
      const between = new Date(prev.getTime());
      between.setDate(between.getDate() + k);
      if (!seen.has(localDay(between))) {
        known = false;
        break;
      }
    }
    if (known) gaps.push(span);
  }
  return gaps;
}
