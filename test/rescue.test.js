import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

let home, dir, claudeJson, eventsDb;

const ORIGINAL = {
  name: 'Emberchaos',
  personality:
    'A rotund, fidgety chonk that thrashes through your code like a wrecking ball, ' +
    'somehow finding the bugs by pure frantic energy rather than logic, then sits ' +
    'smugly while you fix it.',
  hatchedAt: 1775629556015, // 2026-04-08T06:25:56.015Z
};

function makeEventsDb(path, count = 12) {
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
    'INSERT INTO companions (id, name, species, level, xp, created_at) VALUES (?,?,?,?,?,?)',
  ).run('c1', 'Voidkin', 'Owl', 13, 3160, '2026-04-12 21:48:08');

  const insert = db.prepare(
    'INSERT INTO xp_events (id, companion_id, event_type, xp_gained, created_at) VALUES (?,?,?,?,?)',
  );
  const types = ['observe', 'bug_fix', 'deploy', 'commit', 'session'];
  for (let i = 0; i < count; i++) {
    const day = String(10 + i).padStart(2, '0');
    insert.run(`e${i}`, 'c1', types[i % types.length], 5, `2026-05-${day} 09:00:00`);
  }
  db.close();
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-rescue-'));
  process.env.BUDDY_HOME = home;
  dir = mkdtempSync(join(tmpdir(), 'rescue-src-'));
  claudeJson = join(dir, 'claude.json');
  eventsDb = join(dir, 'buddy.db');
  writeFileSync(claudeJson, JSON.stringify({ userID: 'x', companion: ORIGINAL }), 'utf8');
  makeEventsDb(eventsDb);
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const { parseClaudeCompanion, inferPersonality, rescueOriginal } = await import('../dist/import.js');
const { load } = await import('../dist/state.js');
const { closeDb, getDb } = await import('../dist/db.js');

const NOW = new Date('2026-07-31T10:00:00Z');

describe('parseClaudeCompanion', () => {
  it('reads the record Anthropic left behind', () => {
    const o = parseClaudeCompanion(claudeJson);
    assert.equal(o.name, 'Emberchaos');
    assert.equal(o.hatchedAt, ORIGINAL.hatchedAt);
    assert.match(o.bio, /wrecking ball/);
  });

  it('accepts the alternate key shapes', () => {
    const alt = join(dir, 'alt.json');
    writeFileSync(alt, JSON.stringify({ buddy: { name: 'Alt', personality: 'calm' } }), 'utf8');
    assert.equal(parseClaudeCompanion(alt).name, 'Alt');

    const flat = join(dir, 'flat.json');
    writeFileSync(flat, JSON.stringify({ buddyName: 'Flat' }), 'utf8');
    assert.equal(parseClaudeCompanion(flat).name, 'Flat');
  });

  it('returns null rather than throwing on missing or junk files', () => {
    assert.equal(parseClaudeCompanion(join(dir, 'nope.json')), null);
    const junk = join(dir, 'junk.json');
    writeFileSync(junk, 'not json', 'utf8');
    assert.equal(parseClaudeCompanion(junk), null);
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '{}', 'utf8');
    assert.equal(parseClaudeCompanion(empty), null);
  });
});

describe('inferPersonality', () => {
  it('reads gremlin out of the original Emberchaos bio', () => {
    assert.equal(inferPersonality(ORIGINAL.personality), 'gremlin');
  });

  it('recognises the other personalities', () => {
    assert.equal(inferPersonality('A calm, mindful creature of great patience.'), 'zen');
    assert.equal(inferPersonality('Endlessly cheerful and enthusiastic.'), 'cheerful');
    assert.equal(inferPersonality('Dry, sardonic, and deeply unimpressed.'), 'snarky');
    assert.equal(inferPersonality('Steady, methodical and unflappable.'), 'stoic');
  });

  it('returns null when nothing matches', () => {
    assert.equal(inferPersonality('A creature.'), null);
    assert.equal(inferPersonality(''), null);
  });
});

describe('rescueOriginal', () => {
  let r;
  before(() => {
    closeDb();
    r = rescueOriginal({ identityFrom: claudeJson, eventsFrom: eventsDb });
  });

  it('restores the original name and bio', () => {
    assert.equal(r.name, 'Emberchaos');
    assert.match(r.bio, /wrecking ball/);
    assert.equal(load(NOW).state.bio, ORIGINAL.personality);
  });

  it('uses the true hatch date, not the later database one', () => {
    assert.equal(r.bornAt, '2026-04-08T06:25:56.015Z');
  });

  it('infers personality from the bio instead of rolling', () => {
    assert.equal(r.personality, 'gremlin');
    assert.equal(r.personalityInferred, true);
  });

  it('grafts on the events and level from the history database', () => {
    assert.equal(r.events, 12);
    assert.equal(r.level, 13);
    assert.equal(r.totalXp, 3160);
    assert.equal(load(NOW).state.observations, 12);
  });

  it('reconstructs the longest streak from grafted events', () => {
    assert.equal(r.longestStreak, 12);
  });

  it('records both provenance sources', () => {
    const row = getDb().prepare('SELECT imported_from FROM buddy WHERE id = 1').get();
    assert.match(row.imported_from, /claude\.json \+ /);
  });

  it('an explicit personality overrides inference', () => {
    const x = rescueOriginal({
      identityFrom: claudeJson, eventsFrom: eventsDb, personality: 'stoic', force: true,
    });
    assert.equal(x.personality, 'stoic');
    assert.equal(x.personalityInferred, false);
  });

  it('works with no history at all', () => {
    const x = rescueOriginal({ identityFrom: claudeJson, eventsFrom: null, force: true });
    assert.equal(x.events, 0);
    assert.equal(x.level, 1);
    assert.equal(x.bornAt, '2026-04-08T06:25:56.015Z');
    assert.equal(x.name, 'Emberchaos');
  });

  it('refuses to clobber without force', () => {
    assert.throws(
      () => rescueOriginal({ identityFrom: claudeJson, eventsFrom: eventsDb }),
      /already lives here/i,
    );
  });

  it('does not duplicate events when re-run with force', () => {
    rescueOriginal({ identityFrom: claudeJson, eventsFrom: eventsDb, force: true });
    assert.equal(load(NOW).state.observations, 12);
  });

  it('fails clearly when there is no original to rescue', () => {
    assert.throws(
      () => rescueOriginal({ identityFrom: join(dir, 'nope.json'), force: true }),
      /No original companion found/i,
    );
  });
});
