import {
  absence,
  moodScore,
  moodTier,
  pickLine,
  recentMilestones,
  stageFor,
  xpForLevel,
} from './engine.js';
import type { ObserveResult } from './engine.js';
import { PERSONALITIES } from './personality.js';
import type { Advice, SkillAffinity, Suggestion, SkillStat } from './skills.js';
import type { BuddyState, MoodTier } from './types.js';

const MOOD_EMOJI: Record<MoodTier, string> = {
  radiant: '🤩',
  good: '😊',
  ok: '😐',
  low: '😕',
  bad: '😞',
};

function bar(fraction: number, width: number, full = '█', empty = '░'): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return full.repeat(filled) + empty.repeat(width - filled);
}

function daysSince(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function age(iso: string, now: Date): string {
  const d = daysSince(iso, now);
  return d === 0 ? 'born today' : `${plural(d, 'day')} old`;
}

export function renderStatus(
  state: BuddyState,
  now: Date,
  hatched: boolean,
  skills: SkillStat[] = [],
): string {
  const p = PERSONALITIES[state.personality];
  const stage = stageFor(state.level);
  const need = xpForLevel(state.level);
  const tier = moodTier(moodScore(state, now));

  if (hatched) {
    return [
      `${stage.emoji} Something hatched.`,
      '',
      `Meet **${state.name}** — a ${p.label} ${stage.name.toLowerCase()}, level 1.`,
      '',
      `> ${p.hatch}`,
    ].join('\n');
  }

  const lines = [
    `${stage.emoji} **${state.name}** the ${stage.name} · ${p.label}`,
    `Lv ${state.level}  ${bar(state.xp / need, 14)}  ${state.xp}/${need} xp`,
    `Mood  ${MOOD_EMOJI[tier]} ${p.moods[tier]}   ·   Energy ${bar(state.energy / 100, 10, '▓', '░')} ${Math.round(state.energy)}%`,
    `Streak ${plural(state.streak, 'day')} (best ${state.longestStreak}) · ${plural(state.observations, 'observation')} · ${age(state.bornAt, now)}`,
  ];

  if (skills.length > 0) {
    const used = skills.filter((s) => s.uses > 0).length;
    const favourite = skills.find((s) => s.uses > 0);
    lines.push(
      `Skills ${used}/${skills.length} used${favourite ? ` · most-used ${favourite.name} (${favourite.uses})` : ''}`,
    );
  }

  if (state.bio) {
    lines.push('', `_${state.bio}_`);
  }

  const recent = recentMilestones(state, 3);
  if (recent.length > 0) {
    lines.push('', `Recently: ${recent.map((m) => m.text.replace(/\.$/, '')).join(' · ')}`);
  }

  lines.push('', `> ${pickLine(p.status[absence(state, now)], state)}`);
  return lines.join('\n');
}

function firstSentence(text: string, max = 110): string {
  const first = text.split(/(?<=[.!?])\s/)[0] || text;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export function renderAdvice(state: BuddyState, kind: string, advice: Advice[]): string {
  if (advice.length === 0) {
    return `${state.name} doesn't know a skill that fits this (${kind}). Carry on unaided.`;
  }

  const lines = [`${state.name} suggests, for **${kind}** work:`, ''];
  advice.forEach((a, i) => {
    const pct = Math.round(a.score * 100);
    lines.push(`${i + 1}. \`${a.skill}\` — ${pct}% · ${a.reason}`);
    if (a.description) lines.push(`   ${firstSentence(a.description)}`);
  });

  const learned = advice.some((a) => a.kindUses > 0);
  if (!learned) {
    lines.push('', `_No ${kind} history yet — this ranking is from descriptions alone. It sharpens as you record skills_used._`);
  }
  return lines.join('\n');
}

export function renderAffinity(byKind: Record<string, SkillAffinity[]>): string {
  const kinds = Object.keys(byKind).filter((k) => byKind[k]!.length > 0);
  if (kinds.length === 0) return '';

  const lines = ['**What you reach for**'];
  for (const kind of kinds) {
    const top = byKind[kind]!.slice(0, 3);
    const rendered = top
      .map((a) => `${a.skill} ${Math.round(a.share * 100)}%`)
      .join(' · ');
    lines.push(`  ${kind.padEnd(9)} ${rendered}`);
  }
  return lines.join('\n');
}

export function renderSkills(
  stats: SkillStat[],
  byKind: Record<string, SkillAffinity[]> = {},
  uninstalled: string[] = [],
): string {
  if (stats.length === 0) {
    return 'No skills discovered yet. Install a plugin or add `.claude/skills/` to this project.';
  }

  const used = stats.filter((s) => s.uses > 0);
  const unused = stats.filter((s) => s.uses === 0);
  const width = Math.max(...stats.map((s) => s.name.length));
  const top = Math.max(1, ...stats.map((s) => s.uses));

  const line = (s: SkillStat) =>
    `  ${s.name.padEnd(width)}  ${bar(s.uses / top, 8, '▓', '░')} ${s.uses}`;

  const out = [`**Skills** — ${used.length} of ${stats.length} used`];
  if (used.length) out.push('', ...used.map(line));

  const affinity = renderAffinity(byKind);
  if (affinity) out.push('', affinity);

  if (unused.length) {
    out.push('', `Never used (${unused.length}): ${unused.map((s) => s.name).join(', ')}`);
  }
  if (uninstalled.length) {
    out.push(
      '',
      `⚠️  Cached but not installed, so Claude Code cannot invoke them: ${uninstalled.join(', ')}.`,
      `   They are excluded from advice. Add them to installed_plugins.json to use them.`,
    );
  }
  return out.join('\n');
}

function renderNudge(state: BuddyState, s: Suggestion): string {
  const first = s.description.split(/(?<=[.!?])\s/)[0] || s.description;
  const trimmed = first.length > 120 ? `${first.slice(0, 117)}…` : first;
  return `💡 ${state.name} noticed \`${s.skill}\` fits this${s.uses === 0 ? " and you've never used it" : ''} — ${trimmed}`;
}

export function renderObserve(state: BuddyState, result: ObserveResult, suggestion?: Suggestion | null): string {
  const p = PERSONALITIES[state.personality];
  const stage = stageFor(state.level);
  const need = xpForLevel(state.level);

  const lines = [
    `${stage.emoji} **${state.name}** · +${result.xpGained} xp (${result.kind})` +
      (result.firstToday ? ' · first of the day 🌅' : '') +
      `  →  Lv ${state.level}, ${state.xp}/${need}`,
  ];

  if (result.leveledTo !== null) {
    lines.push('', `🎉 **Level ${result.leveledTo}!**`);
    lines.push(`> ${pickLine(p.levelUp, state).replace('{level}', String(result.leveledTo))}`);
  }

  if (result.evolvedTo) {
    lines.push('', `✨ **Evolved into a ${result.evolvedTo.name}!** ${result.evolvedTo.emoji}`);
    lines.push(`> ${pickLine(p.evolve, state).replace('{stage}', result.evolvedTo.name)}`);
  }

  if (result.streak > 1 && result.firstToday) {
    lines.push('', `🔥 ${result.streak}-day streak.`);
  }

  lines.push('', `> ${result.reaction}`);
  if (result.tiredOut) lines.push('', `_${state.name} is running low on energy — they recover while you're away._`);
  if (suggestion) lines.push('', renderNudge(state, suggestion));

  return lines.join('\n');
}
