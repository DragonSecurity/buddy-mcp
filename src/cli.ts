#!/usr/bin/env node
import { backfillFromTranscripts, TRANSCRIPT_ROOT } from './backfill.js';
import { CLAUDE_JSON, FIORA_DB, importFromFiora, rescueOriginal } from './import.js';
import { DEFAULT_HOST, DEFAULT_PORT, serve } from './serve.js';
import { statePath } from './state.js';
import { PERSONALITY_IDS } from './types.js';
import type { PersonalityId } from './types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const cmd = process.argv[2];

  if (cmd === 'serve') {
    const port = Number(flag('port') ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write(`Invalid --port "${flag('port')}". Expected 1-65535.\n`);
      process.exit(1);
    }
    const host = flag('host') ?? DEFAULT_HOST;

    serve({ port, host }).then(
      (server) => {
        process.stdout.write(
          [
            `buddy-mcp serve — read-only status on http://${host}:${port}/status`,
            `  reading ${statePath()}`,
            host === DEFAULT_HOST
              ? '  bound to loopback; pass --host 0.0.0.0 to reach it from the LAN'
              : `  bound to ${host} — reachable from the LAN, and unauthenticated`,
            '',
          ].join('\n'),
        );
        const stop = () => server.close(() => process.exit(0));
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Could not listen on ${host}:${port} — ${msg}\n`);
        process.exit(1);
      },
    );
    return;
  }

  if (cmd === 'backfill') {
    const tolerance = Number(flag('tolerance') ?? 120);
    const r = backfillFromTranscripts({
      root: flag('from'),
      toleranceMs: Math.max(1, tolerance) * 1000,
      dryRun: process.argv.includes('--dry-run'),
    });
    process.stdout.write(
      [
        r.dryRun ? 'Backfill (dry run — nothing written)' : 'Backfill complete',
        '',
        `  transcript observations  ${r.transcriptObservations}`,
        `  generic events           ${r.candidateEvents}`,
        `  matched within ${tolerance}s${' '.repeat(Math.max(1, 10 - String(tolerance).length))}${r.matched}`,
        r.dryRun ? '' : `  events relabelled        ${r.updated}`,
        `  still generic            ${r.stillGeneric}  (no surviving transcript)`,
        '',
        'Recovered kinds:',
        ...Object.entries(r.kinds)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`),
        '',
        'XP is left exactly as awarded — only the labels are restored.',
        '',
      ]
        .filter((l) => l !== '')
        .join('\n') + '\n',
    );
    return;
  }

  if (cmd !== 'import' && cmd !== 'rescue') {
    process.stdout.write(
      [
        'buddy-mcp',
        '',
        'Usage:',
        '  buddy-import import [--from <path>] [--personality <id>] [--force]',
        '  buddy-import rescue [--identity <path>] [--events <path|none>]',
        '                      [--personality <id>] [--force]',
        '  buddy-import backfill [--dry-run] [--tolerance <seconds>] [--from <dir>]',
        '  buddy-import serve [--port <n>] [--host <addr>]',
        '',
        'serve    Expose the buddy read-only over HTTP, for a display or',
        '         dashboard to poll. Never writes — polling it does not keep',
        '         the buddy awake or feed its streak.',
        `  --port         listen port (default: ${DEFAULT_PORT})`,
        `  --host         bind address (default: ${DEFAULT_HOST}, loopback only)`,
        '                 use 0.0.0.0 to reach it from the LAN — unauthenticated',
        '',
        'backfill Recover real task descriptions for imported history by',
        "         matching Claude Code's transcripts to stored events by time.",
        `  --from         transcript root (default: ${TRANSCRIPT_ROOT})`,
        '  --tolerance    match window in seconds (default: 120)',
        '  --dry-run      report what would change, write nothing',
        '',
        'import   Move a @fiorastudio/buddy companion in.',
        `  --from         source database (default: ${FIORA_DB})`,
        '',
        "rescue   Restore the companion Anthropic's /buddy left behind, and",
        '         optionally graft on a later buddy\'s XP history.',
        `  --identity     original record (default: ${CLAUDE_JSON})`,
        `  --events       history to graft on, or "none" (default: ${FIORA_DB})`,
        '',
        'Both:',
        `  --personality  one of: ${PERSONALITY_IDS.join(', ')}`,
        '                 (rescue infers it from the original bio when omitted)',
        '  --force        replace an existing buddy',
        '',
      ].join('\n'),
    );
    process.exit(cmd ? 1 : 0);
  }

  const personality = flag('personality') as PersonalityId | undefined;
  if (personality && !PERSONALITY_IDS.includes(personality)) {
    process.stderr.write(`Unknown personality "${personality}". Choose from: ${PERSONALITY_IDS.join(', ')}\n`);
    process.exit(1);
  }

  const force = process.argv.includes('--force');

  try {
    if (cmd === 'rescue') {
      const eventsFlag = flag('events');
      const r = rescueOriginal({
        identityFrom: flag('identity'),
        eventsFrom: eventsFlag === 'none' ? null : eventsFlag,
        personality,
        force,
      });
      process.stdout.write(
        [
          `Rescued ${r.name}.`,
          '',
          `  born        ${r.bornAt}`,
          `  level       ${r.level}  (${r.totalXp} lifetime xp)`,
          `  events      ${r.events}${r.eventsSource ? ` grafted from ${r.eventsSource}` : ''}`,
          `  streak      ${r.longestStreak} days (reconstructed)`,
          `  personality ${r.personality}${r.personalityInferred ? ' (inferred from the original bio)' : ''}`,
          r.bio ? `\nOriginal description:\n  ${r.bio}` : '',
          `\nIdentity from ${r.identitySource}`,
          `Stored at ${statePath()}`,
          '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }

    const r = importFromFiora({
      source: flag('from'),
      personality,
      force,
    });
    process.stdout.write(
      [
        `Imported ${r.name} — level ${r.level}, ${r.totalXp} lifetime xp, ${r.events} events.`,
        `Born ${r.bornAt.slice(0, 10)}. Longest streak reconstructed: ${r.longestStreak} days.`,
        `Personality: ${r.personality}.`,
        r.bio ? `\nPrevious bio:\n  ${r.bio}` : '',
        `\nStored at ${statePath()}`,
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  } catch (err) {
    process.stderr.write(`Import failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
