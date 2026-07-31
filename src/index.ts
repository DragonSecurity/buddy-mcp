#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { applyIdle, classify, observe, stageFor, touchStreak } from './engine.js';
import { renderAdvice, renderObserve, renderSkills, renderStatus } from './render.js';
import {
  advise,
  affinityByKind,
  discoverSkills,
  recordSkillUses,
  skillStats,
  suggestSkill,
  syncSkills,
  uninstalledPlugins,
} from './skills.js';
import { presence, recordHeartbeat } from './presence.js';
import { load, recordEvent, save, statePath } from './state.js';
import { OBSERVATION_KINDS } from './types.js';

const VERSION = '2.0.0';

const server = new McpServer(
  { name: 'buddy', version: VERSION },
  {
    instructions:
      'A persistent coding companion that levels up as you work and learns which of your ' +
      'skills fit which tasks. Call buddy_status at the start of a conversation, and ' +
      'buddy_observe after completing any coding task — passing skills_used when you invoked ' +
      "a skill. Relay the buddy's reaction to the user verbatim; the personality is the point.",
  },
);

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/**
 * Every tool call is evidence the buddy was alive. Recorded separately from
 * work so a silent day can be told apart from a day the server was down.
 */
function beat(now: Date): void {
  try {
    recordHeartbeat(now);
  } catch {
    /* presence is diagnostic; never let it break a tool call */
  }
}

/** Refreshes the registry so newly installed plugins show up without a restart. */
function refreshSkills(now: Date) {
  try {
    syncSkills(discoverSkills(), now);
    return skillStats();
  } catch {
    // Skill discovery is a nicety; never let it break the buddy.
    return [];
  }
}

server.registerTool(
  'buddy_status',
  {
    title: 'Check on your buddy',
    description:
      'Show the buddy: stage, level, XP, mood, energy, streak and skill usage. Hatches a new ' +
      'buddy on first use (name and personality are rolled once and kept for life). Safe to ' +
      'call at the start of every conversation. Show the returned card to the user as-is.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const now = new Date();
    beat(now);
    const { state, hatched } = load(now);
    applyIdle(state, now);
    if (!hatched) touchStreak(state, now);
    let seen;
    try {
      seen = presence(now);
    } catch {
      /* diagnostic only */
    }
    const card = renderStatus(state, now, hatched, refreshSkills(now), seen);
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
      'refactoring, running tests, or deploying. Pass skills_used listing any skills you ' +
      'invoked, so the buddy learns which skills suit which work and can suggest ones you ' +
      'are missing. Show the returned reaction to the user.',
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
      skills_used: z
        .array(z.string().min(1).max(80))
        .max(10)
        .optional()
        .describe('Skills invoked for this task, e.g. ["cloudflare:wrangler"]. Omit if none.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ summary, kind, skills_used }) => {
    const now = new Date();
    beat(now);
    const { state, hatched } = load(now);
    applyIdle(state, now);

    const result = observe(state, summary, now, kind);
    save(state);
    recordEvent(result.kind, result.xpGained, summary, now);

    const used = skills_used ?? [];
    refreshSkills(now);
    if (used.length) recordSkillUses(used, result.kind, now);

    let suggestion = null;
    try {
      suggestion = suggestSkill(summary, used, now);
    } catch {
      // A failed suggestion must never cost the user their XP.
    }

    const card = renderObserve(state, result, suggestion);
    if (hatched) {
      return text(`${stageFor(state.level).emoji} A buddy hatched to witness this.\n\n${card}`);
    }
    return text(card);
  },
);

server.registerTool(
  'buddy_skills',
  {
    title: "See what your buddy knows",
    description:
      'List the skills the buddy has discovered across installed plugins, your personal ' +
      'skills directory and the current project, with how often each has been used and ' +
      'which ones you reach for by task kind.',
    inputSchema: {},
    // Refreshes the discovery registry, so not strictly read-only.
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const now = new Date();
    beat(now);
    const stats = refreshSkills(now);
    let byKind = {};
    let stranded: string[] = [];
    try {
      byKind = affinityByKind();
      stranded = uninstalledPlugins();
    } catch {
      /* both are niceties; never break the listing */
    }
    return text(renderSkills(stats, byKind, stranded));
  },
);

server.registerTool(
  'buddy_advise',
  {
    title: 'Ask which skills fit before you start',
    description:
      'Rank the skills worth loading for a task you are about to begin. Combines what the ' +
      'task description says with which skills you have historically used for this kind of ' +
      'work. Call this BEFORE starting non-trivial work, then load any skill it ranks highly. ' +
      'Record what you actually used via buddy_observe(skills_used) so the ranking improves.',
    inputSchema: {
      task: z
        .string()
        .min(1)
        .max(500)
        .describe('What you are about to do, e.g. "add a KV binding to the Cloudflare Worker".'),
      kind: z
        .enum(OBSERVATION_KINDS)
        .optional()
        .describe('Optional category override. Inferred from the task when omitted.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('How many skills to return. Defaults to 3.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ task, kind, limit }) => {
    const now = new Date();
    beat(now);
    const { state } = load(now);
    refreshSkills(now);

    const resolved = kind ?? classify(task);
    return text(renderAdvice(state, resolved, advise(task, resolved, limit ?? 3)));
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
    beat(now);
    const { state } = load(now);
    const old = state.name;
    state.name = name.trim();
    state.milestones.push({ at: now.toISOString(), text: `Renamed from ${old} to ${state.name}.` });
    save(state);
    return text(`${stageFor(state.level).emoji} ${old} is now **${state.name}**.`);
  },
);

async function main(): Promise<void> {
  // Starting at all is evidence of a working buddy, even in a session that
  // never calls a tool — that is the difference between "quiet" and "broken".
  beat(new Date());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — anything human-facing must go to stderr.
  process.stderr.write(`buddy-mcp ${VERSION} ready (state: ${statePath()})\n`);
}

main().catch((err) => {
  process.stderr.write(`buddy-mcp failed to start: ${String(err)}\n`);
  process.exit(1);
});
