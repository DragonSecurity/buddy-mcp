import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getDb } from './db.js';

export interface Skill {
  /** Qualified name as the user would type it, e.g. `cloudflare:wrangler`. */
  name: string;
  source: string;
  description: string;
  /**
   * Project this skill belongs to, or '' when globally available.
   * Plugin and personal skills are global; ./.claude/skills is not.
   */
  projectRoot: string;
}

/** The project the server was launched in — Claude Code spawns it per workspace. */
export function currentProject(): string {
  return process.cwd();
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

/**
 * Frontmatter is third-party text that ends up rendered into the model's
 * context, so it is clamped here rather than at each render site. Doing it at
 * the parse boundary means every consumer — registry, advice, nudges, the
 * skills table — inherits the bound without having to remember it.
 */
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 200;

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
  if (out.name !== undefined) out.name = out.name.slice(0, MAX_SKILL_NAME);
  if (out.description !== undefined) {
    out.description = out.description.slice(0, MAX_SKILL_DESCRIPTION);
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

function collect(
  skillsDir: string,
  source: string,
  qualify: (skill: string) => string,
  projectRoot = '',
): Skill[] {
  const out: Skill[] = [];
  for (const skill of dirsIn(skillsDir)) {
    const fm = readFrontmatter(join(skillsDir, skill, 'SKILL.md'));
    if (!fm.name && !fm.description) continue;
    out.push({
      name: qualify(fm.name || skill),
      source,
      description: fm.description || '',
      projectRoot,
    });
  }
  return out;
}

export interface PluginManifest {
  /** Plugin names Claude Code will actually load. Empty when unreadable. */
  installed: Set<string>;
  /** False when the manifest is missing, malformed, or not the shape we expect. */
  readable: boolean;
}

/**
 * Plugin names Claude Code will actually load, from installed_plugins.json.
 * A plugin can sit in the cache without being installed — its skills exist on
 * disk but `Skill` refuses to invoke them, so recommending one is a dead end.
 *
 * An unreadable manifest yields an EMPTY set, not a missing gate. This used to
 * return null and callers treated null as "don't gate", on the reasoning that
 * over-suggesting beats recommending nothing. That is right for a UX filter and
 * wrong for a trust filter: it meant a deleted or reshaped manifest silently
 * re-admitted every cached plugin, including the ones Claude Code is refusing
 * to load. Whether a plugin is trusted is the host's decision, and this process
 * does not get to reverse it because a file went missing. `readable` carries the
 * degradation so the caller can say so out loud instead of quietly listing less.
 */
function installedPlugins(): PluginManifest {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
    const data = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    if (!data.plugins || typeof data.plugins !== 'object') {
      return { installed: new Set(), readable: false };
    }
    return {
      installed: new Set(Object.keys(data.plugins).map((k) => k.split('@')[0]!)),
      readable: true,
    };
  } catch {
    return { installed: new Set(), readable: false };
  }
}

/** Whether the host's plugin manifest could be read. False means plugin skills are excluded. */
export function pluginManifestReadable(): boolean {
  return installedPlugins().readable;
}

/**
 * A plugin directory name is third-party and reaches the model's context, so it
 * is held to the shape a real plugin name already has. Anything else is a
 * payload, not a name.
 */
const PLUGIN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Plugins with skills on disk that Claude Code will not load.
 *
 * Returns nothing when the manifest is unreadable: without it there is no basis
 * for calling any plugin uninstalled, and the caller reports the unreadable
 * manifest instead.
 */
export function uninstalledPlugins(): string[] {
  const { installed, readable } = installedPlugins();
  if (!readable) return [];

  const cache = join(homedir(), '.claude', 'plugins', 'cache');
  const out = new Set<string>();
  for (const marketplace of dirsIn(cache)) {
    for (const plugin of dirsIn(join(cache, marketplace))) {
      if (installed.has(plugin)) continue;
      if (!PLUGIN_NAME.test(plugin)) continue;
      for (const version of dirsIn(join(cache, marketplace, plugin))) {
        if (dirsIn(join(cache, marketplace, plugin, version, 'skills')).length > 0) {
          out.add(plugin);
        }
      }
    }
  }
  return [...out].sort();
}

/**
 * Skills live in three places: installed plugins, the user's personal skills
 * dir, and the current project. All three are optional.
 */
export function discoverSkills(cwd: string = currentProject()): Skill[] {
  const found = new Map<string, Skill>();
  const add = (s: Skill) => {
    const key = `${s.name}\0${s.projectRoot}`;
    if (!found.has(key)) found.set(key, s);
  };

  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/
  const cache = join(homedir(), '.claude', 'plugins', 'cache');
  const { installed } = installedPlugins();
  for (const marketplace of dirsIn(cache)) {
    for (const plugin of dirsIn(join(cache, marketplace))) {
      // Cached but not installed: on disk, yet not invokable. Don't advise it.
      // An unreadable manifest leaves this set empty, so every plugin is
      // excluded — fail closed. Personal and project skills are unaffected.
      if (!installed.has(plugin)) continue;
      for (const version of dirsIn(join(cache, marketplace, plugin))) {
        const dir = join(cache, marketplace, plugin, version, 'skills');
        for (const s of collect(dir, `plugin:${plugin}`, (n) => `${plugin}:${n}`)) add(s);
      }
    }
  }

  for (const s of collect(join(homedir(), '.claude', 'skills'), 'personal', (n) => n)) add(s);
  // Only this one is scoped — it exists solely inside this repo.
  for (const s of collect(join(cwd, '.claude', 'skills'), 'project', (n) => n, cwd)) add(s);

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Upserts the registry and reconciles availability, preserving usage counters.
 *
 * The scan is authoritative for plugin and personal skills (both global) and
 * for this project's own skills. Anything in those scopes that the scan did not
 * see is marked unavailable rather than deleted, so counters survive a plugin
 * being reinstalled. Other projects' rows and skills only ever learned from
 * skills_used are left alone — this scan is no evidence about them.
 */
export function syncSkills(skills: Skill[], now: Date, cwd: string = currentProject()): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO skills (name, project_root, source, description, first_seen, available)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(name, project_root) DO UPDATE SET
       source = excluded.source,
       description = excluded.description,
       available = 1`,
  );
  for (const s of skills) {
    insert.run(s.name, s.projectRoot ?? '', s.source, s.description, now.getTime());
  }

  const seen = new Set(skills.map((s) => `${s.name}\0${s.projectRoot ?? ''}`));
  const candidates = db
    .prepare(
      `SELECT name, project_root, source FROM skills
        WHERE available = 1
          AND ( source LIKE 'plugin:%'
                OR source = 'personal'
                OR (source = 'project' AND project_root = ?) )`,
    )
    .all(cwd) as unknown as { name: string; project_root: string; source: string }[];

  const retire = db.prepare('UPDATE skills SET available = 0 WHERE name = ? AND project_root = ?');
  for (const row of candidates) {
    if (!seen.has(`${row.name}\0${row.project_root}`)) {
      retire.run(row.name, row.project_root);
    }
  }
}

interface SkillRow {
  name: string;
  project_root: string;
  source: string;
  description: string;
  uses: number;
  last_used_at: number | null;
  first_seen: number;
}

/**
 * Every skill reachable from `cwd`: the global ones plus this project's own.
 * All reads go through here so none can forget the scope filter.
 */
function visibleRows(cwd: string): SkillRow[] {
  return getDb()
    .prepare(
      `SELECT name, project_root, source, description, uses, last_used_at, first_seen
         FROM skills
        WHERE available = 1
          AND (project_root = '' OR project_root = ?)
        ORDER BY uses DESC, name ASC`,
    )
    .all(cwd) as unknown as SkillRow[];
}

export function recordSkillUses(
  names: string[],
  kind: string,
  now: Date,
  cwd: string = currentProject(),
): void {
  const db = getDb();
  const use = db.prepare('INSERT INTO skill_uses (skill, at, kind) VALUES (?, ?, ?)');
  const bump = db.prepare(
    'UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE name = ? AND project_root = ?',
  );
  const ensure = db.prepare(
    `INSERT OR IGNORE INTO skills (name, project_root, source, description, first_seen)
     VALUES (?, '', 'reported', '', ?)`,
  );
  const scopeOf = db.prepare(
    "SELECT project_root FROM skills WHERE name = ? AND project_root IN ('', ?) ORDER BY project_root DESC LIMIT 1",
  );

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;

    // Credit this project's own copy when it has one, otherwise the global row.
    // A skill named only in skills_used is unknown to discovery, so it is
    // registered globally — we have no evidence it belongs to this repo.
    const existing = scopeOf.get(name, cwd) as { project_root: string } | undefined;
    if (!existing) ensure.run(name, now.getTime());
    const scope = existing ? existing.project_root : '';

    use.run(name, now.getTime(), kind);
    bump.run(now.getTime(), name, scope);
  }
}

export function skillStats(cwd: string = currentProject()): SkillStat[] {
  return visibleRows(cwd).map((r) => ({
    name: r.name,
    source: r.source,
    description: r.description,
    projectRoot: r.project_root,
    uses: Number(r.uses),
    lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
  }));
}

export interface SkillAffinity {
  skill: string;
  /** Times this skill was used for this kind of task. */
  uses: number;
  /** This skill's share of all skill use for this kind, 0..1. */
  share: number;
}

/**
 * What you actually reach for when doing a given kind of work. This is the
 * learned half of the recommendation — independent of anything the task
 * description happens to say.
 */
export function affinityFor(kind: string): SkillAffinity[] {
  const rows = getDb()
    .prepare('SELECT skill, count(*) AS n FROM skill_uses WHERE kind = ? GROUP BY skill ORDER BY n DESC, skill ASC')
    .all(kind) as { skill: string; n: number }[];

  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
  return rows.map((r) => ({
    skill: r.skill,
    uses: Number(r.n),
    share: total > 0 ? Number(r.n) / total : 0,
  }));
}

/**
 * The same ranking for every kind that has usage, restricted to skills
 * reachable from `cwd` — history from another project's skills is real, but
 * showing it here would name skills that do not exist in this repo.
 */
export function affinityByKind(cwd: string = currentProject()): Record<string, SkillAffinity[]> {
  const kinds = getDb()
    .prepare("SELECT DISTINCT kind FROM skill_uses WHERE kind != '' ORDER BY kind")
    .all() as { kind: string }[];

  const visible = new Set(visibleRows(cwd).map((r) => r.name));
  const out: Record<string, SkillAffinity[]> = {};
  for (const k of kinds) {
    const ranked = affinityFor(k.kind).filter((a) => visible.has(a.skill));
    if (ranked.length > 0) out[k.kind] = ranked;
  }
  return out;
}

/**
 * A skill that looks like it is not earning its place, and the evidence for it.
 *
 * `quiet` was used once and has not been since. `missed` was the best fit for
 * work you did in the window and was never loaded for any of it: the skill may be
 * fine but its description is not what gets it picked. `idle` was the best fit
 * for none of it, so nothing you do calls for it, which makes it a candidate to
 * uninstall or rewrite.
 */
export interface StaleSkill {
  skill: string;
  verdict: 'quiet' | 'missed' | 'idle';
  uses: number;
  lastUsedAt: number | null;
  /** Observations in the window this skill was the single best fit for. */
  matched: number;
}

export interface Stocktake {
  /** Size of the window in days. */
  window: number;
  /** Observations inside the window — the evidence `matched` is counted from. */
  observations: number;
  stale: StaleSkill[];
}

/**
 * A stocktake match has to clear a higher bar than a nudge. Even clamped to
 * MAX_SKILL_DESCRIPTION, a description is dense with the words work summaries use,
 * so almost any summary shares two of them with most skills:
 * measured on one buddy's 757 observations, a fleet-audit skill cleared MIN_SCORE
 * on 172 summaries of ordinary coding work, about as often as the review skill
 * used on 86 of them. Requiring the skill to be the unique best fit, at a score
 * of a name hit plus a description hit or four description hits, took that to 18
 * -- all of them summaries that genuinely were about fleets.
 */
const STOCKTAKE_MIN_SCORE = 4;

/** The one skill a summary fits best, or null when none clears the bar or two tie. */
function bestFit(rows: SkillRow[], summary: string): string | null {
  let best: string | null = null;
  let top = 0;
  let tied = false;
  for (const r of rows) {
    const score = scoreSkill({ name: r.name, description: r.description }, summary);
    if (score > top) {
      best = r.name;
      top = score;
      tied = false;
    } else if (score === top) {
      tied = true;
    }
  }
  return top >= STOCKTAKE_MIN_SCORE && !tied ? best : null;
}

/**
 * Which skills are not being used, and why that might be, grounded in what the
 * buddy has actually watched you do rather than in a read of the skill's prose.
 *
 * A skill discovered inside the window is left out. Having had no chance to be
 * used is not evidence of anything, and every freshly installed plugin would
 * otherwise arrive pre-labelled as neglected. Likewise the whole report is empty
 * when the window holds no observations: `idle` means "nothing you did fits",
 * which is only a claim when you did something.
 */
export function stocktake(now: Date, window = 30, cwd: string = currentProject()): Stocktake {
  const cutoff = now.getTime() - window * 86_400_000;
  const summaries = (
    getDb().prepare('SELECT summary FROM events WHERE at >= ?').all(cutoff) as { summary: string }[]
  ).map((e) => e.summary);

  const stale: StaleSkill[] = [];
  if (summaries.length === 0) return { window, observations: 0, stale };

  const rows = visibleRows(cwd);
  const matched = new Map<string, number>();
  for (const summary of summaries) {
    const fit = bestFit(rows, summary);
    if (fit) matched.set(fit, (matched.get(fit) ?? 0) + 1);
  }

  for (const r of rows) {
    if (Number(r.first_seen) >= cutoff) continue;
    const uses = Number(r.uses);
    const lastUsedAt = r.last_used_at === null ? null : Number(r.last_used_at);
    if (lastUsedAt !== null && lastUsedAt >= cutoff) continue;

    const n = matched.get(r.name) ?? 0;
    const verdict = uses > 0 ? 'quiet' : n > 0 ? 'missed' : 'idle';
    stale.push({ skill: r.name, verdict, uses, lastUsedAt, matched: n });
  }

  // Most actionable first: a skill that fits work you keep doing is a routing
  // problem worth fixing today, a quiet one is worth a look, an idle one waits.
  const order = { missed: 0, quiet: 1, idle: 2 } as const;
  stale.sort(
    (a, b) => order[a.verdict] - order[b.verdict] || b.matched - a.matched || a.skill.localeCompare(b.skill),
  );
  return { window, observations: summaries.length, stale };
}

export interface Advice {
  skill: string;
  description: string;
  /** Blended 0..1 confidence. */
  score: number;
  /** Raw token-overlap score against the task description. */
  relevance: number;
  /** Share of this kind's skill use, 0..1. */
  affinity: number;
  /** Times used for this kind specifically. */
  kindUses: number;
  /** Times used overall. */
  uses: number;
  reason: string;
}

// Relevance leads — a skill must plausibly fit the task at hand. Affinity is
// the learned correction: what you reach for once the field is narrowed.
const W_RELEVANCE = 0.65;
const W_AFFINITY = 0.35;

/**
 * Relevance is scored against this absolute ceiling rather than against the
 * best candidate in the field. Normalising against the field would score a
 * single incidental token match as a perfect match whenever the field is weak,
 * which buries a skill you demonstrably always use under one you never have.
 * 6 ≈ two name hits, or six description hits.
 */
const RELEVANCE_FULL = 6;

function reasonFor(a: { relevance: number; kindUses: number; uses: number }, kind: string): string {
  const parts: string[] = [];
  if (a.relevance > 0) parts.push('matches this task');
  if (a.kindUses > 0) {
    parts.push(`used ${a.kindUses}× for ${kind} work`);
  } else if (a.uses > 0) {
    parts.push(`used ${a.uses}× overall, never for ${kind}`);
  } else {
    parts.push('never used');
  }
  return parts.join(' · ');
}

/**
 * Ranks skills for a task you are about to start. Combines what the task says
 * with what you have historically reached for on this kind of work, so a skill
 * you always use for deploys outranks one that merely shares a keyword.
 */
export function advise(
  task: string,
  kind: string,
  limit = 3,
  cwd: string = currentProject(),
): Advice[] {
  const rows = visibleRows(cwd);
  if (rows.length === 0) return [];

  const affinity = new Map(affinityFor(kind).map((a) => [a.skill, a]));

  const scored = rows.map((r) => {
    const a = affinity.get(r.name);
    return {
      skill: r.name,
      description: r.description,
      relevance: scoreSkill({ name: r.name, description: r.description }, task),
      affinity: a ? a.share : 0,
      kindUses: a ? a.uses : 0,
      uses: Number(r.uses),
    };
  });

  return scored
    .map((s) => {
      const relNorm = Math.min(1, s.relevance / RELEVANCE_FULL);
      const score = W_RELEVANCE * relNorm + W_AFFINITY * s.affinity;
      return { ...s, score, reason: reasonFor(s, kind) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill))
    .slice(0, Math.max(1, limit));
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
export function scoreSkill(skill: { name: string; description: string }, summary: string): number {
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
  cwd: string = currentProject(),
): Suggestion | null {
  const db = getDb();
  const used = new Set(usedNow.map((s) => s.trim()));

  const rows = visibleRows(cwd);

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

    const score = scoreSkill({ name: r.name, description: r.description }, summary);
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
