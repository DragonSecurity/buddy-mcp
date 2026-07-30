#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { applyIdle, observe, stageFor, touchStreak } from './engine.js';
import { renderObserve, renderStatus } from './render.js';
import { load, save, statePath } from './state.js';
import { OBSERVATION_KINDS } from './types.js';

const VERSION = '1.0.0';

const server = new McpServer(
  { name: 'buddy', version: VERSION },
  {
    instructions:
      'A persistent coding companion that levels up as you work. Call buddy_status at the ' +
      'start of a conversation, and buddy_observe after completing any coding task. Relay the ' +
      "buddy's reaction to the user verbatim — the personality is the point.",
  },
);

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

server.registerTool(
  'buddy_status',
  {
    title: 'Check on your buddy',
    description:
      'Show the buddy: stage, level, XP, mood, energy and streak. Hatches a new buddy on ' +
      'first use (name and personality are rolled once and kept for life). Safe to call ' +
      'at the start of every conversation. Show the returned card to the user as-is.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const now = new Date();
    const { state, hatched } = load(now);
    applyIdle(state, now);
    if (!hatched) touchStreak(state, now);
    const card = renderStatus(state, now, hatched);
    state.lastSeenAt = now.toISOString();
    save(state);
    return text(card);
  },
);

server.registerTool(
  'buddy_observe',
  {
    title: 'Tell your buddy what you did',
    description:
      'Record a completed coding task. Grants XP, may trigger a level-up or evolution, and ' +
      'returns a personality-flavored reaction. Call this after writing code, fixing bugs, ' +
      'refactoring, running tests, or deploying. Pass a single plain sentence describing ' +
      'what was done. Show the returned reaction to the user.',
    inputSchema: {
      summary: z
        .string()
        .min(1)
        .max(500)
        .describe('One sentence describing what was just accomplished, e.g. "Fixed the off-by-one in the pagination cursor."'),
      kind: z
        .enum(OBSERVATION_KINDS)
        .optional()
        .describe('Optional category override. Inferred from the summary when omitted.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ summary, kind }) => {
    const now = new Date();
    const { state, hatched } = load(now);
    applyIdle(state, now);
    const result = observe(state, summary, now, kind);
    save(state);

    const card = renderObserve(state, result);
    // First contact ever: introduce the buddy before its first reaction.
    if (hatched) {
      const stage = stageFor(state.level);
      return text(`${stage.emoji} A buddy hatched to witness this.\n\n${card}`);
    }
    return text(card);
  },
);

server.registerTool(
  'buddy_rename',
  {
    title: 'Rename your buddy',
    description: "Change the buddy's name. Personality and progress are unaffected.",
    inputSchema: {
      name: z.string().min(1).max(32).describe('The new name.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ name }) => {
    const now = new Date();
    const { state } = load(now);
    const old = state.name;
    state.name = name.trim();
    state.milestones.push({ at: now.toISOString(), text: `Renamed from ${old} to ${state.name}.` });
    save(state);
    return text(`${stageFor(state.level).emoji} ${old} is now **${state.name}**.`);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — anything human-facing must go to stderr.
  process.stderr.write(`buddy-mcp ${VERSION} ready (state: ${statePath()})\n`);
}

main().catch((err) => {
  process.stderr.write(`buddy-mcp failed to start: ${String(err)}\n`);
  process.exit(1);
});
