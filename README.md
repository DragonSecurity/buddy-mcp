# buddy-mcp

A persistent coding companion for Claude Code, served over MCP — that also
learns which of your skills fit which kind of work.

Your buddy hatches on first use, gains XP as you work, evolves through stages,
and gets moody if you disappear for a week. Its name and personality are rolled
once, at hatch, and kept for life.

```
🐉 Emberchaos the Dragon · gremlin
Lv 13  ░░░░░░░░░░░░░░  0/1972 xp
Mood  🤩 feral with joy   ·   Energy ▓▓▓▓▓▓▓▓▓▓ 100%
Streak 2 days (best 12) · 632 observations · 113 days old
Skills 1/13 used · most-used dataviz (1)

A rotund, fidgety chonk that thrashes through your code like a wrecking ball…

> still here. still a problem
```

## Install

```sh
npm install
npm run build
claude mcp add buddy-mcp --scope user -- node /absolute/path/to/buddy-mcp/dist/index.js
```

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `buddy_status` | — | Status card. Hatches a buddy on first use. |
| `buddy_advise` | `task`, optional `kind`, optional `limit` | Ranks the skills worth loading **before** you start. |
| `buddy_observe` | `summary`, optional `kind`, optional `skills_used` | Records a task, grants XP, reacts, and may suggest a skill. |
| `buddy_skills` | — | Lists discovered skills, usage, and what you reach for per task kind. |
| `buddy_rename` | `name` | Renames the buddy. Progress and personality untouched. |

Add this to `~/.claude/CLAUDE.md` so Claude uses it:

```markdown
## Buddy Companion

You have a coding companion available via the buddy MCP server.

**After completing any coding task**, call `buddy_observe` with a 1-sentence
summary, passing `skills_used` if you invoked any skills.

Before starting non-trivial work, call `buddy_advise` with what you are about
to do and load any skill it ranks highly.

At the start of each conversation, call `buddy_status`.
```

## Skills

The buddy discovers skills from three places and tracks which ones you actually
use:

- installed plugins — `~/.claude/plugins/cache/*/<plugin>/*/skills/*/SKILL.md`,
  named `plugin:skill`
- your personal skills — `~/.claude/skills/*/SKILL.md`
- the current project — `./.claude/skills/*/SKILL.md`

Two rules keep the list honest.

**Only invokable skills are advised.** A plugin can sit in the cache without
being listed in `installed_plugins.json`; its skills exist on disk but Claude
Code's `Skill` tool refuses to load them. Recommending one is a dead end, so
they're excluded — and `buddy_skills` names the plugin so you can fix the
install rather than wonder why the skill vanished.

**Project skills are scoped to their project.** Plugin and personal skills are
global; `./.claude/skills` belongs to one repo. Skills are keyed by
`(name, project_root)`, so two repos can each define a `deploy` skill without
one shadowing the other, and neither is listed, suggested or advised in the
other. A skill named only via `skills_used` is registered globally — there's no
evidence it belongs to any particular repo.

A skill that stops being discoverable is flagged unavailable rather than
deleted, so its usage counters survive an uninstall/reinstall cycle.

When a task matches a skill you've never used, the buddy says so:

```
🐉 Voidkin · +61 xp (deploy) · first of the day 🌅  →  Lv 13, 61/1972

> Out in the world! Fly, little code, fly!

💡 Voidkin noticed `cloudflare:workers-best-practices` fits this and you've
   never used it — Reviews and authors Cloudflare Workers code against
   production best practices.
```

Matching is token overlap against the skill's name and description, with light
suffix stemming so "dashboards" matches "dashboard". A name hit counts triple.
The buddy will not suggest a skill you used in the last 7 days, will not
suggest one you passed in `skills_used`, and gives up on any given skill after
3 unheeded suggestions.

### Advice

`buddy_advise` answers the other half: *before* starting, which skills should I
load? It blends two signals —

- **relevance** — token overlap with the task description, scored against an
  absolute ceiling rather than against the rest of the field. Normalising
  against the field would score one incidental word as a perfect match whenever
  nothing else competes.
- **affinity** — this skill's share of everything you've used for *this kind*
  of task, from `skill_uses`.

```
Emberchaos suggests, for deploy work:

1. `cloudflare:wrangler` — 89% · matches this task · used 4× for deploy work
2. `cloudflare:workers-best-practices` — 65% · matches this task · never used
```

Relevance leads at 65% weight, so a skill can't win on habit alone. Affinity is
the correction that decides between candidates the description can't separate —
and it's the only thing that can rank a skill with no description at all.

That matters more than it sounds: **skills bundled with Claude Code aren't in
the plugin cache**, so the buddy only learns they exist when you name them in
`skills_used`, and they arrive with an empty description. Affinity is the only
signal they will ever have. Ranking that ignored it would permanently bury them.

`buddy_skills` shows the learned side:

```
What you reach for
  deploy    cloudflare:wrangler 100%
  feature   dataviz 100%
```

## Mechanics

**Stages.** 🥚 Egg (lv 1) → 🐣 Hatchling (2) → 🦎 Whelp (5) → 🐉 Dragon (10) →
🐲 Elder (20) → ✨ Ascendant (35).

