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
    assert.deepEqual(names, [
      'buddy_advise',
      'buddy_observe',
      'buddy_rename',
      'buddy_skills',
      'buddy_status',
    ]);

    const advise = tools.find((t) => t.name === 'buddy_advise');
    assert.deepEqual(advise.inputSchema.required, ['task']);
    assert.ok(advise.inputSchema.properties.limit, 'limit is exposed');

    const observe = tools.find((t) => t.name === 'buddy_observe');
    assert.ok(observe.description.length > 0);
    assert.deepEqual(observe.inputSchema.required, ['summary']);
    assert.ok(observe.inputSchema.properties.kind, 'kind is exposed as an optional override');
    assert.ok(observe.inputSchema.properties.skills_used, 'skills_used is exposed');
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

  it('lists discovered skills', async () => {
    const out = textOf(await client.callTool({ name: 'buddy_skills', arguments: {} }));
    assert.match(out, /Skills|No skills discovered/);
  });

  it('accepts skills_used and counts it', async () => {
    await client.callTool({
      name: 'buddy_observe',
      arguments: { summary: 'Deployed a Worker.', skills_used: ['cloudflare:wrangler'] },
    });
    const out = textOf(await client.callTool({ name: 'buddy_skills', arguments: {} }));
    assert.match(out, /cloudflare:wrangler/);
  });

  it('advises on a task and learns from recorded usage', async () => {
    const cold = textOf(
      await client.callTool({
        name: 'buddy_advise',
        arguments: { task: 'deploy a cloudflare worker with wrangler' },
      }),
    );
    assert.match(cold, /deploy/, 'infers the task kind');

    await client.callTool({
      name: 'buddy_observe',
      arguments: {
        summary: 'Deployed a worker.',
        kind: 'deploy',
        skills_used: ['cloudflare:wrangler'],
      },
    });

    const warm = textOf(
      await client.callTool({
        name: 'buddy_advise',
        arguments: { task: 'deploy a cloudflare worker with wrangler', limit: 2 },
      }),
    );
    assert.match(warm, /cloudflare:wrangler/);
    // Count is not pinned: earlier cases in this file also record wrangler use.
    assert.match(warm, /used \d+× for deploy work/, 'reflects recorded history');
  });

  it('says so plainly when no skill fits', async () => {
    const out = textOf(
      await client.callTool({
        name: 'buddy_advise',
        arguments: { task: 'zzzqqq nonsense tokens xyzzy' },
      }),
    );
    assert.match(out, /doesn't know a skill that fits/i);
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
