import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-test-'));
  process.env.BUDDY_HOME = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

const { classify, observe, stageFor, xpForLevel, touchStreak, applyIdle, moodScore, moodTier } =
  await import('../dist/engine.js');
const { hatch, load, save, statePath, stateDir, localDay, closeDb, recordEvent } =
  await import('../dist/state.js');
const { getDb } = await import('../dist/db.js');

const T0 = new Date('2026-07-30T10:00:00Z');
const hoursLater = (base, h) => new Date(base.getTime() + h * 3_600_000);

describe('classify', () => {
  it('routes summaries to the right kind', () => {
    assert.equal(classify('Fixed the off-by-one in the pagination cursor'), 'bugfix');
    assert.equal(classify('Added a new export endpoint'), 'feature');
    assert.equal(classify('Refactored the auth middleware'), 'refactor');
    assert.equal(classify('Wrote unit tests for the parser'), 'test');
    assert.equal(classify('Deployed to production'), 'deploy');
    assert.equal(classify('Updated the README'), 'docs');
    assert.equal(classify('Bumped the eslint dependency'), 'config');
    assert.equal(classify('Stared at the wall for a while'), 'other');
  });

  it('prefers the more specific reading', () => {
    // "fixed" would match bugfix, but the deploy signal is checked first only
    // for genuine deploys; a fix mentioning config stays a fix.
    assert.equal(classify('Fixed the broken CI config'), 'bugfix');
    assert.equal(classify('Shipped the release to prod'), 'deploy');
  });
});

describe('progression', () => {
  it('xp curve is monotonic and starts at 100', () => {
    assert.equal(xpForLevel(1), 100);
    for (let l = 1; l < 40; l++) {
      assert.ok(xpForLevel(l + 1) > xpForLevel(l), `level ${l}`);
    }
  });

  it('maps levels to stages', () => {
    assert.equal(stageFor(1).id, 'egg');
    assert.equal(stageFor(2).id, 'hatchling');
    assert.equal(stageFor(4).id, 'hatchling');
    assert.equal(stageFor(5).id, 'whelp');
    assert.equal(stageFor(10).id, 'dragon');
    assert.equal(stageFor(999).id, 'ascendant');
  });

  it('grants xp and evolves the egg on first level-up', () => {
    const s = hatch(T0);
    let evolved = null;
    for (let i = 0; i < 10 && !evolved; i++) {
      const r = observe(s, 'Fixed a bug', hoursLater(T0, i));
      assert.ok(r.xpGained > 0);
      if (r.evolvedTo) evolved = r.evolvedTo;
    }
    assert.equal(evolved?.id, 'hatchling');
    assert.equal(s.level, 2);
    assert.ok(s.totalXp >= 100);
    assert.ok(s.milestones.some((m) => m.text.includes('Evolved')));
  });

  it('can carry multiple levels from one observation', () => {
    const s = hatch(T0);
    s.xp = xpForLevel(1) + xpForLevel(2) - 1; // one xp short of two level-ups
    const r = observe(s, 'Deployed to production', T0);
    assert.equal(s.level, 3);
    assert.equal(r.leveledTo, 3);
    assert.ok(s.xp < xpForLevel(3));
  });

  it('never banks negative leftover xp', () => {
    const s = hatch(T0);
    for (let i = 0; i < 200; i++) {
      observe(s, 'Added a feature', hoursLater(T0, i));
      assert.ok(s.xp >= 0 && s.xp < xpForLevel(s.level), `iteration ${i}: xp=${s.xp}`);
    }
  });
});

describe('streaks', () => {
  it('increments on consecutive local days and resets after a gap', () => {
    const s = hatch(T0);
    s.streak = 1;

    assert.equal(touchStreak(s, T0), false, 'same day is not a new visit');
    assert.equal(s.streak, 1);

    const day2 = hoursLater(T0, 24);
    assert.equal(touchStreak(s, day2), true);
    assert.equal(s.streak, 2);

    const day3 = hoursLater(T0, 48);
    touchStreak(s, day3);
    assert.equal(s.streak, 3);
    assert.equal(s.longestStreak, 3);

    const day6 = hoursLater(T0, 24 * 6);
    touchStreak(s, day6);
    assert.equal(s.streak, 1, 'gap resets the streak');
    assert.equal(s.longestStreak, 3, 'best is remembered');
  });

  it('does not let a status check-in spend the daily bonus', () => {
    const s = hatch(T0);
    touchStreak(s, T0); // as buddy_status does at the start of a conversation

    const first = observe(s, 'Fixed a bug', T0);
    assert.equal(first.firstToday, true, 'the first observation of the day still counts');

    const second = observe(s, 'Fixed another bug', T0);
    assert.equal(second.firstToday, false);
    assert.ok(first.xpGained > second.xpGained, 'the bonus is worth something');

    const tomorrow = hoursLater(T0, 24);
    assert.equal(observe(s, 'Fixed a bug', tomorrow).firstToday, true, 'bonus returns the next day');
  });

  it('uses local calendar days', () => {
    const s = hatch(T0);
    s.lastSeenDay = localDay(T0);
    assert.equal(touchStreak(s, new Date(T0.getTime() + 60_000)), false);
  });
});

