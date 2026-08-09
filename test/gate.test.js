import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The compliance metric reads a log the dragon-dev-buddy pack writes. That is a
 * real coupling to another project's file format, so these tests pin the shape
 * being relied on — if the pack ever changes it, this is where it surfaces.
 */

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-gate-'));
  process.env.BUDDY_HOME = home;
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.BUDDY_GATE_LOG;
});

const { compliance } = await import('../dist/gate.js');

/** Write a gate log and point the module at it. */
function log(lines) {
  const path = join(home, `gate-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  process.env.BUDDY_GATE_LOG = path;
  return path;
}

const at = (d) => d.toISOString().replace(/\.\d+Z$/, '');
const now = new Date('2026-08-10T12:00:00');
const daysAgo = (n) => at(new Date(now.getTime() - n * 86_400_000));

describe('gate compliance', () => {
  it('counts a voluntary record and a nagged one, and nothing else', () => {
    log([
      // The two events that mean something.
      { at: daysAgo(1), event: 'clear', had: true },
      { at: daysAgo(1), event: 'stop', block: true },
      // A clear with no mark is an observation on a turn that changed nothing,
      // or the one that follows a nag. Neither is a code-changing turn.
      { at: daysAgo(1), event: 'clear', had: false },
      // A stop that did not block is a turn that had already recorded — already
      // counted by its clear, and counting it again would double it.
      { at: daysAgo(1), event: 'stop', block: false },
      // Marks are not turns; a turn can produce several.
      { at: daysAgo(1), event: 'mark', tool: 'Edit' },
      { at: daysAgo(1), event: 'mark', tool: 'Write' },
    ]);

    const c = compliance(now);
    assert.equal(c.voluntary, 1);
    assert.equal(c.prompted, 1);
    assert.equal(c.total, 2);
    assert.equal(c.rate, 0.5);
  });

  it('ignores events outside the window', () => {
    log([
      { at: daysAgo(1), event: 'clear', had: true },
      { at: daysAgo(45), event: 'stop', block: true },
      { at: daysAgo(45), event: 'clear', had: true },
    ]);

    const c = compliance(now, 30);
    assert.equal(c.total, 1, 'a 45-day-old event is outside a 30-day window');
    assert.equal(c.voluntary, 1);
  });

  it('survives a truncated final line', () => {
    // An append-only log read mid-write ends in a partial record. That is
    // normal, not corruption, and must not cost the whole reading.
    log([
      { at: daysAgo(1), event: 'clear', had: true },
      '{"at":"2026-08-10T11:59:00","event":"sto',
    ]);

    assert.equal(compliance(now).voluntary, 1);
  });

  it('says nothing rather than something meaningless', () => {
    process.env.BUDDY_GATE_LOG = join(home, 'does-not-exist.log');
    assert.equal(compliance(now), null, 'no pack installed is not an error');

    log([{ at: daysAgo(1), event: 'mark', tool: 'Edit' }]);
    assert.equal(compliance(now), null, 'marks alone describe no completed turn');

    log([]);
    assert.equal(compliance(now), null, 'an empty log is not 0%');
  });

  it('reads the local-time stamps the gate actually writes', () => {
    // The gate writes local time with no offset. Parsing it as UTC would move
    // the window edge by the offset and silently drop or admit a day.
    log([{ at: daysAgo(29.5), event: 'clear', had: true }]);
    assert.equal(compliance(now, 30).voluntary, 1, 'just inside the window');

    log([{ at: daysAgo(30.5), event: 'clear', had: true }]);
    assert.equal(compliance(now, 30), null, 'just outside it');
  });
});
