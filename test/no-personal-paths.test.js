import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

/**
 * A local absolute home path in a public repository is a leak of a username at
 * best and, in shipped code, a default that works on one machine and nowhere
 * else. The dragon-dev-buddy pack has carried this check since its first
 * release; this server is public too and had none.
 *
 * Tracked files only, so a scratch file or a build output never trips it. A
 * named user segment followed by more path is what counts: the elided
 * `/Users/...` form is how a comment discusses the rule, and must not.
 */
const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g;
const TEXT = /\.(?:[cm]?[jt]s|json|md|ya?ml|sh)$/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

it('no tracked file carries an absolute home path', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => TEXT.test(f));
  assert.ok(files.length > 10, `expected the repository's files, got ${files.length}`);

  const offenders = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // listed but deleted in the working tree
    }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(HOME_PATH)) {
        if (m[1].replace(/\./g, '') !== '') offenders.push(`${file}:${i + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'use ~, $HOME or a placeholder');
});
