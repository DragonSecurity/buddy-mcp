import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

let home, sourceDb;

/** Builds a database shaped like @fiorastudio/buddy's, including its UTC strings. */
function makeFioraDb(path, { events = 10, level = 13, xp = 3165 } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE companions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, species TEXT NOT NULL,
      level INTEGER DEFAULT 1, xp INTEGER DEFAULT 0, mood TEXT DEFAULT 'happy',
      personality_bio TEXT DEFAULT '', user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE xp_events (
      id TEXT PRIMARY KEY, companion_id TEXT, event_type TEXT NOT NULL,
      xp_gained INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(
    'INSERT INTO companions (id, name, species, level, xp, mood, personality_bio, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('c1', 'Voidkin', 'Owl', level, xp, 'grumpy', 'A perceptive owl.', 'anon-1', '2026-04-12 21:48:08');

  const insert = db.prepare(
    'INSERT INTO xp_events (id, companion_id, event_type, xp_gained, created_at) VALUES (?,?,?,?,?)',
  );
  const types = ['observe', 'bug_fix', 'deploy', 'commit', 'session'];
  for (let i = 0; i < events; i++) {
    // Consecutive days, so the streak reconstruction has something to find.
    const day = String(10 + i).padStart(2, '0');
    insert.run(`e${i}`, 'c1', types[i % types.length], 5, `2026-05-${day} 09:00:00`);
  }
  db.close();
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-import-'));
  process.env.BUDDY_HOME = home;
  sourceDb = join(mkdtempSync(join(tmpdir(), 'fiora-')), 'buddy.db');
  makeFioraDb(sourceDb);
});
after(() => rmSync(home, { recursive: true, force: true }));

const { importFromFiora, longestStreakFrom } = await import('../dist/import.js');
const { load } = await import('../dist/state.js');
const { closeDb, getDb } = await import('../dist/db.js');

const NOW = new Date('2026-07-30T10:00:00Z');

describe('longestStreakFrom', () => {
  const day = (d) => Date.parse(`2026-05-${String(d).padStart(2, '0')}T09:00:00Z`);

  it('counts a consecutive run', () => {
    assert.equal(longestStreakFrom([day(1), day(2), day(3)]), 3);
  });

  it('resets across a gap and keeps the best run', () => {
    assert.equal(longestStreakFrom([day(1), day(2), day(3), day(9), day(10)]), 3);
  });

  it('treats several events on one day as one day', () => {
    assert.equal(longestStreakFrom([day(1), day(1), day(1)]), 1);
  });

  it('handles an empty history', () => {
    assert.equal(longestStreakFrom([]), 0);
  });
});

describe('importFromFiora', () => {
  let result;
  before(() => {
    closeDb();
    result = importFromFiora({ source: sourceDb, personality: 'stoic' });
  });

  it('carries the name, level and lifetime xp across', () => {
    assert.equal(result.name, 'Voidkin');
    assert.equal(result.level, 13);
    assert.equal(result.totalXp, 3165);
  });

  it('imports every event', () => {
    assert.equal(result.events, 10);
    assert.equal(load(NOW).state.observations, 10);
  });

  it('parses the source UTC timestamp correctly', () => {
    // 2026-04-12 21:48:08 UTC — not shifted by a local offset.
    assert.equal(result.bornAt, '2026-04-12T21:48:08.000Z');
  });

  it('reconstructs the longest streak from event history', () => {
    assert.equal(result.longestStreak, 10);
    assert.equal(load(NOW).state.longestStreak, 10);
  });

  it('maps upstream event types onto our kinds', () => {
    const kinds = getDb().prepare('SELECT DISTINCT kind FROM events').all().map((r) => r.kind);
    assert.ok(kinds.includes('bugfix'), 'bug_fix maps to bugfix');
    assert.ok(kinds.includes('deploy'));
    assert.ok(kinds.includes('other'), 'observe/commit/session collapse to other');
  });

  it('resets xp-toward-next-level under our own curve', () => {
    const s = load(NOW).state;
    assert.equal(s.xp, 0, 'progress toward level 14 starts fresh');
    assert.equal(s.totalXp, 3165, 'lifetime total is preserved');
  });

  it('records provenance', () => {
    const row = getDb().prepare('SELECT imported_from FROM buddy WHERE id = 1').get();
    assert.equal(row.imported_from, sourceDb);
    assert.ok(load(NOW).state.milestones.some((m) => /Imported from/.test(m.text)));
  });

  it('honours the requested personality', () => {
    assert.equal(result.personality, 'stoic');
    assert.equal(load(NOW).state.personality, 'stoic');
  });

  it('refuses to clobber an existing buddy without --force', () => {
    assert.throws(() => importFromFiora({ source: sourceDb }), /already lives here/i);
  });

  it('replaces cleanly with force, without duplicating events', () => {
    const again = importFromFiora({ source: sourceDb, personality: 'zen', force: true });
    assert.equal(again.events, 10);
    assert.equal(load(NOW).state.observations, 10, 'events are replaced, not appended');
  });
});
