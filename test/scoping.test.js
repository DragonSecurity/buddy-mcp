import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

let home, repoA, repoB;

function makeProjectSkill(root, name, description) {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`, 'utf8');
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-scope-'));
  process.env.BUDDY_HOME = home;

  repoA = mkdtempSync(join(tmpdir(), 'repo-a-'));
  repoB = mkdtempSync(join(tmpdir(), 'repo-b-'));

  makeProjectSkill(repoA, 'alpha-only', 'Provisions the alpha widget pipeline.');
  // Same name in both repos — must not shadow each other.
  makeProjectSkill(repoA, 'deploy', 'Deploys the alpha service to production.');
  makeProjectSkill(repoB, 'beta-only', 'Beta reporting and reconciliation.');
  makeProjectSkill(repoB, 'deploy', 'Deploys the beta service to production.');
});
after(() => {
  for (const d of [home, repoA, repoB]) rmSync(d, { recursive: true, force: true });
});

const { discoverSkills, syncSkills, skillStats, advise, suggestSkill, recordSkillUses, affinityByKind } =
  await import('../dist/skills.js');
const { getDb, closeDb } = await import('../dist/db.js');

const T0 = new Date('2026-07-31T10:00:00Z');

function reset() {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(home, `buddy.db${suffix}`), { force: true });
  }
  getDb();
}

beforeEach(reset);

const names = (list) => list.map((s) => s.name).sort();

describe('project skill discovery', () => {
  it('tags project skills with their root and leaves others global', () => {
    const found = discoverSkills(repoA);
    const alpha = found.find((s) => s.name === 'alpha-only');
    assert.ok(alpha, 'project skill discovered');
    assert.equal(alpha.source, 'project');
    assert.equal(alpha.projectRoot, repoA);

    for (const s of found.filter((x) => x.source.startsWith('plugin:'))) {
      assert.equal(s.projectRoot, '', 'plugin skills are global');
    }
  });

  it('only finds the current project\'s skills', () => {
    assert.ok(names(discoverSkills(repoA)).includes('alpha-only'));
    assert.ok(!names(discoverSkills(repoA)).includes('beta-only'));
    assert.ok(names(discoverSkills(repoB)).includes('beta-only'));
    assert.ok(!names(discoverSkills(repoB)).includes('alpha-only'));
  });
});

describe('cross-project isolation', () => {
  beforeEach(() => {
    // Both projects have been visited — the registry holds all of it.
    syncSkills(discoverSkills(repoA), T0);
    syncSkills(discoverSkills(repoB), T0);
  });

  it('the registry retains both, keyed by project', () => {
    const all = getDb().prepare('SELECT name, project_root FROM skills').all();
    assert.ok(all.some((r) => r.name === 'alpha-only' && r.project_root === repoA));
    assert.ok(all.some((r) => r.name === 'beta-only' && r.project_root === repoB));
  });

  it('listing in one project never shows the other project\'s skills', () => {
    const a = names(skillStats(repoA));
    assert.ok(a.includes('alpha-only'));
    assert.ok(!a.includes('beta-only'), `leaked: ${a}`);

    const b = names(skillStats(repoB));
    assert.ok(b.includes('beta-only'));
    assert.ok(!b.includes('alpha-only'), `leaked: ${b}`);
  });

  it('a same-named skill in two repos does not shadow the other', () => {
    const rows = getDb()
      .prepare("SELECT project_root, description FROM skills WHERE name = 'deploy' ORDER BY project_root")
      .all();
    assert.equal(rows.length, 2, 'both rows survive');

    const inA = skillStats(repoA).find((s) => s.name === 'deploy');
    const inB = skillStats(repoB).find((s) => s.name === 'deploy');
    assert.match(inA.description, /alpha/);
    assert.match(inB.description, /beta/);
  });

  it('advice never recommends another project\'s skill', () => {
    const a = advise('run the beta reporting reconciliation', 'other', 10, repoA);
    assert.ok(!a.some((x) => x.skill === 'beta-only'), `leaked: ${a.map((x) => x.skill)}`);

    const b = advise('run the beta reporting reconciliation', 'other', 10, repoB);
    assert.ok(b.some((x) => x.skill === 'beta-only'), 'own project skill is advisable');
  });

  it('nudges never suggest another project\'s skill', () => {
    const s = suggestSkill('beta reporting and reconciliation work', [], T0, repoA);
    assert.notEqual(s && s.skill, 'beta-only');
  });

  it('affinity display hides skills not reachable from here', () => {
    recordSkillUses(['beta-only'], 'feature', T0, repoB);

    const fromB = affinityByKind(repoB);
    assert.ok(fromB.feature && fromB.feature.some((x) => x.skill === 'beta-only'));

    const fromA = affinityByKind(repoA);
    assert.ok(
      !fromA.feature || !fromA.feature.some((x) => x.skill === 'beta-only'),
      'another project\'s history must not name skills that do not exist here',
    );
  });

  it('records usage against the project-scoped row, not a global duplicate', () => {
    recordSkillUses(['alpha-only'], 'deploy', T0, repoA);
    const row = getDb()
      .prepare("SELECT uses, project_root FROM skills WHERE name = 'alpha-only'")
      .get();
    assert.equal(row.uses, 1);
    assert.equal(row.project_root, repoA, 'credited the scoped row');

    const globals = getDb()
      .prepare("SELECT count(*) c FROM skills WHERE name = 'alpha-only' AND project_root = ''")
      .get();
    assert.equal(globals.c, 0, 'no stray global row created');
  });

  it('an unknown reported skill is registered globally', () => {
    recordSkillUses(['some-bundled-skill'], 'test', T0, repoA);
    const row = getDb()
      .prepare("SELECT source, project_root FROM skills WHERE name = 'some-bundled-skill'")
      .get();
    assert.equal(row.source, 'reported');
    assert.equal(row.project_root, '', 'no evidence it belongs to this repo');
    // ...so it is visible from the other project too.
    assert.ok(names(skillStats(repoB)).includes('some-bundled-skill'));
  });
});

describe('migration from the unscoped schema', () => {
  it('treats pre-existing rows as global and preserves their counters', () => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(join(home, `buddy.db${suffix}`), { force: true });
    }

    // Rebuild a v2-shaped skills table, then let migrate() upgrade it.
    const db = getDb();
    db.exec('DROP TABLE skills');
    db.exec(`CREATE TABLE skills (
      name TEXT PRIMARY KEY, source TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER
    )`);
    db.exec("INSERT INTO skills (name, source, description, first_seen, uses, last_used_at) VALUES ('legacy', 'personal', 'old', 1, 7, 99)");
    db.exec('PRAGMA user_version = 2');
    closeDb();

    const row = getDb().prepare("SELECT * FROM skills WHERE name = 'legacy'").get();
    assert.equal(row.project_root, '', 'legacy rows become global');
    assert.equal(row.uses, 7, 'usage counter preserved');
    assert.equal(row.last_used_at, 99);
  });
});

describe('availability reconciliation', () => {
  it('retires a skill that is no longer discoverable, keeping its counters', () => {
    reset();
    syncSkills(discoverSkills(repoA), T0, repoA);
    recordSkillUses(['alpha-only'], 'deploy', T0, repoA);
    assert.ok(names(skillStats(repoA)).includes('alpha-only'));

    // The project skill disappears (uninstalled / plugin removed).
    rmSync(join(repoA, '.claude', 'skills', 'alpha-only'), { recursive: true, force: true });
    syncSkills(discoverSkills(repoA), T0, repoA);

    assert.ok(!names(skillStats(repoA)).includes('alpha-only'), 'hidden from listings');
    assert.deepEqual(advise('alpha widget pipeline', 'deploy', 5, repoA)
      .filter((x) => x.skill === 'alpha-only'), [], 'no longer advised');

    const row = getDb()
      .prepare("SELECT uses, available FROM skills WHERE name = 'alpha-only'")
      .get();
    assert.equal(row.available, 0, 'flagged, not deleted');
    assert.equal(row.uses, 1, 'usage counter survives for a later reinstall');
  });

  it('does not retire another project\'s skills', () => {
    reset();
    syncSkills(discoverSkills(repoB), T0, repoB);
    syncSkills(discoverSkills(repoA), T0, repoA);

    const beta = getDb()
      .prepare("SELECT available FROM skills WHERE name = 'beta-only'")
      .get();
    assert.equal(beta.available, 1, 'syncing repoA must not retire repoB');
  });

  it('does not retire skills only known from skills_used', () => {
    reset();
    recordSkillUses(['bundled-thing'], 'test', T0, repoA);
    syncSkills(discoverSkills(repoA), T0, repoA);

    const row = getDb().prepare("SELECT available FROM skills WHERE name = 'bundled-thing'").get();
    assert.equal(row.available, 1, 'no discovery evidence either way');
  });

  it('restores availability when the skill comes back', () => {
    reset();
    syncSkills(discoverSkills(repoB), T0, repoB);
    rmSync(join(repoB, '.claude', 'skills', 'beta-only'), { recursive: true, force: true });
    syncSkills(discoverSkills(repoB), T0, repoB);
    assert.ok(!names(skillStats(repoB)).includes('beta-only'));

    makeProjectSkill(repoB, 'beta-only', 'Beta reporting and reconciliation.');
    syncSkills(discoverSkills(repoB), T0, repoB);
    assert.ok(names(skillStats(repoB)).includes('beta-only'), 'available again');
  });
});
