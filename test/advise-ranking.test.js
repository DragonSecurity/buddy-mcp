import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-rank-'));
  process.env.BUDDY_HOME = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

const { syncSkills, recordSkillUses, advise } = await import('../dist/skills.js');
const { getDb, closeDb } = await import('../dist/db.js');

const T0 = new Date('2026-07-31T10:00:00Z');

/**
 * The real shape that exposed the bug: a skill learned only from skills_used
 * has no description at all, so it can never score on text. A skill you use
 * every single time for a kind must still beat a never-used skill that merely
 * shares one incidental word.
 */
const SKILLS = [
  {
    name: 'dataviz',
    source: 'reported',
    description: '', // bundled skill — not in the plugin cache, so no description
  },
  {
    name: 'cloudflare:cloudflare-email-service',
    source: 'plugin:cloudflare',
    description:
      'Send and receive transactional emails with Cloudflare Email Service. Use when building ' +
      'email sending, email routing, or integrating email into any app.',
  },
];

beforeEach(() => {
  closeDb();
  rmSync(join(home, 'buddy.db'), { force: true });
  rmSync(join(home, 'buddy.db-wal'), { force: true });
  rmSync(join(home, 'buddy.db-shm'), { force: true });
  getDb();
  syncSkills(SKILLS, T0);
});

describe('relevance is scored absolutely, not against the field', () => {
  it('a single incidental word match does not score as a perfect match', () => {
    // "building" is the only overlap with the email skill, and nothing else in
    // the field competes — under field-relative scoring this scored 1.0.
    const [top] = advise('building a dashboard panel', 'feature', 1);
    assert.ok(top.score < 0.3, `weak match should score low, got ${top.score}`);
  });

  it('a description-less skill you always use outranks a weak text match', () => {
    for (let i = 0; i < 4; i++) recordSkillUses(['dataviz'], 'feature', T0);

    const ranked = advise('building a dashboard panel showing request volume', 'feature', 5);
    assert.equal(
      ranked[0].skill,
      'dataviz',
      `history should win over an incidental match (got ${ranked.map((r) => `${r.skill}:${r.score.toFixed(2)}`)})`,
    );
    assert.equal(ranked[0].relevance, 0, 'it genuinely has no text to match on');
  });

  it('a strong text match still beats pure affinity', () => {
    for (let i = 0; i < 20; i++) recordSkillUses(['dataviz'], 'feature', T0);

    const ranked = advise('send transactional email with the email service', 'feature', 5);
    assert.equal(ranked[0].skill, 'cloudflare:cloudflare-email-service');
  });

  it('scores stay within 0..1 even at maximum relevance and affinity', () => {
    for (let i = 0; i < 10; i++) recordSkillUses(['cloudflare:cloudflare-email-service'], 'feature', T0);
    const [top] = advise(
      'cloudflare email service transactional email routing sending integrating',
      'feature',
      1,
    );
    assert.ok(top.score > 0 && top.score <= 1, `score ${top.score}`);
  });
});
