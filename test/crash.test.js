import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * The crash journal only earns its place if it survives the conditions it
 * records under: a process mid-collapse, a torn write, a crash loop. So these
 * tests exercise the failure modes rather than the happy append.
 */

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-crash-'));
  process.env.BUDDY_HOME = home;
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.BUDDY_CRASH_LOG;
});

const { crashLogPath, recentCrashes, recordCrash } = await import('../dist/crash.js');

const now = new Date('2026-08-10T12:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);

/** Point the module at a fresh journal so each test starts empty. */
function journal(lines) {
  const path = join(home, `crashes-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.BUDDY_CRASH_LOG = path;
  if (lines) writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return path;
}

beforeEach(() => journal());

describe('crash journal', () => {
  it('says nothing when there is no journal', () => {
    // Distinct from "zero crashes": the buddy has not earned a clean bill of
    // health, it just has no evidence either way.
    assert.equal(recentCrashes(now), null);
  });

  it('records a crash and reads it back', () => {
    recordCrash('uncaught', new Error('boom'), '2.3.1', daysAgo(1));

    const summary = recentCrashes(now);
    assert.equal(summary.count, 1);
    assert.equal(summary.lastPhase, 'uncaught');
    assert.equal(summary.last.slice(0, 10), '2026-08-09');

    const written = JSON.parse(readFileSync(crashLogPath(), 'utf8').trim());
    assert.equal(written.message, 'boom');
    assert.equal(written.version, '2.3.1');
    assert.equal(written.pid, process.pid);
    assert.match(written.stack, /boom/);
  });

  it('reports the most recent phase, not the first', () => {
    recordCrash('startup', new Error('a'), '2.3.1', daysAgo(3));
    recordCrash('unhandled-rejection', new Error('b'), '2.3.1', daysAgo(1));

    const summary = recentCrashes(now);
    assert.equal(summary.count, 2);
    assert.equal(summary.lastPhase, 'unhandled-rejection');
  });

  it('drops crashes older than the window', () => {
    recordCrash('uncaught', new Error('ancient'), '2.3.1', daysAgo(31));
    assert.equal(recentCrashes(now, 30), null);

    recordCrash('uncaught', new Error('recent'), '2.3.1', daysAgo(2));
    assert.equal(recentCrashes(now, 30).count, 1);
  });

  it('survives a torn line from a crash mid-append', () => {
    // Exactly what a process killed between write() and the newline leaves.
    journal([JSON.stringify({ at: daysAgo(1).toISOString(), phase: 'uncaught', version: '2.3.1', pid: 1, message: 'ok' }), '{"at":"2026-08-']);

    const summary = recentCrashes(now);
    assert.equal(summary.count, 1);
    assert.equal(summary.message, undefined); // summary carries no message by design
  });

  it('bounds the journal so a crash loop cannot fill the disk', () => {
    for (let i = 0; i < 400; i++) {
      recordCrash('uncaught', new Error(`crash ${i} ${'x'.repeat(200)}`), '2.3.1', daysAgo(1));
    }

    // The bound is on bytes: trimming is size-triggered, so the line count
    // oscillates above KEEP between trims. 400 unbounded entries would be far
    // past this — the point is that it converges instead of growing.
    const raw = readFileSync(crashLogPath(), 'utf8');
    assert.ok(raw.length < 128 * 1024, `journal grew to ${raw.length} bytes`);

    // Trimming keeps the newest, which is the one worth having.
    const lines = raw.split('\n').filter(Boolean);
    assert.match(JSON.parse(lines.at(-1)).message, /crash 399/);
  });

  it('creates the state directory a startup crash may beat getDb() to', () => {
    process.env.BUDDY_CRASH_LOG = join(home, 'not', 'yet', 'crashes.jsonl');
    recordCrash('startup', new Error('died before opening the db'), '2.3.1', daysAgo(1));

    assert.equal(recentCrashes(now).count, 1);
  });

  it('never throws when the journal cannot be written', () => {
    // A crash handler that throws replaces a recorded crash with an unrecorded
    // one, so an unwritable path must degrade to silence. A parent that is a
    // regular file defeats the mkdir too, which a missing directory no longer
    // does.
    const blocker = join(home, 'a-file');
    writeFileSync(blocker, 'not a directory');
    process.env.BUDDY_CRASH_LOG = join(blocker, 'crashes.jsonl');

    assert.doesNotThrow(() => recordCrash('uncaught', new Error('boom'), '2.3.1', now));
    assert.equal(recentCrashes(now), null);
  });

  it('records a non-Error throw', () => {
    recordCrash('uncaught', 'just a string', '2.3.1', daysAgo(1));
    const written = JSON.parse(readFileSync(crashLogPath(), 'utf8').trim());
    assert.equal(written.message, 'just a string');
    assert.equal(written.stack, undefined);
  });
});

describe('crash handlers, in a real process', () => {
  /**
   * The unit tests above prove the journal works when called. This proves it
   * gets called — that the handler is actually installed on the process and
   * fires on the two events Node treats as fatal. Nothing short of a real
   * process death tests that.
   */
  const run = (body) => {
    const path = join(home, `live-${Math.random().toString(36).slice(2)}.jsonl`);
    const dist = join(import.meta.dirname, '..', 'dist', 'crash.js');
    let code = 0;
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { installCrashHandlers } = await import(${JSON.stringify(dist)});
        installCrashHandlers('9.9.9');
        ${body}
      `], { env: { ...process.env, BUDDY_CRASH_LOG: path }, stdio: 'pipe' });
    } catch (err) {
      code = err.status;
    }
    return { code, path };
  };

  it('captures an uncaught exception and still exits non-zero', () => {
    const { code, path } = run(`setTimeout(() => { throw new Error('thrown late'); }, 0);`);

    assert.equal(code, 1);
    const written = JSON.parse(readFileSync(path, 'utf8').trim());
    assert.equal(written.phase, 'uncaught');
    assert.equal(written.version, '9.9.9');
    assert.equal(written.message, 'thrown late');
  });

  it('captures an unhandled rejection', () => {
    const { code, path } = run(`Promise.reject(new Error('nobody caught me'));`);

    assert.equal(code, 1);
    const written = JSON.parse(readFileSync(path, 'utf8').trim());
    assert.equal(written.phase, 'unhandled-rejection');
    assert.equal(written.message, 'nobody caught me');
  });
});
