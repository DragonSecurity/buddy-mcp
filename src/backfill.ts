import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getDb } from './db.js';
import { classify } from './engine.js';

/**
 * Recovers the real task descriptions for imported history.
 *
 * A companion imported from @fiorastudio/buddy arrives with every event typed
 * as a generic "observe", so the entire history carries no behavioural signal.
 * The descriptions were never lost though — they were passed as tool arguments
 * and are sitting in Claude Code's own transcripts. Matching the two by
 * timestamp restores what kind of work each event actually was.
 *
 * Only the label is restored. XP is left exactly as awarded: the buddy's
 * lifetime total already reflects it, and re-scoring history would desync
 * events from the total for no gain.
 */

export const TRANSCRIPT_ROOT = join(homedir(), '.claude', 'projects');

/** How far apart a transcript entry and a stored event may be and still match. */
export const DEFAULT_TOLERANCE_MS = 120_000;

/** Largest transcript this will read whole. Well above any real session. */
export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

export interface TranscriptObservation {
  at: number;
  summary: string;
}

export function readTranscriptObservations(root: string = TRANSCRIPT_ROOT): TranscriptObservation[] {
  const out: TranscriptObservation[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;

      let text: string;
      try {
        // Whole-file read, so an outsized transcript would be held in memory in
        // full. Nothing useful lives past this bound; skipping beats an OOM.
        if (statSync(p).size > MAX_TRANSCRIPT_BYTES) continue;
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        // Cheap pre-filter: these files are large and mostly irrelevant.
        if (!line.includes('buddy_observe')) continue;

        let entryJson: {
          timestamp?: string;
          message?: { content?: { type?: string; name?: string; input?: { summary?: string } }[] };
        };
        try {
          entryJson = JSON.parse(line);
        } catch {
          continue;
        }
        const at = Date.parse(entryJson.timestamp ?? '');
        if (!Number.isFinite(at)) continue;

        for (const block of entryJson.message?.content ?? []) {
          if (block.type !== 'tool_use') continue;
          if (!/buddy_observe/.test(block.name ?? '')) continue;
          const summary = block.input?.summary;
          if (typeof summary === 'string' && summary.trim()) {
            out.push({ at, summary: summary.trim() });
          }
        }
      }
    }
  };

  walk(root);
  out.sort((a, b) => a.at - b.at);
  return out;
}

export interface BackfillResult {
  transcriptObservations: number;
  candidateEvents: number;
  matched: number;
  updated: number;
  unmatched: number;
  /** Events left generic because no transcript survives for them. */
  stillGeneric: number;
  kinds: Record<string, number>;
  dryRun: boolean;
}

export interface BackfillOptions {
  root?: string;
  toleranceMs?: number;
  dryRun?: boolean;
}

export function backfillFromTranscripts(opts: BackfillOptions = {}): BackfillResult {
  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const dryRun = opts.dryRun ?? false;
  const db = getDb();

  const observations = readTranscriptObservations(opts.root);

  // Only ever touch events still carrying the placeholder summary, which makes
  // this safe to re-run and impossible to apply to real recorded work.
  const events = db
    .prepare("SELECT id, at FROM events WHERE summary LIKE 'imported:%' ORDER BY at")
    .all() as unknown as { id: number; at: number }[];

  const taken = new Set<number>();
  const updates: { id: number; kind: string; summary: string }[] = [];

  for (const obs of observations) {
    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < events.length; i++) {
      if (taken.has(i)) continue;
      const delta = Math.abs(events[i]!.at - obs.at);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
      // Events are sorted; once we are past the observation by more than the
      // tolerance, nothing later can be closer.
      if (events[i]!.at - obs.at > tolerance && bestDelta <= tolerance) break;
    }
    if (bestIndex === -1 || bestDelta > tolerance) continue;

    taken.add(bestIndex);
    updates.push({
      id: events[bestIndex]!.id,
      kind: classify(obs.summary),
      summary: obs.summary.slice(0, 500),
    });
  }

  const kinds: Record<string, number> = {};
  for (const u of updates) kinds[u.kind] = (kinds[u.kind] ?? 0) + 1;

  let updated = 0;
  if (!dryRun && updates.length > 0) {
    const stmt = db.prepare('UPDATE events SET kind = ?, summary = ? WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const u of updates) {
        stmt.run(u.kind, u.summary, u.id);
        updated++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    transcriptObservations: observations.length,
    candidateEvents: events.length,
    matched: updates.length,
    updated: dryRun ? 0 : updated,
    unmatched: observations.length - updates.length,
    stillGeneric: events.length - updates.length,
    kinds,
    dryRun,
  };
}
