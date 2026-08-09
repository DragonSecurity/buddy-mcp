export const PERSONALITY_IDS = ['snarky', 'cheerful', 'stoic', 'gremlin', 'zen'] as const;
export type PersonalityId = (typeof PERSONALITY_IDS)[number];

export const OBSERVATION_KINDS = [
  'bugfix',
  'feature',
  'refactor',
  'test',
  'deploy',
  'docs',
  'config',
  'other',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export type MoodTier = 'radiant' | 'good' | 'ok' | 'low' | 'bad';

/** How long it's been since the buddy last saw you. Drives the status quip. */
export type Absence = 'fresh' | 'neglected' | 'long';

export interface Milestone {
  at: string;
  text: string;
}

export interface BuddyState {
  version: 1;
  name: string;
  personality: PersonalityId;
  /** Original free-text description, for rescued buddies. Empty otherwise. */
  bio: string;
  bornAt: string;
  level: number;
  /** XP banked toward the next level, not lifetime total. */
  xp: number;
  totalXp: number;
  energy: number;
  streak: number;
  longestStreak: number;
  lastSeenAt: string;
  /**
   * When work was last recorded, as opposed to when the buddy was last spoken
   * to. Energy resets off this rather than `lastSeenAt`, because there is one
   * server per Claude Code session and any one of them checking in refreshes
   * `lastSeenAt` for all of them — which made the break that restores energy
   * something only a total quiet across every open session could produce.
   */
  lastObservedAt: string;
  /** Local-time YYYY-MM-DD, so streaks follow the user's calendar, not UTC. */
  lastSeenDay: string;
  /**
   * Tracked separately from `lastSeenDay`: checking in with buddy_status keeps
   * the streak alive but must not consume the first-observation-of-the-day bonus.
   */
  lastObservedDay: string;
  observations: number;
  kindCounts: Record<ObservationKind, number>;
  milestones: Milestone[];
  lastReaction: string;
}

export interface Stage {
  id: string;
  name: string;
  emoji: string;
  minLevel: number;
}
