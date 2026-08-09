import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let home;
let client;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'buddy-version-'));
  client = new Client({ name: 'buddy-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, BUDDY_HOME: home },
    }),
  );
});

after(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

describe('server version', () => {
  // The version used to be a literal in src/index.ts, which is the failure this
  // pins: a release bumps package.json, nobody remembers the constant, and every
  // client is told about a server version that was never published.
  it('reports the version in package.json', () => {
    const identity = client.getServerVersion();
    assert.equal(identity.name, 'buddy');
    assert.equal(identity.version, manifest.version);
  });

  it('did not fall back to the unreadable-manifest sentinel', () => {
    assert.notEqual(client.getServerVersion().version, '0.0.0-unknown');
  });

  it('stays on major 2, which is the range consumers install', () => {
    // The dragon-dev-buddy plugin declares
    // `npx -y github:DragonSecurity/buddy-mcp#semver:^2`, which npm resolves
    // against this repository's tags rather than against a registry. A version
    // that moves to major 3 is tagged v3.0.0, and `^2` will never resolve to
    // that tag — so every consumer silently stays on the last v2 tag, keeps
    // running the old code and reports no error while doing it. The major is
    // pinned here so that leaving a release behind has to be deliberate.
    assert.match(manifest.version, /^2\./);
  });
});
