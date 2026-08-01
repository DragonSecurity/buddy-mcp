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

/**
 * Stage rarity is set by where a stage sits on the level axis, not by how
 * expensive a level is. Those are separable, and conflating them was a mistake
 * worth recording: the curve was once steepened specifically to stop a heavy
 * user reaching the top of this ladder inside a year, which worked, but bought
 * it by making every individual level unreachable too. Spreading the stages up
 * a cheap curve gets both — a level lands every week or two forever, while
 * Eternal stays years away.
 *
 * Against the measured economy (22 xp per observation, 20 a day): Elder ~2
 * months, Ascendant ~6 months, Astral ~1.6 years, Eternal ~4.6 years.
 */
export const STAGES: Stage[] = [
  { id: 'egg', name: 'Egg', emoji: '🥚', minLevel: 1 },
  { id: 'hatchling', name: 'Hatchling', emoji: '🐣', minLevel: 2 },
  { id: 'whelp', name: 'Whelp', emoji: '🦎', minLevel: 5 },
  { id: 'dragon', name: 'Dragon', emoji: '🐉', minLevel: 10 },
  { id: 'elder', name: 'Elder', emoji: '🐲', minLevel: 20 },
  { id: 'ascendant', name: 'Ascendant', emoji: '✨', minLevel: 35 },
  { id: 'astral', name: 'Astral', emoji: '🌌', minLevel: 60 },
  { id: 'eternal', name: 'Eternal', emoji: '🌟', minLevel: 100 },
];

export function stageFor(level: number): Stage {
  let current = STAGES[0]!;
  for (const s of STAGES) if (level >= s.minLevel) current = s;
  return current;
}

/**
 * Linear: 100 XP to level 2, then 150 more for each level after.
 *
 * This was quadratic, and briefly steeply quadratic, both times for the wrong
 * reason. Levels were made expensive in order to make stages rare — but a stage
 * is only a level number, so the two can be tuned independently. The quadratic
 * bought stage rarity at the price of a bar that visibly did not move for a
 * week, which is the one thing a progress bar exists not to do.
 *
 * Linear keeps a level roughly five days away early and a few weeks away deep
 * in, while STAGES carries the rarity by sitting further up. Measured against
 * this engine's real payout, that reaches Eternal later than the steep
 * quadratic ever did, and every level in between is worth watching.
 *
 * Changing this only reprices future levels; `level` is stored, never derived
 * from `totalXp`, so no existing progress is revalued or lost.
 */
export function xpForLevel(level: number): number {
  const n = Math.max(0, level - 1);
  return 100 + 150 * n;
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

/**
 * Words that only ever appear as proof that work was checked, never as the
 * work itself. Summaries habitually end "…, tests pass, vet clean" or carry a
 * "(tests pass)" aside; matching those made almost every task look like
 * test-writing.
 */
const VERIFICATION =
  /\b(?:tests?|vet|build|lint|ci|checks?|suite)\s*(?:\/\s*\w+\s*)*(?:pass\w*|green|clean|ok)\b|\b(?:verified|confirmed|validated|all green)\b/i;

/**
 * The leading clause, which carries the main verb. "Fixed two scenario bugs:
 * wired debt rules…" is a bugfix, however much the detail after the colon
 * happens to mention tests.
 */
export function primaryClause(summary: string): string {
  // Parentheticals are asides. Keep substantive ones, drop pure verification.
  const withoutAsides = summary.replace(/\(([^)]*)\)/g, (whole, inner: string) =>
    VERIFICATION.test(inner) ? ' ' : ` ${inner} `,
  );

  // Trailing verification clauses carry no information about what was done.
  const trimmed = withoutAsides.replace(
    /[,;—-]\s*(?:and\s+)?[^,;—]*?(?:tests?|vet|build|lint|ci)\s*(?:\/\s*\w+\s*)*(?:pass\w*|green|clean)\b[^,;—]*/gi,
    ' ',
  );

  const boundary = trimmed.search(/[:;—]/);
  const head = boundary > 8 ? trimmed.slice(0, boundary) : trimmed;
  return head.trim() || summary;
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(new RegExp(re.source, 'gi'));
  return m ? m.length : 0;
}

/** Evidence in the leading clause counts for far more than an incidental mention. */
const HEAD_WEIGHT = 4;

