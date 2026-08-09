import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * There is one buddy server per Claude Code session, each its own process, all
 * writing the same database. save() rewrites every column of the singleton row
 * from whatever the caller last read, so a read-modify-write that is not held
 * under a lock loses whatever another process committed in between.
 *
 * These tests race real processes rather than simulating the race in one, since
 * the thing under test is SQLite's cross-process locking and a single-process
 * stand-in would prove nothing about it.
 */

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-concurrency-'));
  process.env.BUDDY_HOME = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

const dist = new URL('../dist/', import.meta.url).pathname;

/** Run `src` in a child process with its own database handle. */
function child(src) {
  const file = join(home, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, src);
  return execFileSync(process.execPath, [file], {
    env: { ...process.env, BUDDY_HOME: home },
    encoding: 'utf8',
  });
}

describe('concurrent writers', () => {
  it('does not lose XP when two processes observe at once', async () => {
    const { load, closeDb } = await import('../dist/state.js');
    const { hatch, save } = await import('../dist/state.js');

    // Seed a buddy, then let go of the handle so the children are the only
    // writers and the parent cannot mask a locking bug with a warm cache.
    const seeded = hatch(new Date());
    seeded.xp = 0;
    seeded.totalXp = 0;
    save(seeded);
    closeDb();

    const ROUNDS = 25;
    // Each child does the same read-modify-write the observe tool does: read the
    // buddy, add a fixed amount, write it back. Interleaved without a lock, the
    // second write is computed from a stale read and the first one vanishes.
    const worker = (tag) => `
      process.env.BUDDY_HOME = ${JSON.stringify(home)};
      const { withBuddy } = await import(${JSON.stringify(dist + 'state.js')});
      for (let i = 0; i < ${ROUNDS}; i++) {
        withBuddy(new Date(), (state) => {
          state.xp += 1;
          state.totalXp += 1;
        });
      }
      console.log('${tag} done');
    `;

    const a = join(home, 'a.mjs');
    const b = join(home, 'b.mjs');
    writeFileSync(a, worker('a'));
    writeFileSync(b, worker('b'));

    // Genuinely concurrent: both start before either finishes.
    const runs = [a, b].map(
      (file) =>
        new Promise((resolve, reject) => {
          import('node:child_process').then(({ execFile }) => {
            execFile(
              process.execPath,
              [file],
              { env: { ...process.env, BUDDY_HOME: home } },
              (err, stdout) => (err ? reject(err) : resolve(stdout)),
            );
          });
        }),
    );
    await Promise.all(runs);

    const { state } = load(new Date());
    assert.equal(
      state.xp,
      ROUNDS * 2,
      `expected every increment to survive; a shortfall is a lost update`,
    );
    assert.equal(state.totalXp, ROUNDS * 2);
  });

  it('rolls the buddy back when the callback throws', async () => {
    const { load, withBuddy, closeDb } = await import('../dist/state.js');
    closeDb();

    const before = load(new Date()).state;
    const name = before.name;

    assert.throws(() => {
      withBuddy(new Date(), (state) => {
        state.name = 'Clobbered';
        state.xp += 9999;
        throw new Error('boom');
      });
    }, /boom/);

    // A failed tool call must not leave a half-applied buddy behind.
    const after = load(new Date()).state;
    assert.equal(after.name, name);
    assert.equal(after.xp, before.xp);
  });

  it('commits the event row with the XP it granted', async () => {
    const { withBuddy, recordEvent, closeDb } = await import('../dist/state.js');
    const { getDb } = await import('../dist/db.js');
    closeDb();

    const countEvents = () =>
      Number(getDb().prepare("SELECT count(*) AS n FROM events WHERE kind = 'test-atomic'").get().n);

    const before = countEvents();

    assert.throws(() => {
      withBuddy(new Date(), (state) => {
        state.xp += 50;
        recordEvent('test-atomic', 50, 'should not survive', new Date());
        throw new Error('nope');
      });
    }, /nope/);

    // The event joined the transaction, so the rollback took it too. Before the
    // two were one transaction, this row outlived the XP that justified it.
    assert.equal(countEvents(), before);
  });
});
