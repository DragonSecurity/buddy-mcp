import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let home, projectDir;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-skills-'));
  process.env.BUDDY_HOME = home;

  // A project-local skill, which discovery should pick up alongside plugins.
  projectDir = mkdtempSync(join(tmpdir(), 'buddy-project-'));
  const dir = join(projectDir, '.claude', 'skills', 'deploy-thing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: deploy-thing\ndescription: Deploys the widget pipeline to production clusters.\n---\n\n# Deploy\n',
    'utf8',
  );
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const { discoverSkills, syncSkills, recordSkillUses, skillStats, suggestSkill, scoreSkill } =
  await import('../dist/skills.js');
const { closeDb } = await import('../dist/db.js');

const T0 = new Date('2026-07-30T10:00:00Z');
const daysLater = (d) => new Date(T0.getTime() + d * 86_400_000);

describe('discovery', () => {
  it('finds a project-local skill and parses its frontmatter', () => {
    const found = discoverSkills(projectDir);
    const skill = found.find((s) => s.name === 'deploy-thing');
    assert.ok(skill, `not found in ${found.map((s) => s.name).join(', ')}`);
    assert.equal(skill.source, 'project');
    assert.match(skill.description, /widget pipeline/);
  });

  it('qualifies plugin skills as plugin:skill', () => {
    // Reads the real plugin cache; skip cleanly on a machine with no plugins.
    const plugins = discoverSkills(projectDir).filter((s) => s.source.startsWith('plugin:'));
    for (const p of plugins) assert.match(p.name, /^[\w-]+:[\w-]+$/, p.name);
  });

  it('returns a stable, de-duplicated list', () => {
    const a = discoverSkills(projectDir).map((s) => s.name);
    const b = discoverSkills(projectDir).map((s) => s.name);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length, 'no duplicates');
  });
});

describe('scoring', () => {
  const skill = {
    name: 'cloudflare:wrangler',
    source: 'plugin:cloudflare',
    description: 'Cloudflare Workers CLI for deploying and managing Workers, KV, R2 and D1.',
  };

  it('weights a name hit above a description hit', () => {
    const byName = scoreSkill(skill, 'ran a wrangler command');
    const byDesc = scoreSkill(skill, 'touched the workers config');
    assert.ok(byName > byDesc, `name=${byName} desc=${byDesc}`);
  });

  it('ignores stopwords and short tokens', () => {
    assert.equal(scoreSkill(skill, 'and the for with a an'), 0);
  });

  it('scores an unrelated summary at zero', () => {
    assert.equal(scoreSkill(skill, 'renamed a css variable'), 0);
  });
});

describe('usage tracking and nudges', () => {
  before(() => {
    closeDb();
    syncSkills(
      [
        { name: 'cloudflare:wrangler', source: 'plugin:cloudflare', description: 'Deploy and manage Cloudflare Workers with the wrangler CLI.' },
        { name: 'dataviz', source: 'personal', description: 'Build charts, graphs and dashboards.' },
      ],
      T0,
    );
  });

  it('starts every skill at zero uses', () => {
    const stats = skillStats();
    assert.ok(stats.length >= 2);
    assert.ok(stats.every((s) => s.uses === 0));
  });

  it('records uses and bumps the counter', () => {
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    recordSkillUses(['cloudflare:wrangler'], 'deploy', T0);
    const s = skillStats().find((x) => x.name === 'cloudflare:wrangler');
    assert.equal(s.uses, 2);
    assert.equal(s.lastUsedAt, T0.getTime());
  });

  it('suggests a relevant, unused skill', () => {
    const s = suggestSkill('Built a dashboard with several charts', [], T0);
    assert.ok(s, 'expected a suggestion');
    assert.equal(s.skill, 'dataviz');
    assert.equal(s.uses, 0);
  });

  it('never suggests a skill already used for this task', () => {
    assert.equal(suggestSkill('Built a dashboard with charts', ['dataviz'], T0), null);
  });

  it('does not suggest a recently used skill', () => {
    // wrangler was used at T0, well inside the recency window
    const s = suggestSkill('deploying workers with wrangler', [], daysLater(1));
    assert.equal(s, null);
  });

  it('stops nagging after three suggestions', () => {
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push(suggestSkill('charts and dashboards and graphs', [], daysLater(30 + i)));
    }
    const made = seen.filter(Boolean).length;
    assert.ok(made <= 3, `suggested ${made} times, expected at most 3`);
  });

  it('returns null when nothing is relevant', () => {
    assert.equal(suggestSkill('renamed a local variable', [], daysLater(60)), null);
  });
});
