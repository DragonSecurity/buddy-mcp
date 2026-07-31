import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

let home, transcripts;

const BASE = Date.parse('2026-07-20T10:00:00Z');

/** Writes a transcript line shaped like a real buddy_observe tool call. */
function writeTranscript(file, entries) {
  const lines = entries.map((e) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(e.at).toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'mcp__buddy__buddy_observe', input: { summary: e.summary } },
        ],
      },
    }),
  );
  // Noise lines that must be ignored.
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }));
  lines.push('not json at all');
  writeFileSync(file, lines.join('\n'), 'utf8');
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-backfill-'));
  process.env.BUDDY_HOME = home;

  transcripts = mkdtempSync(join(tmpdir(), 'transcripts-'));
  const proj = join(transcripts, '-Users-someone-project');
  mkdirSync(proj, { recursive: true });
  writeTranscript(join(proj, 'session.jsonl'), [
    { at: BASE, summary: 'Fixed the off-by-one in the pagination cursor (tests pass)' },
    { at: BASE + 3_600_000, summary: 'Deployed the worker to production' },
    { at: BASE + 7_200_000, summary: 'Added a new export endpoint' },
    // No matching event — outside the window.
    { at: BASE + 99_000_000, summary: 'Wrote unit tests for the parser' },
  ]);
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(transcripts, { recursive: true, force: true });
});

const { backfillFromTranscripts, readTranscriptObservations } = await import('../dist/backfill.js');
const { load, recordEvent } = await import('../dist/state.js');
const { getDb, closeDb } = await import('../dist/db.js');

const NOW = new Date('2026-07-31T10:00:00Z');

function seed() {
  closeDb();
  for (const s of ['', '-wal', '-shm']) rmSync(join(home, `buddy.db${s}`), { force: true });
  getDb();
  load(NOW);
  const db = getDb();
  db.exec('DELETE FROM events');

  const insert = db.prepare('INSERT INTO events (at, kind, xp, summary) VALUES (?, ?, ?, ?)');
  // Three imported events matching the transcript times (a few seconds off, as
  // server-side timestamps really are), plus one that has no transcript.
  insert.run(BASE + 4_000, 'other', 5, 'imported: observe');
  insert.run(BASE + 3_600_000 - 2_000, 'other', 5, 'imported: observe');
  insert.run(BASE + 7_200_000 + 9_000, 'other', 5, 'imported: observe');
  insert.run(BASE - 50_000_000, 'other', 5, 'imported: observe');
  // A genuine recorded observation that must never be touched.
  insert.run(BASE + 10_000_000, 'feature', 26, 'Real work recorded natively');
}

beforeEach(seed);

const opts = { root: transcripts };

describe('readTranscriptObservations', () => {
  it('extracts summaries with timestamps and ignores noise', () => {
    const obs = readTranscriptObservations(transcripts);
    assert.equal(obs.length, 4);
    assert.ok(obs.every((o) => Number.isFinite(o.at) && o.summary.length > 0));
    assert.deepEqual(
      obs.map((o) => o.at),
      [...obs.map((o) => o.at)].sort((a, b) => a - b),
      'returned in time order',
    );
  });

  it('returns nothing for a missing directory', () => {
    assert.deepEqual(readTranscriptObservations(join(transcripts, 'nope')), []);
  });
});

describe('backfillFromTranscripts', () => {
  it('dry run reports matches without writing', () => {
    const r = backfillFromTranscripts({ ...opts, dryRun: true });
    assert.equal(r.matched, 3);
    assert.equal(r.updated, 0);

    const generic = getDb()
      .prepare("SELECT count(*) c FROM events WHERE summary LIKE 'imported:%'")
      .get();
    assert.equal(generic.c, 4, 'nothing written');
  });

  it('restores real summaries and reclassifies them', () => {
    const r = backfillFromTranscripts(opts);
    assert.equal(r.updated, 3);

    const rows = getDb()
      .prepare("SELECT kind, summary FROM events WHERE summary NOT LIKE 'imported:%' ORDER BY at")
      .all();
    const byKind = Object.fromEntries(rows.map((x) => [x.kind, x.summary]));
    assert.ok(byKind.bugfix, `expected a bugfix, got ${JSON.stringify(rows)}`);
    assert.ok(byKind.deploy);
    assert.ok(byKind.feature);
    assert.match(byKind.bugfix, /off-by-one/);
  });

  it('classifies through the verification clause, not on it', () => {
    backfillFromTranscripts(opts);
    const row = getDb()
      .prepare("SELECT kind FROM events WHERE summary LIKE '%off-by-one%'")
      .get();
    assert.equal(row.kind, 'bugfix', '"(tests pass)" must not make it a test');
  });

  it('leaves XP untouched', () => {
    const before = getDb().prepare('SELECT sum(xp) s FROM events').get().s;
    backfillFromTranscripts(opts);
    const after = getDb().prepare('SELECT sum(xp) s FROM events').get().s;
    assert.equal(after, before, 'labels are recovered, history is not re-scored');
  });

  it('never touches natively recorded observations', () => {
    backfillFromTranscripts(opts);
    const row = getDb()
      .prepare("SELECT kind, summary FROM events WHERE summary = 'Real work recorded natively'")
      .get();
    assert.equal(row.kind, 'feature', 'untouched');
  });

  it('leaves events with no surviving transcript generic', () => {
    const r = backfillFromTranscripts(opts);
    assert.equal(r.stillGeneric, 1);
    const remaining = getDb()
      .prepare("SELECT count(*) c FROM events WHERE summary LIKE 'imported:%'")
      .get();
    assert.equal(remaining.c, 1);
  });

  it('is idempotent — a second run changes nothing', () => {
    const first = backfillFromTranscripts(opts);
    const second = backfillFromTranscripts(opts);
    assert.equal(first.updated, 3);
    assert.equal(second.updated, 0, 'already-restored events are no longer candidates');
  });

  it('respects the tolerance window', () => {
    const tight = backfillFromTranscripts({ ...opts, toleranceMs: 1000, dryRun: true });
    assert.equal(tight.matched, 0, 'nothing is within one second');
  });

  it('matches each event at most once', () => {
    backfillFromTranscripts(opts);
    const dupes = getDb()
      .prepare('SELECT summary, count(*) c FROM events GROUP BY summary HAVING c > 1')
      .all();
    assert.deepEqual(dupes, [], 'no event reused for two observations');
  });
});