describe('energy and mood', () => {
  it('drains with work and recovers while idle', () => {
    const s = hatch(T0);
    for (let i = 0; i < 10; i++) observe(s, 'Fixed a bug', T0);
    assert.ok(s.energy < 100, 'work costs energy');
    const drained = s.energy;

    applyIdle(s, hoursLater(T0, 5));
    assert.ok(s.energy > drained, 'rest restores energy');
    assert.ok(s.energy <= 100, 'energy is capped');
  });

  it('sours when neglected and brightens on a streak', () => {
    const s = hatch(T0);
    s.streak = 5;
    assert.equal(moodTier(moodScore(s, T0)), 'radiant');

    const week = hoursLater(T0, 24 * 7);
    assert.equal(moodTier(moodScore(s, week)), 'bad');
  });

  it('keeps mood inside 0..100', () => {
    const s = hatch(T0);
    s.streak = 500;
    s.energy = 0;
    for (const h of [0, 1, 100, 10_000]) {
      const m = moodScore(s, hoursLater(T0, h));
      assert.ok(m >= 0 && m <= 100, `h=${h} m=${m}`);
    }
  });
});

/** Drops the cached handle and the file, so the next load() hatches fresh. */
function resetDb() {
  closeDb();
  rmSync(statePath(), { force: true });
  rmSync(`${statePath()}-wal`, { force: true });
  rmSync(`${statePath()}-shm`, { force: true });
}

describe('persistence', () => {
  it('hatches on first load and reloads the same buddy', () => {
    resetDb();
    const first = load(T0);
    assert.equal(first.hatched, true);

    const second = load(T0);
    assert.equal(second.hatched, false);
    assert.equal(second.state.name, first.state.name);
    assert.equal(second.state.personality, first.state.personality);
  });

  it('round-trips progress through the database', () => {
    resetDb();
    const { state } = load(T0);
    const r = observe(state, 'Deployed to production', T0);
    save(state);
    recordEvent(r.kind, r.xpGained, 'Deployed to production', T0);

    const reloaded = load(T0).state;
    assert.equal(reloaded.totalXp, state.totalXp);
    assert.equal(reloaded.level, state.level);
    assert.equal(reloaded.observations, 1, 'observations are derived from the events table');
    assert.equal(reloaded.kindCounts.deploy, 1);
  });

  it('keeps an append-only event history', () => {
    resetDb();
    const { state } = load(T0);
    for (let i = 0; i < 5; i++) {
      const r = observe(state, 'Fixed a bug', hoursLater(T0, i));
      recordEvent(r.kind, r.xpGained, 'Fixed a bug', hoursLater(T0, i));
    }
    save(state);
    assert.equal(load(T0).state.observations, 5);
  });

  it('enforces a single buddy at the schema level', () => {
    resetDb();
    load(T0);
    const db = getDb();
    assert.throws(
      () => db.exec("INSERT INTO buddy (id, name, personality, born_at, last_seen_at, last_seen_day) VALUES (2, 'Impostor', 'zen', 0, 0, '2026-01-01')"),
      /CHECK constraint failed|constraint/i,
      'a second buddy row must be unrepresentable',
    );
  });

  it('stores timestamps as integers, not zone-less strings', () => {
    resetDb();
    load(T0);
    const row = getDb().prepare('SELECT born_at, last_seen_at FROM buddy WHERE id = 1').get();
    assert.equal(typeof row.born_at, 'number');
    assert.equal(typeof row.last_seen_at, 'number');
    // The upstream UTC-parsed-as-local bug shows up as an offset of whole hours.
    assert.ok(Math.abs(row.born_at - T0.getTime()) < 1000, `born_at drifted: ${row.born_at - T0.getTime()}ms`);
  });

  it('quarantines an unreadable database instead of crashing', () => {
    resetDb();
    writeFileSync(statePath(), 'this is definitely not a sqlite file', 'utf8');
    closeDb();
    const { state, hatched } = load(T0);
    assert.equal(hatched, true);
    assert.equal(state.level, 1);
    assert.ok(
      readdirSync(stateDir()).some((f) => f.includes('corrupt')),
      'the unreadable file is preserved, not deleted',
    );
  });

  it('clamps nonsense values written directly to the row', () => {
    resetDb();
    load(T0);
    getDb().exec("UPDATE buddy SET level = -5, energy = 999, personality = 'nonexistent' WHERE id = 1");
    const { state } = load(T0);
    assert.equal(state.level, 1);
    assert.equal(state.energy, 100);
    assert.ok(['snarky', 'cheerful', 'stoic', 'gremlin', 'zen'].includes(state.personality));
  });
});