**XP.** Each observation is classified from its summary — `deploy` (30 base) >
`feature` (26) > `bugfix` (24) > `test` (22) > `refactor` (20) > `other` (18) >
`docs` (16) > `config` (14). The first observation of each day is worth +25, a
streak multiplies by up to 1.5×, and a drained buddy learns at 0.7×. Levelling
costs `100 + 60n + 8n²` XP.

**Energy.** Drains 4 per observation, recovers 10/hour while you're away. Below
25% the buddy complains instead of reacting.

**Mood.** Loses ground after 18 hours of silence, gains up to 15 from an active
streak, dips when energy is low. Each personality has its own vocabulary for
all five mood tiers.

**Streaks.** Counted in *your* local calendar days, not UTC. `buddy_status`
keeps a streak alive but does not spend the daily XP bonus — that's reserved
for actual work.

**Personalities.** `snarky`, `cheerful`, `stoic`, `gremlin`, `zen`.

## State

SQLite at `~/.buddy-mcp/buddy.db`, via Node's built-in `node:sqlite` — **no
native modules**, so a Node major upgrade can't leave it unloadable. Set
`BUDDY_HOME` to relocate.

Tables: `buddy` (single row, enforced by a CHECK constraint), `events`
(append-only history), `milestones`, `skills`, `skill_uses`, `nudges`. All
times are epoch-millisecond integers — SQLite's `CURRENT_TIMESTAMP` is a
zone-less UTC string that JavaScript parses as *local* time, which is a real
bug worth designing out.

An unreadable database is moved aside rather than deleted. Migrations run
inside a single transaction, so an interrupted upgrade rolls back rather than
leaving a schema that cannot be re-applied.

## Presence: silence is not absence

A day with no recorded work is ambiguous — you might have been away, or the
buddy might have been broken. That distinction is not academic: this project
exists partly because a companion sat unloadable for 20 days after a Node
upgrade while its user was at peak activity. Any measurement that reads that
hole as absence draws exactly the wrong conclusion.

So the buddy records a `heartbeat` for every day it runs, independently of
whether anything was observed. That yields three states rather than two:

- **worked** — the buddy ran and recorded work
- **quiet** — it ran, and nothing was recorded. Real evidence about you.
- **unrecorded** — it never ran. Unknowable, and never scored.

```
Last 30 days: 10 worked · 20 unrecorded
```

`knownGaps()` returns intervals between active days only when every day in
between is accounted for, so an outage can never be mistaken for working
rhythm. Existing history is backfilled on migration: a day that recorded an
observation self-evidently had a working buddy.

## Backfilling imported history

A companion imported from another implementation arrives with every event typed
as a generic `observe`, carrying no behavioural signal. The descriptions were
never lost, though — they were passed as tool arguments and are still in Claude
Code's transcripts.

```sh
node dist/cli.js backfill --dry-run   # report, write nothing
node dist/cli.js backfill             # match and relabel
```

Events are matched to transcript entries by timestamp (default ±120s) and
reclassified with the current classifier. Only events still carrying the
`imported:` placeholder are touched, so it is safe to re-run and cannot affect
natively recorded work. **XP is left exactly as awarded** — the lifetime total
already reflects it, and re-scoring history would only desync the two.

Reach is limited by transcript retention (30 days by default), so older events
stay generic rather than being guessed at.

## Relationship to @fiorastudio/buddy

This is an independent implementation, not a fork — it shares no code with
[fiorastudio/buddy](https://github.com/fiorastudio/buddy) (MIT). Different
storage, different progression, different personality system. The overlap is
the idea and two tool names.

It does ship an importer, so a companion raised over there can move in here:

```sh
node dist/cli.js import                      # from ~/.buddy/buddy.db
node dist/cli.js import --personality stoic  # choose rather than roll
node dist/cli.js import --from /path/to.db --force
```

The import carries the name, level, lifetime XP and full event history,
reconstructs the longest streak from event dates, and maps upstream event types
(`bug_fix`, `deploy`, `commit`, `observe`, `session`) onto ours. Progress toward
the *next* level restarts, since the two XP curves differ. Species does not
carry across — stages here are fixed.

## Rescuing the original

Claude Code shipped a `/buddy` companion and removed it on 2026-04-09. The
record was never deleted — it is still sitting in `~/.claude.json` under a
top-level `companion` key, with the buddy's name, its free-text personality,
and the real `hatchedAt` timestamp.

```sh
node dist/cli.js rescue                       # identity + grafted history
node dist/cli.js rescue --events none         # identity only, from level 1
node dist/cli.js rescue --personality gremlin # override the inference
```

`rescue` takes the **identity** (name, description, true birth date) from
`~/.claude.json` and optionally grafts the **progression** (level, lifetime XP,
event history) from a `@fiorastudio/buddy` database — so the original companion
comes back with the work a later one actually did.

Because Anthropic stored a free-text personality rather than one of our five,
`rescue` infers the closest match from that description by keyword, and prints
when it has done so. Pass `--personality` to decide yourself. The original
description is kept verbatim in the `bio` column and shown on the status card;
it is the one thing a fixed-personality system cannot reconstruct.

The original record has **no species field**, so a species cannot be recovered
from it — stages here are level-based anyway.

## Development

```sh
npm run build
npm test     # 153 tests: engine, storage, skills, scoping, advice, presence, backfill, import, rescue, end-to-end MCP
```

## License

Apache-2.0. See [LICENSE](LICENSE).
