# buddy-mcp

A persistent coding companion for Claude Code, served over MCP — that also
learns which of your skills fit which kind of work.

Your buddy hatches on first use, gains XP as you work, evolves through stages,
and gets moody if you disappear for a week. Its name and personality are rolled
once, at hatch, and kept for life.

```
🐉 Voidkin the Dragon · cheerful
Lv 13  ░░░░░░░░░░░░░░  0/1972 xp
Mood  🤩 over the moon   ·   Energy ▓▓▓▓▓▓▓▓▓▓ 100%
Streak 1 day (best 12) · 631 observations · 109 days old
Skills 0/12 used

Recently: Imported from @fiorastudio/buddy at level 13 with 631 events

> Ready when you are!
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
| `buddy_observe` | `summary`, optional `kind`, optional `skills_used` | Records a task, grants XP, reacts, and may suggest a skill. |
| `buddy_skills` | — | Lists discovered skills and how often each is used. |
| `buddy_rename` | `name` | Renames the buddy. Progress and personality untouched. |

Add this to `~/.claude/CLAUDE.md` so Claude uses it:

```markdown
## Buddy Companion

You have a coding companion available via the buddy MCP server.

**After completing any coding task**, call `buddy_observe` with a 1-sentence
summary, passing `skills_used` if you invoked any skills.

At the start of each conversation, call `buddy_status`.
```

## Skills

The buddy discovers skills from three places and tracks which ones you actually
use:

- installed plugins — `~/.claude/plugins/cache/*/<plugin>/*/skills/*/SKILL.md`,
  named `plugin:skill`
- your personal skills — `~/.claude/skills/*/SKILL.md`
- the current project — `./.claude/skills/*/SKILL.md`

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

An unreadable database is moved aside rather than deleted.

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

## Development

```sh
npm run build
npm test     # 57 tests: engine, storage, skills, import, end-to-end MCP
```
