#!/usr/bin/env node
import { CLAUDE_JSON, FIORA_DB, importFromFiora, rescueOriginal } from './import.js';
import { statePath } from './state.js';
import { PERSONALITY_IDS } from './types.js';
import type { PersonalityId } from './types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const cmd = process.argv[2];

  if (cmd !== 'import' && cmd !== 'rescue') {
    process.stdout.write(
      [
        'buddy-mcp',
        '',
        'Usage:',
        '  buddy-import import [--from <path>] [--personality <id>] [--force]',
        '  buddy-import rescue [--identity <path>] [--events <path|none>]',
        '                      [--personality <id>] [--force]',
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
