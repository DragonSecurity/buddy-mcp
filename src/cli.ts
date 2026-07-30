#!/usr/bin/env node
import { FIORA_DB, importFromFiora } from './import.js';
import { statePath } from './state.js';
import { PERSONALITY_IDS } from './types.js';
import type { PersonalityId } from './types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const cmd = process.argv[2];

  if (cmd !== 'import') {
    process.stdout.write(
      [
        'buddy-mcp',
        '',
        'Usage:',
        '  buddy-import import [--from <path>] [--personality <id>] [--force]',
        '',
        `  --from         source database (default: ${FIORA_DB})`,
        `  --personality  one of: ${PERSONALITY_IDS.join(', ')} (default: rolled)`,
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

  try {
    const r = importFromFiora({
      source: flag('from'),
      personality,
      force: process.argv.includes('--force'),
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
