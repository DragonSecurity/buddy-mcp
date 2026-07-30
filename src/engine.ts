import { PERSONALITIES } from './personality.js';
import { localDay } from './state.js';
import type {
  Absence,
  BuddyState,
  Milestone,
  MoodTier,
  ObservationKind,
  Stage,
} from './types.js';

export const STAGES: Stage[] = [
  { id: 'egg', name: 'Egg', emoji: '🥚', minLevel: 1 },
  { id: 'hatchling', name: 'Hatchling', emoji: '🐣', minLevel: 2 },
  { id: 'whelp', name: 'Whelp', emoji: '🦎', minLevel: 5 },
  { id: 'dragon', name: 'Dragon', emoji: '🐉', minLevel: 10 },
  { id: 'elder', name: 'Elder', emoji: '🐲', minLevel: 20 },
  { id: 'ascendant', name: 'Ascendant', emoji: '✨', minLevel: 35 },
];

export function stageFor(level: number): Stage {
  let current = STAGES[0]!;
  for (const s of STAGES) if (level >= s.minLevel) current = s;
  return current;
}

/** Gentle at first, then a real climb: 100 XP to level 2, ~1050 to level 10. */
export function xpForLevel(level: number): number {
  const n = Math.max(0, level - 1);
  return 100 + 60 * n + 8 * n * n;
}

const BASE_XP: Record<ObservationKind, number> = {
  deploy: 30,
  feature: 26,
  bugfix: 24,
  test: 22,
  refactor: 20,
  other: 18,
  docs: 16,
  config: 14,
};

/** Ordered most-specific first — "fixed the deploy config" should read as a fix. */
const KIND_PATTERNS: [ObservationKind, RegExp][] = [
  [
    'test',
    /\b(test|tests|testing|spec|specs|jest|vitest|pytest|mocha|coverage|assertion)\b/i,
  ],
  ['deploy', /\b(deploy|deployed|deploying|ship|shipped|release|released|publish|published|rollout|prod|production)\b/i],
  [
    'bugfix',
    /\b(fix|fixed|fixes|fixing|bug|bugs|patch|patched|repair|resolve|resolved|crash|crashed|error|errors|broke|broken|regression|debug|debugged|hotfix)\b/i,
  ],
  [
    'refactor',
    /\b(refactor|refactored|refactoring|clean|cleaned|cleanup|simplif\w*|rename|renamed|restructure|restructured|tidy|tidied|dedupe|deduplicate|extract|extracted|reorganiz\w*|reorganis\w*)\b/i,
  ],
  ['docs', /\b(doc|docs|document|documented|documentation|readme|comment|comments|changelog|guide)\b/i],
  [
    'config',
    /\b(config|configured|configuration|setup|set up|install|installed|dependency|dependencies|bump|bumped|upgrade|upgraded|ci|pipeline|lint|linting|tooling|scaffold)\b/i,
  ],
  [
    'feature',
    /\b(add|added|adds|implement|implemented|build|built|create|created|feature|new|wrote|write|support|introduc\w*)\b/i,
  ],
];

export function classify(summary: string): ObservationKind {
  for (const [kind, re] of KIND_PATTERNS) {
    if (re.test(summary)) return kind;
  }
  return 'other';
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function hoursSince(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, (now.getTime() - then) / 3_600_000);
}

/**
 * Time-travel step applied before every tool call: the buddy rests while you're
 * away, and starts to feel neglected if you stay away too long.
 */
export function applyIdle(state: BuddyState, now: Date): void {
  const idle = hoursSince(state.lastSeenAt, now);
  state.energy = clamp(state.energy + idle * 10, 0, 100);
}

export function moodScore(state: BuddyState, now: Date): number {
  const idle = hoursSince(state.lastSeenAt, now);
  const neglect = idle > 18 ? Math.min(85, (idle - 18) * 1.2) : 0;
  // A streak only cheers the buddy up while you're actually keeping it.
  const streakBonus = idle < 24 ? Math.min(15, state.streak * 3) : 0;
  const drained = state.energy < 30 ? (30 - state.energy) * 0.5 : 0;
  return clamp(100 - neglect + streakBonus - drained, 0, 100);
}

