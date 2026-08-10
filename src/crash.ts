import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { stateDir } from './db.js';

/**
 * A durable trace of the buddy dying.
 *
 * Until this existed the only record of a crash was whatever Node printed on
 * stderr, which the MCP client files under its own per-project log directory —
 * a path nobody knows without being told, keyed by a mangled cwd, rotated per
 * session. So a buddy that vanished mid-session left no evidence anywhere the
 * buddy itself could reach, and the next session started clean with no way to
 * tell "quiet" from "died".
 *
 * What this deliberately does NOT do is write to SQLite. The database is the
 * most likely thing to be the cause — a locked file, a half-applied migration,
 * a corrupt page — and taking a write lock while unwinding from an uncaught
 * exception is exactly when it is least likely to succeed. Worse, `withBuddy`
 * blocks on a 5s busy_timeout, so a crash handler that touched it could turn a
 * fast crash into a five-second hang before the same crash. A flat file append
 * needs no lock, no schema and no prior state.
 *
 * The limit worth naming: this can only record failures that happen after Node
 * has loaded this module. A launcher that dies first — npx failing to resolve
 * the package, a missing binary, an engines check refusing the Node version —
 * produces nothing here, because nothing here ever ran. Those live only in the
 * client's MCP log. An empty crash journal means "no crash we could see", not
 * "no failure".
 */

/** Overridable so tests need no home directory. */
export function crashLogPath(): string {
  return process.env.BUDDY_CRASH_LOG || join(stateDir(), 'crashes.jsonl');
}

/** Where the failure happened, which is most of the diagnosis. */
export type CrashPhase =
  /** Threw before the transport was connected — the server never served. */
  | 'startup'
  /** Synchronous throw nothing caught. Process state is unknown after this. */
  | 'uncaught'
  /** A promise rejected with no handler. Node treats this as fatal too. */
  | 'unhandled-rejection';

export interface CrashReport {
  at: string;
  phase: CrashPhase;
  version: string;
  pid: number;
  message: string;
  stack?: string;
}

export interface CrashSummary {
  /** Crashes recorded inside the window. */
  count: number;
  /** ISO timestamp of the most recent one. */
  last: string;
  /** Phase of the most recent one. */
  lastPhase: CrashPhase;
  /** Size of the window in days. */
  window: number;
}

/**
 * Keep the journal small enough that a crash loop cannot fill a disk, and cheap
 * enough that the common case is one append and a stat — no parse, no rewrite.
 *
 * The guarantee is on bytes, not on lines. Trimming is triggered by size and
 * drops to the newest KEEP entries, so between two trims the file grows back
 * past KEEP lines; what it cannot do is exceed MAX_BYTES by more than the one
 * entry that tripped the check. Bounding lines exactly would mean reading and
 * rewriting the file on every crash, which is the wrong trade in the one code
 * path that runs while the process is already dying.
 */
const MAX_BYTES = 64 * 1024;
const KEEP = 50;

function trim(path: string): void {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= KEEP) return;
  writeFileSync(path, `${lines.slice(-KEEP).join('\n')}\n`);
}

/**
 * Appends one crash. Never throws: this runs from an `uncaughtException`
 * handler, where a second throw is unrecoverable and would replace a recorded
 * crash with an unrecorded one.
 */
export function recordCrash(phase: CrashPhase, err: unknown, version: string, now = new Date()): void {
  try {
    const error = err instanceof Error ? err : undefined;
    const report: CrashReport = {
      at: now.toISOString(),
      phase,
      version,
      pid: process.pid,
      message: error ? error.message : String(err),
      ...(error?.stack ? { stack: error.stack } : {}),
    };

    const path = crashLogPath();
    // The state directory is normally created by getDb(), but a 'startup' crash
    // can land before anything has opened the database — which on a first run
    // is exactly the crash with no directory to be recorded in.
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(report)}\n`);

    try {
      if (statSync(path).size > MAX_BYTES) trim(path);
    } catch {
      /* an untrimmed journal is better than a lost crash */
    }
  } catch {
    /* nothing left to try; the stderr write in the caller is the fallback */
  }
}

/**
 * Reads back the recent crashes. Returns null when there is nothing to say —
 * no journal, unreadable, or none inside the window — so the caller renders
 * nothing rather than a reassuring "0 crashes" it has not earned.
 */
export function recentCrashes(now = new Date(), window = 30): CrashSummary | null {
  let raw: string;
  try {
    raw = readFileSync(crashLogPath(), 'utf8');
  } catch {
    return null; // never crashed, or never ran
  }

  const cutoff = now.getTime() - window * 86_400_000;
  const recent: CrashReport[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: CrashReport;
    try {
      parsed = JSON.parse(line) as CrashReport;
    } catch {
      continue; // a torn line from a crash mid-append is not worth failing over
    }
    const at = Date.parse(parsed.at);
    if (Number.isNaN(at) || at < cutoff) continue;
    recent.push(parsed);
  }

  if (recent.length === 0) return null;

  const last = recent.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a));
  return { count: recent.length, last: last.at, lastPhase: last.phase, window };
}

/**
 * Installs the process-level handlers.
 *
 * Both paths still exit non-zero, which is what Node already did — this changes
 * what a crash *leaves behind*, not whether the buddy survives one. Staying up
 * after an uncaught throw would mean serving from state nothing has verified,
 * and a companion that quietly lies about your XP is worse than one that dies
 * loudly enough to notice.
 */
export function installCrashHandlers(version: string): void {
  const die = (phase: CrashPhase) => (err: unknown) => {
    recordCrash(phase, err, version);
    process.stderr.write(
      `buddy-mcp ${version} ${phase}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  };

  process.on('uncaughtException', die('uncaught'));
  process.on('unhandledRejection', die('unhandled-rejection'));
}
