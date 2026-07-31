import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-presence-'));
  process.env.BUDDY_HOME = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

const { recordHeartbeat, presence, knownGaps } = await import('../dist/presence.js');
const { localDay, recordEvent, load } = await import('../dist/state.js');
const { getDb, closeDb } = await import('../dist/db.js');

const NOW = new Date('2026-07-31T12:00:00');
const dayBefore = (n) => {
  const d = new Date(NOW.getTime());
  d.setDate(d.getDate() - n);
  return d;
};

function reset() {
  closeDb();
  for (const s of ['', '-wal', '-shm']) rmSync(join(home, `buddy.db${s}`), { force: true });
  getDb();
  load(NOW);
  getDb().exec('DELETE FROM events');
  getDb().exec('DELETE FROM heartbeats');
}

beforeEach(reset);

describe('recordHeartbeat', () => {
  it('records one row per local day and counts repeats', () => {
    recordHeartbeat(NOW);
    recordHeartbeat(new Date(NOW.getTime() + 60_000));
    const row = getDb().prepare('SELECT day, beats FROM heartbeats').get();
    assert.equal(row.day, localDay(NOW));
    assert.equal(row.beats, 2);
  });

  it('separates distinct days', () => {
    recordHeartbeat(NOW);
    recordHeartbeat(dayBefore(1));
    assert.equal(getDb().prepare('SELECT count(*) c FROM heartbeats').get().c, 2);
  });
});

describe('presence', () => {
  it('is all-unknown before anything is recorded', () => {
    const p = presence(NOW, 10);
    assert.equal(p.active, 0);
    assert.equal(p.idle, 0);
    assert.equal(p.unknown, 10);
    assert.equal(p.coverage, 0);
  });

  it('distinguishes a quiet day from a day the buddy never ran', () => {
    // Ran on day 0 and day 1; worked only on day 0. Days 2-9 never ran.
    recordHeartbeat(NOW);
    recordHeartbeat(dayBefore(1));
    recordEvent('feature', 10, 'did a thing', NOW);

    const p = presence(NOW, 10);
    assert.equal(p.active, 1, 'one day recorded work');
    assert.equal(p.idle, 1, 'one day running but quiet');
    assert.equal(p.unknown, 8, 'the rest are unknowable, not idle');
    assert.equal(p.seen, 2);
  });

  it('treats an observation as proof the buddy was running', () => {
    // Event with no heartbeat row — the case for all imported history.
    recordEvent('other', 5, 'imported', dayBefore(3));
    const p = presence(NOW, 10);
    assert.equal(p.active, 1);
    assert.equal(p.seen, 1, 'inferred from the event');
    assert.equal(p.idle, 0);
  });

  it('never reports negative or out-of-window counts', () => {
    for (let i = 0; i < 40; i++) recordHeartbeat(dayBefore(i));
    const p = presence(NOW, 10);
    assert.equal(p.seen, 10, 'clamped to the window');
    assert.equal(p.unknown, 0);
    assert.ok(p.idle >= 0);
    assert.ok(p.coverage <= 1);
  });
});

describe('knownGaps', () => {
  it('measures a gap only when every day between is accounted for', () => {
    // Worked on day 5 and day 2; the buddy was running on days 4 and 3.
    recordEvent('feature', 10, 'a', dayBefore(5));
    recordEvent('feature', 10, 'b', dayBefore(2));
    for (const d of [5, 4, 3, 2]) recordHeartbeat(dayBefore(d));

    assert.deepEqual(knownGaps(NOW), [3]);
  });

  it('discards a gap spanning downtime rather than scoring it', () => {
    // The exact shape that mislabelled this buddy: a long silence caused by the
    // server being unloadable, with no heartbeat to prove otherwise.
    recordEvent('feature', 10, 'a', dayBefore(25));
    recordEvent('feature', 10, 'b', dayBefore(2));
    recordHeartbeat(dayBefore(25));
    recordHeartbeat(dayBefore(2));

    assert.deepEqual(knownGaps(NOW), [], 'an unexplained 23-day hole is not evidence');
  });

  it('keeps consecutive-day gaps, which need no intervening proof', () => {
    for (const d of [4, 3, 2, 1]) recordEvent('feature', 10, 'x', dayBefore(d));
    assert.deepEqual(knownGaps(NOW), [1, 1, 1]);
  });

  it('is empty with fewer than two active days', () => {
    recordEvent('feature', 10, 'a', NOW);
    assert.deepEqual(knownGaps(NOW), []);
  });
});

describe('migration backfill', () => {
  it('backfills heartbeats from existing events', () => {
    closeDb();
    for (const s of ['', '-wal', '-shm']) rmSync(join(home, `buddy.db${s}`), { force: true });

    // Build a v4-shaped database carrying events but no heartbeats table.
    const db = getDb();
    db.exec('DROP TABLE heartbeats');
    db.exec('DELETE FROM events');
    db.prepare('INSERT INTO events (at, kind, xp, summary) VALUES (?, ?, ?, ?)')
      .run(dayBefore(3).getTime(), 'feature', 10, 'old work');
    db.exec('PRAGMA user_version = 4');
    closeDb();

    const rows = getDb().prepare("SELECT day, source FROM heartbeats").all();
    assert.equal(rows.length, 1, 'a day that recorded work must count as running');
    assert.equal(rows[0].day, localDay(dayBefore(3)));
    assert.equal(rows[0].source, 'backfill');
  });
});