export function moodTier(score: number): MoodTier {
  if (score >= 85) return 'radiant';
  if (score >= 65) return 'good';
  if (score >= 45) return 'ok';
  if (score >= 25) return 'low';
  return 'bad';
}

export function absence(state: BuddyState, now: Date): Absence {
  const idle = hoursSince(state.lastSeenAt, now);
  if (idle < 24) return 'fresh';
  if (idle < 72) return 'neglected';
  return 'long';
}

/** Picks a line, rerolling once to avoid saying the same thing twice running. */
export function pickLine(pool: string[], state: BuddyState): string {
  if (pool.length === 0) return '';
  let line = pool[Math.floor(Math.random() * pool.length)]!;
  if (line === state.lastReaction && pool.length > 1) {
    line = pool[Math.floor(Math.random() * pool.length)]!;
  }
  return line;
}

function addMilestone(state: BuddyState, now: Date, text: string): void {
  state.milestones.push({ at: now.toISOString(), text });
  if (state.milestones.length > 40) state.milestones = state.milestones.slice(-40);
}

/** Rolls the daily streak forward. Returns true if this is the first visit today. */
export function touchStreak(state: BuddyState, now: Date): boolean {
  const today = localDay(now);
  if (state.lastSeenDay === today) return false;

  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  state.streak = state.lastSeenDay === localDay(yesterday) ? state.streak + 1 : 1;
  state.longestStreak = Math.max(state.longestStreak, state.streak);
  state.lastSeenDay = today;
  return true;
}

export interface ObserveResult {
  kind: ObservationKind;
  xpGained: number;
  firstToday: boolean;
  streak: number;
  leveledTo: number | null;
  evolvedTo: Stage | null;
  reaction: string;
  tiredOut: boolean;
}

export function observe(
  state: BuddyState,
  summary: string,
  now: Date,
  kindOverride?: ObservationKind,
): ObserveResult {
  const kind = kindOverride ?? classify(summary);
  touchStreak(state, now);

  // Keyed off lastObservedDay, not lastSeenDay, so a buddy_status check-in
  // earlier in the day doesn't quietly spend this bonus.
  const today = localDay(now);
  const firstToday = state.lastObservedDay !== today;
  state.lastObservedDay = today;

  // A drained buddy learns less, but never nothing.
  const energyMult = 0.7 + 0.3 * (state.energy / 100);
  const streakMult = 1 + Math.min(0.5, state.streak * 0.1);
  const base = BASE_XP[kind] + (firstToday ? 25 : 0);
  const xpGained = Math.max(1, Math.round(base * energyMult * streakMult));

  const stageBefore = stageFor(state.level);
  state.xp += xpGained;
  state.totalXp += xpGained;
  state.observations += 1;
  // Counts are rebuilt from a GROUP BY, so a kind with no events is absent
  // rather than zero — `+= 1` on undefined would silently produce NaN.
  state.kindCounts[kind] = (state.kindCounts[kind] ?? 0) + 1;
  state.energy = clamp(state.energy - 4, 0, 100);

  let leveledTo: number | null = null;
  // `while`, not `if` — one observation can carry an idle buddy up two levels.
  while (state.xp >= xpForLevel(state.level)) {
    state.xp -= xpForLevel(state.level);
    state.level += 1;
    leveledTo = state.level;
  }

  const stageAfter = stageFor(state.level);
  const evolvedTo = stageAfter.id !== stageBefore.id ? stageAfter : null;

  if (leveledTo !== null) addMilestone(state, now, `Reached level ${leveledTo}.`);
  if (evolvedTo) addMilestone(state, now, `Evolved into a ${evolvedTo.name}. ${evolvedTo.emoji}`);

  const p = PERSONALITIES[state.personality];
  const tiredOut = state.energy < 25;
  const reaction = pickLine(tiredOut ? p.tired : p.lines[kind], state);
  state.lastReaction = reaction;
  state.lastSeenAt = now.toISOString();

  return {
    kind,
    xpGained,
    firstToday,
    streak: state.streak,
    leveledTo,
    evolvedTo,
    reaction,
    tiredOut,
  };
}

export function recentMilestones(state: BuddyState, n: number): Milestone[] {
  return state.milestones.slice(-n).reverse();
}
