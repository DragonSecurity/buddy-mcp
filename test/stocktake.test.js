import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-stocktake-'));
  process.env.BUDDY_HOME = home;
});
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const { syncSkills, recordSkillUses, stocktake } = await import('../dist/skills.js');
const { recordEvent } = await import('../dist/state.js');
const { renderSkills, renderStocktake } = await import('../dist/render.js');
const { closeDb } = await import('../dist/db.js');

const T0 = new Date('2026-06-01T10:00:00Z');
const day = (d) => new Date(T0.getTime() + d * 86_400_000);
const NOW = day(90);
const CWD = '/nowhere';

const skill = (name, description) => ({ name, description, source: 'personal', projectRoot: '' });

describe('stocktake', () => {
  before(() => {
    // Discovered long before the window, so each has had its chance.
    const old = [
      skill('terraform-review', 'Reviews terraform modules for insecure defaults.'),
      skill('pagination-helper', 'Pagination cursors and offset bugs.'),
      skill('kubernetes-thing', 'Kubernetes manifests and helm charts.'),
      skill('always-on', 'Something used every week.'),
    ];
    syncSkills(old, day(0), CWD);
    recordSkillUses(['pagination-helper'], 'bugfix', day(10), CWD); // before the window
    recordSkillUses(['always-on'], 'feature', day(85), CWD); // inside it

    for (const d of [70, 75, 80]) {
      recordEvent('config', 30, 'Tightened the terraform modules and their defaults.', day(d));
    }
    // Discovered inside the window: it has had no chance, so it has no verdict.
    // A sync is a full listing -- anything it omits is retired -- so the old
    // skills are passed again; their first_seen is kept from the first sync.
    syncSkills([...old, skill('brand-new-terraform', 'Terraform modules, freshly installed.')], day(88), CWD);
  });

  const verdictOf = (take, name) => take.stale.find((s) => s.skill === name)?.verdict;

  it('flags a skill that fits the work done but was never loaded, with the count', () => {
    const take = stocktake(NOW, 30, CWD);
    const hit = take.stale.find((s) => s.skill === 'terraform-review');
    assert.equal(hit?.verdict, 'missed');
    assert.equal(hit?.matched, 3);
    assert.equal(take.observations, 3);
  });

  it('calls a skill quiet when it was used, just not inside the window', () => {
    assert.equal(verdictOf(stocktake(NOW, 30, CWD), 'pagination-helper'), 'quiet');
  });

  it('calls a skill idle when nothing in the window fits it', () => {
    assert.equal(verdictOf(stocktake(NOW, 30, CWD), 'kubernetes-thing'), 'idle');
  });

  it('leaves out a skill used inside the window', () => {
    assert.equal(verdictOf(stocktake(NOW, 30, CWD), 'always-on'), undefined);
  });

  it('leaves out a skill discovered inside the window, however well it matches', () => {
    assert.equal(verdictOf(stocktake(NOW, 30, CWD), 'brand-new-terraform'), undefined);
  });

  it('says nothing when the window holds no observations', () => {
    const take = stocktake(day(400), 30, CWD);
    assert.equal(take.stale.length, 0);
    assert.equal(renderStocktake(take, day(400)), '');
  });

  it('orders the actionable verdict first', () => {
    const verdicts = stocktake(NOW, 30, CWD).stale.map((s) => s.verdict);
    assert.deepEqual(verdicts, ['missed', 'quiet', 'idle']);
  });

  it('renders each skill once, under its verdict rather than also under "Never used"', () => {
    const take = stocktake(NOW, 30, CWD);
    const stats = [
      { name: 'terraform-review', source: 'personal', description: '', projectRoot: '', uses: 0, lastUsedAt: null },
      { name: 'brand-new-terraform', source: 'personal', description: '', projectRoot: '', uses: 0, lastUsedAt: null },
    ];
    const out = renderSkills(stats, {}, [], true, take, NOW);
    assert.match(out, /Fit your work, never loaded[^\n]*terraform-review \(3×\)/);
    assert.match(out, /Never used \(1\): brand-new-terraform/);
    assert.equal(out.match(/terraform-review/g).length, 1);
  });
});
