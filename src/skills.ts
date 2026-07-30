import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getDb } from './db.js';

export interface Skill {
  /** Qualified name as the user would type it, e.g. `cloudflare:wrangler`. */
  name: string;
  source: string;
  description: string;
}

export interface SkillStat extends Skill {
  uses: number;
  lastUsedAt: number | null;
}

export interface Suggestion {
  skill: string;
  description: string;
  uses: number;
  score: number;
}

function readFrontmatter(file: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};

  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function dirsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((d) => {
      try {
        return statSync(join(dir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function collect(skillsDir: string, source: string, qualify: (skill: string) => string): Skill[] {
  const out: Skill[] = [];
  for (const skill of dirsIn(skillsDir)) {
    const fm = readFrontmatter(join(skillsDir, skill, 'SKILL.md'));
    if (!fm.name && !fm.description) continue;
    out.push({
      name: qualify(fm.name || skill),
      source,
      description: fm.description || '',
    });
  }
  return out;
}

/**
 * Skills live in three places: installed plugins, the user's personal skills
 * dir, and the current project. All three are optional.
 */
export function discoverSkills(cwd: string = process.cwd()): Skill[] {
  const found = new Map<string, Skill>();
  const add = (s: Skill) => {
    if (!found.has(s.name)) found.set(s.name, s);
  };

  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/
  const cache = join(homedir(), '.claude', 'plugins', 'cache');
  for (const marketplace of dirsIn(cache)) {
    for (const plugin of dirsIn(join(cache, marketplace))) {
      for (const version of dirsIn(join(cache, marketplace, plugin))) {
        const dir = join(cache, marketplace, plugin, version, 'skills');
        for (const s of collect(dir, `plugin:${plugin}`, (n) => `${plugin}:${n}`)) add(s);
      }
    }
  }

  for (const s of collect(join(homedir(), '.claude', 'skills'), 'personal', (n) => n)) add(s);
  for (const s of collect(join(cwd, '.claude', 'skills'), 'project', (n) => n)) add(s);

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Upserts the registry, preserving usage counters for skills already known. */
export function syncSkills(skills: Skill[], now: Date): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO skills (name, source, description, first_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET source = excluded.source, description = excluded.description`,
  );
  for (const s of skills) insert.run(s.name, s.source, s.description, now.getTime());
}

export function recordSkillUses(names: string[], kind: string, now: Date): void {
  const db = getDb();
  const use = db.prepare('INSERT INTO skill_uses (skill, at, kind) VALUES (?, ?, ?)');
  const bump = db.prepare(
    'UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE name = ?',
  );
  const ensure = db.prepare(
    "INSERT OR IGNORE INTO skills (name, source, description, first_seen) VALUES (?, 'reported', '', ?)",
  );
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    ensure.run(name, now.getTime());
    use.run(name, now.getTime(), kind);
    bump.run(now.getTime(), name);
  }
}

export function skillStats(): SkillStat[] {
  return (
    getDb()
      .prepare('SELECT name, source, description, uses, last_used_at FROM skills ORDER BY uses DESC, name ASC')
      .all() as { name: string; source: string; description: string; uses: number; last_used_at: number | null }[]
  ).map((r) => ({
    name: r.name,
    source: r.source,
    description: r.description,
    uses: Number(r.uses),
    lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
  }));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'was', 'were', 'has', 'have',
  'add', 'added', 'fix', 'fixed', 'use', 'used', 'using', 'new', 'all', 'out', 'get', 'set',
  'run', 'ran', 'now', 'not', 'but', 'its', 'our', 'you', 'your', 'via', 'per', 'off', 'onto',
  'code', 'file', 'files', 'make', 'made', 'work', 'working', 'update', 'updated', 'change',
  'changed', 'some', 'more', 'then', 'than', 'when', 'what', 'each', 'also', 'just', 'like',
]);

/**
 * Crude suffix stripping so "dashboards" in a skill description matches
 * "dashboard" in a task summary. Both sides are stemmed the same way, so the
 * stems only ever have to agree with each other, never be real words.
 */
function stem(token: string): string {
  if (token.length <= 4) return token;
  return token
    .replace(/ies$/, 'y')
    .replace(/(?:ing|ed|es|s)$/, '');
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Scores a skill against a task summary by token overlap, weighting the skill's
 * own name far above its description — a name hit is a near-certain match,
 * whereas descriptions are long and match loosely.
 */
export function scoreSkill(skill: Skill, summary: string): number {
  const want = new Set(tokens(summary));
  if (want.size === 0) return 0;

  const nameTokens = new Set(tokens(skill.name.replace(/[:\-_]/g, ' ')));
  const descTokens = new Set(tokens(skill.description));

  let score = 0;
  for (const t of want) {
    if (nameTokens.has(t)) score += 3;
    else if (descTokens.has(t)) score += 1;
  }
  return score;
}

// One name hit (3) clears this outright; otherwise two description hits are
// needed, so a single incidental word never triggers a suggestion.
const MIN_SCORE = 2;
const MAX_NUDGES = 3;
const RECENTLY_USED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Picks a skill worth mentioning: relevant to what was just done, not already
 * used for it, not used recently, and not something we've nagged about before.
 */
export function suggestSkill(
  summary: string,
  usedNow: string[],
  now: Date,
): Suggestion | null {
  const db = getDb();
  const used = new Set(usedNow.map((s) => s.trim()));

  const rows = db
    .prepare('SELECT name, source, description, uses, last_used_at FROM skills')
    .all() as { name: string; source: string; description: string; uses: number; last_used_at: number | null }[];

  const nudged = new Map(
    (db.prepare('SELECT skill, count FROM nudges').all() as { skill: string; count: number }[]).map(
      (n) => [n.skill, Number(n.count)],
    ),
  );

  let best: Suggestion | null = null;
  for (const r of rows) {
    if (used.has(r.name)) continue;
    if ((nudged.get(r.name) ?? 0) >= MAX_NUDGES) continue;
    if (r.last_used_at !== null && now.getTime() - Number(r.last_used_at) < RECENTLY_USED_MS) continue;

    const score = scoreSkill({ name: r.name, source: r.source, description: r.description }, summary);
    if (score < MIN_SCORE) continue;
    if (!best || score > best.score) {
      best = { skill: r.name, description: r.description, uses: Number(r.uses), score };
    }
  }

  if (best) {
    db.prepare(
      `INSERT INTO nudges (skill, count, at) VALUES (?, 1, ?)
       ON CONFLICT(skill) DO UPDATE SET count = count + 1, at = excluded.at`,
    ).run(best.skill, now.getTime());
  }
  return best;
}