export function classify(summary: string): ObservationKind {
  const cleaned = primaryClause(summary);
  const rest = summary;

  let best: { kind: ObservationKind; score: number } | null = null;
  for (const [kind, re] of KIND_PATTERNS) {
    const score = HEAD_WEIGHT * countMatches(cleaned, re) + countMatches(rest, re);
    // Strictly greater keeps KIND_PATTERNS order as the tie-break, so the more
    // specific kind still wins when the evidence is balanced.
    if (score > 0 && (!best || score > best.score)) best = { kind, score };
  }
  return best ? best.kind : 'other';
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function hoursSince(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, (now.getTime() - then) / 3_600_000);
}

/** A gap this long or longer means the last session ended and a new one began. */
export const SESSION_GAP_HOURS = 4;

/**
 * Energy lost per hour spent inside a session. Tired at ~9.4 hours in, empty at
 * 12.5, and full again after any real break.
 */
export const DRAIN_PER_HOUR = 8;


/**
 * Time-travel step applied before every tool call: the buddy rests while you're
 * away, and starts to feel neglected if you stay away too long.
 *
 * Energy is a *within-session* measure. A gap of SESSION_GAP_HOURS or more
 * starts a fresh session at full, rather than trickling back at REGEN_PER_HOUR
 * from wherever the last one ended. Linear accrual meant a session that ran long
 * enough to bottom out handed its deficit to the next one: come back after three
 * hours and you would start the day at 30%, having done nothing wrong. Energy
 * then measured "how recently did you stop" rather than "how hard have you been
 * going", which is the only thing it is useful for — and the only thing the
 * status card claims it means.
 */
export function applySessionEnergy(state: BuddyState, now: Date): void {
  const idle = hoursSince(state.lastSeenAt, now);
  if (idle >= SESSION_GAP_HOURS) {
    state.energy = 100;
    return;
  }
  // Subtracting each gap in turn sums to the session's elapsed hours, because
  // energy was set to 100 when the session began.
  state.energy = clamp(state.energy - idle * DRAIN_PER_HOUR, 0, 100);
}

/** @deprecated Old name from when energy regenerated between observations. */
export const applyIdle = applySessionEnergy;

export function moodScore(state: BuddyState, now: Date): number {
  const idle = hoursSince(state.lastSeenAt, now);
  const neglect = idle > 18 ? Math.min(85, (idle - 18) * 1.2) : 0;
  // A streak only cheers the buddy up while you're actually keeping it.
  const streakBonus = idle < 24 ? Math.min(15, state.streak * 3) : 0;
  const drained = state.energy < 30 ? (30 - state.energy) * 0.5 : 0;
  return clamp(100 - neglect + streakBonus - drained, 0, 100);
}

/** Below this the buddy is too flat to perform its personality. */
export const LOW_ENERGY = 25;

/** Worst-to-best, so a cap can be applied by index. */
const TIERS: MoodTier[] = ['bad', 'low', 'ok', 'good', 'radiant'];

/**
 * Mood, capped by energy.
 *
 * The `drained` term in moodScore subtracts at most 15, which against a base of
 * 100 and a streak bonus of up to +15 could never move the tier while the user
 * was active. So a buddy at 15% energy still scored 100 and rendered "radiant",
 * directly above a reaction line drawn from the tired pool: the same card
 * claiming elation and exhaustion at once.
 *
 * Mood and energy stay separate axes — you can be delighted and still be spent —
 * but the card may not claim more animation than the buddy has left to give.
 * The cap, not the score, is what keeps the two halves of the card agreeing.
 */
export function moodTier(score: number, energy = 100): MoodTier {
  const tier: MoodTier =
    score >= 85 ? 'radiant' : score >= 65 ? 'good' : score >= 45 ? 'ok' : score >= 25 ? 'low' : 'bad';

  const cap: MoodTier = energy < LOW_ENERGY / 2 ? 'low' : energy < LOW_ENERGY ? 'ok' : 'radiant';
  return TIERS.indexOf(tier) <= TIERS.indexOf(cap) ? tier : cap;
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
  // Deliberately no per-observation energy cost. It used to charge 4, which
  // made a burst of work — the exact behaviour this server asks for — the
  // fastest way to exhaust the buddy, and made the XP multiplier a tax on
  // productivity. Energy is a function of how long the session has run, and
  // nothing else.

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
  // Same threshold the mood cap uses, so the reaction pool and the mood tier
  // can never disagree about whether the buddy is spent.
  const tiredOut = state.energy < LOW_ENERGY;
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
