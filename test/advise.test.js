import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-advise-'));
  process.env.BUDDY_HOME = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

const { syncSkills, recordSkillUses, affinityFor, affinityByKind, advise } =
  await import('../dist/skills.js');
const { getDb, closeDb } = await import('../dist/db.js');

const T0 = new Date('2026-07-31T10:00:00Z');

const SKILLS = [
  {
    name: 'cloudflare:wrangler',
    source: 'plugin:cloudflare',
    description: 'Deploy and manage Cloudflare Workers, KV, R2 and D1 from the command line.',
  },
  {
    name: 'cloudflare:durable-objects',
    source: 'plugin:cloudflare',
    description: 'Build stateful coordination on Cloudflare with Durable Objects and SQLite storage.',
  },
  {
    name: 'dataviz',
    source: 'personal',
    description: 'Build charts, graphs and dashboards.',
  },
  {
    name: 'security-review',
    source: 'personal',
    description: 'Review changes for security problems before release.',
  },
];

function reset() {
  closeDb();
  rmSync(join(home, 'buddy.db'), { force: true });
  rmSync(join(home, 'buddy.db-wal'), { force: true });
  rmSync(join(home, 'buddy.db-shm'), { force: true });
  getDb();
  syncSkills(SKILLS, T0);
}

beforeEach(reset);

describe('affinityFor', () => {
  it('is empty before anything is recorded', () => {
    assert.deepEqual(affinityFor('deploy'), []);
  });

  it('ranks by usage and computes share of that kind', () => {
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    recordSkillUses(['security-review'], 'deploy', T0);

    const a = affinityFor('deploy');
    assert.equal(a[0].skill, 'cloudflare:wrangler');
    assert.equal(a[0].uses, 3);
    assert.equal(a[0].share, 0.75);
    assert.equal(a[1].skill, 'security-review');
    assert.equal(a[1].share, 0.25);
  });

  it('keeps kinds separate', () => {
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    recordSkillUses(['dataviz'], 'feature', T0);

    assert.deepEqual(affinityFor('deploy').map((a) => a.skill), ['cloudflare:wrangler']);
    assert.deepEqual(affinityFor('feature').map((a) => a.skill), ['dataviz']);
    assert.deepEqual(affinityFor('docs'), []);
  });

  it('shares always sum to 1 for a kind with usage', () => {
    recordSkillUses(['cloudflare:wrangler'], 'bugfix', T0);
    recordSkillUses(['dataviz'], 'bugfix', T0);
    recordSkillUses(['dataviz'], 'bugfix', T0);
    const total = affinityFor('bugfix').reduce((s, a) => s + a.share, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `got ${total}`);
  });
});

describe('affinityByKind', () => {
  it('reports every kind that has usage, and no others', () => {
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    recordSkillUses(['dataviz'], 'feature', T0);

    const all = affinityByKind();
    assert.deepEqual(Object.keys(all).sort(), ['deploy', 'feature']);
    assert.equal(all.deploy[0].skill, 'cloudflare:wrangler');
  });

  it('is empty with no history', () => {
    assert.deepEqual(affinityByKind(), {});
  });
});

describe('advise', () => {
  it('ranks on description alone when there is no history', () => {
    const a = advise('deploy a worker to cloudflare', 'deploy');
    assert.ok(a.length > 0);
    assert.equal(a[0].skill, 'cloudflare:wrangler');
    assert.equal(a[0].kindUses, 0);
    assert.match(a[0].reason, /never used/);
  });

  it('lets learned affinity reorder two similarly-relevant skills', () => {
    // Both skills only match on "cloudflare", so relevance ties and the sort
    // falls back to alphabetical — durable-objects wins by name alone.
    const task = 'work on the cloudflare service';
    const before = advise(task, 'feature', 4);
    assert.equal(before[0].skill, 'cloudflare:durable-objects');
    assert.equal(before[0].score, before[1].score, 'precondition: relevance ties');

    // Now teach it that wrangler is what actually gets used for features.
    for (let i = 0; i < 8; i++) {
      recordSkillUses(['cloudflare:wrangler'], 'feature', T0);
    }

    const after = advise(task, 'feature', 4);
    assert.equal(
      after[0].skill,
      'cloudflare:wrangler',
      `history should outrank the alphabetical tiebreak (got ${after.map((x) => x.skill)})`,
    );
    assert.ok(after[0].score > before[0].score, 'affinity should raise the score');
  });

  it('does not let affinity override a clearly irrelevant skill', () => {
    for (let i = 0; i < 20; i++) recordSkillUses(['dataviz'], 'deploy', T0);

    const a = advise('deploy a cloudflare worker with wrangler', 'deploy', 4);
    assert.equal(a[0].skill, 'cloudflare:wrangler', 'relevance still leads');
  });

  it('reports affinity, usage counts and a human reason', () => {
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);

    const top = advise('deploy a worker', 'deploy')[0];
    assert.equal(top.skill, 'cloudflare:wrangler');
    assert.equal(top.kindUses, 2);
    assert.equal(top.uses, 2);
    assert.equal(top.affinity, 1);
    assert.match(top.reason, /used 2× for deploy work/);
  });

  it('scores are within 0..1 and sorted descending', () => {
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    const a = advise('deploy cloudflare workers and charts', 'deploy', 10);
    for (const x of a) assert.ok(x.score > 0 && x.score <= 1, `score ${x.score}`);
    for (let i = 1; i < a.length; i++) {
      assert.ok(a[i - 1].score >= a[i].score, 'not sorted');
    }
  });

  it('respects the limit', () => {
    assert.equal(advise('cloudflare workers charts security', 'other', 2).length, 2);
    assert.ok(advise('cloudflare workers charts security', 'other', 10).length <= 4);
  });

  it('returns nothing for a task unrelated to every skill', () => {
    assert.deepEqual(advise('renamed a local variable', 'refactor'), []);
  });

  it('returns nothing when no skills are registered at all', () => {
    getDb().exec('DELETE FROM skills');
    assert.deepEqual(advise('deploy a cloudflare worker', 'deploy'), []);
  });

  it('surfaces a never-used skill that fits, so discovery still works', () => {
    for (let i = 0; i < 10; i++) recordSkillUses(['dataviz'], 'deploy', T0);
    const names = advise('deploy a cloudflare worker with wrangler', 'deploy', 4).map((x) => x.skill);
    assert.ok(names.includes('cloudflare:wrangler'), `got ${names}`);
  });
});
