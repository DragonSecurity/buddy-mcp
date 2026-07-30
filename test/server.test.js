import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let home;
let client;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'buddy-e2e-'));
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

const textOf = (res) => res.content.map((c) => c.text).join('\n');

describe('mcp server', () => {
  it('advertises the buddy tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['buddy_observe', 'buddy_rename', 'buddy_status']);

    const observe = tools.find((t) => t.name === 'buddy_observe');
    assert.ok(observe.description.length > 0);
    assert.deepEqual(observe.inputSchema.required, ['summary']);
    assert.ok(observe.inputSchema.properties.kind, 'kind is exposed as an optional override');
  });

  it('hatches on the first status call', async () => {
    const out = textOf(await client.callTool({ name: 'buddy_status', arguments: {} }));
    assert.match(out, /hatched/i);
    assert.match(out, /level 1/i);
  });

  it('shows a full card on subsequent status calls', async () => {
    const out = textOf(await client.callTool({ name: 'buddy_status', arguments: {} }));
    assert.match(out, /Lv 1/);
    assert.match(out, /Mood/);
    assert.match(out, /Energy/);
    assert.match(out, /Streak 1 day/);
    assert.doesNotMatch(out, /Something hatched/i, 'the hatch banner shows only once');
  });

  it('awards xp and reacts to an observation', async () => {
    const out = textOf(
      await client.callTool({
        name: 'buddy_observe',
        arguments: { summary: 'Fixed the off-by-one in the pagination cursor.' },
      }),
    );
    assert.match(out, /\+\d+ xp \(bugfix\)/);
    assert.match(out, /first of the day/);
  });

  it('honours an explicit kind override', async () => {
    const out = textOf(
      await client.callTool({
        name: 'buddy_observe',
        arguments: { summary: 'Did a thing.', kind: 'deploy' },
      }),
    );
    assert.match(out, /\(deploy\)/);
  });

  it('levels up and reports it', async () => {
    let sawLevelUp = false;
    for (let i = 0; i < 8 && !sawLevelUp; i++) {
      const out = textOf(
        await client.callTool({
          name: 'buddy_observe',
          arguments: { summary: `Deployed release ${i} to production.` },
        }),
      );
      if (/Level 2!/.test(out)) sawLevelUp = true;
    }
    assert.ok(sawLevelUp, 'reached level 2 within a reasonable number of observations');
  });

  it('rejects an empty summary', async () => {
    const res = await client.callTool({ name: 'buddy_observe', arguments: { summary: '' } });
    assert.equal(res.isError, true);
  });

  it('renames without losing progress', async () => {
    const before = textOf(await client.callTool({ name: 'buddy_status', arguments: {} }));
    const level = before.match(/Lv (\d+)/)[1];

    const out = textOf(await client.callTool({ name: 'buddy_rename', arguments: { name: 'Waffle' } }));
    assert.match(out, /Waffle/);

    const after = textOf(await client.callTool({ name: 'buddy_status', arguments: {} }));
    assert.match(after, /Waffle/);
    assert.match(after, new RegExp(`Lv ${level}`));
  });
});
