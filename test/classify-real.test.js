import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, primaryClause } from '../dist/engine.js';

/**
 * Regression corpus of real buddy_observe summaries, recovered from actual
 * Claude Code transcripts and hand-labelled.
 *
 * The classifier used to be first-match-wins over an ordered pattern list with
 * `test` in front, so any summary that mentioned tests anywhere — and Claude
 * Code's convention is to append "(tests pass, vet clean)" — was filed as
 * test-writing. 45% of real summaries landed on `test`. Since `kind` keys skill
 * affinity and sets the XP award, that corrupted everything downstream.
 */
const LABELLED = [
  // The trailing-verification trap: the work is not the verification.
  ['Scaffolded a Claude Code plugin marketplace and built a pure-Go-stdlib Terraform registry MCP server (tests pass, vet clean, verified)', 'feature'],
  ['Added a --format flag to the exporter, verified via build, vet, tests', 'feature'],
  ['Added pkg/datasource/helm for classic index.yaml and OCI chart repos (tests pass)', 'feature'],

  // A colon-led summary: the head clause is the subject.
  ['Fixed two scenario bugs: wired debt rules to their supporting loan mod, cards now render', 'bugfix'],
  ['Fixed Ronîda Island bugs: modDesc with a leading UTF-8 BOM now parses correctly', 'bugfix'],
  ['Diagnosed and fixed a bundled-app bug: the GitHub-backup section reported git missing', 'bugfix'],

  // Genuine test work must still be detected.
  ['Wrote unit tests for the streak logic', 'test'],
  ['Added test coverage for the pagination cursor', 'test'],

  ['Deployed the worker to production', 'deploy'],
  ['Shipped the release to prod', 'deploy'],

  ['Refactored the auth middleware into smaller units', 'refactor'],
  ['Updated the README with install instructions', 'docs'],
  ['Bumped the eslint dependency', 'config'],
];

describe('classify on real summaries', () => {
  for (const [summary, expected] of LABELLED) {
    it(`${expected}: ${summary.slice(0, 58)}…`, () => {
      assert.equal(classify(summary), expected);
    });
  }

  it('does not let an incidental mention of tests dominate', () => {
    const withTests = 'Added 5 features to the mod manager, including a rich detail modal (tests pass)';
    const without = 'Added 5 features to the mod manager, including a rich detail modal';
    assert.equal(classify(withTests), classify(without), 'verification clause must not change the kind');
    assert.equal(classify(withTests), 'feature');
  });

  it('is stable when a verification clause is appended to anything', () => {
    for (const [summary, expected] of LABELLED) {
      for (const suffix of [' (tests pass, vet clean)', ', verified via build/vet/test pass', '; all green']) {
        assert.equal(
          classify(summary + suffix),
          expected,
          `"${suffix.trim()}" changed the kind of: ${summary.slice(0, 50)}`,
        );
      }
    }
  });
});

describe('primaryClause', () => {
  it('keeps the leading clause before a colon', () => {
    assert.match(primaryClause('Fixed two bugs: wired debt rules and tests'), /^Fixed two bugs/);
  });

  it('drops a purely verificational parenthetical', () => {
    assert.doesNotMatch(primaryClause('Built the thing (tests pass, vet clean)'), /tests/i);
  });

  it('keeps a substantive parenthetical', () => {
    assert.match(primaryClause('Built the thing (a Go MCP server)'), /Go MCP server/);
  });

  it('never returns empty', () => {
    for (const s of ['tests pass', '(tests pass)', 'verified', 'x']) {
      assert.ok(primaryClause(s).length > 0, `empty for: ${s}`);
    }
  });
});
