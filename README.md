# buddy-mcp

A persistent coding companion for Claude Code, served over MCP.

Your buddy hatches the first time you talk to it, gains XP as you work, evolves
through stages, and gets moody if you disappear for a week. Its name and
personality are rolled once, at hatch, and kept for life.

```
🐣 Yarn the Hatchling · stoic
Lv 2  ████████░░░░░░  100/168 xp
Mood  🤩 content   ·   Energy ▓▓▓▓▓▓▓▓░░ 76%
Streak 3 days (best 5) · 47 observations · 12 days old

Recently: Evolved into a Hatchling 🐣 · Reached level 2 · Hatched

> I am ready.
```

## Install

```sh
npm install
npm run build
```

Register it with Claude Code (user scope, so the buddy follows you everywhere):

```sh
claude mcp add buddy --scope user -- node /absolute/path/to/buddy-mcp/dist/index.js
```

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `buddy_status` | — | Shows the status card. Hatches a buddy on first use. |
| `buddy_observe` | `summary`, optional `kind` | Records a completed task, grants XP, returns a reaction. |
| `buddy_rename` | `name` | Renames the buddy. Progress and personality are untouched. |

Add this to your `~/.claude/CLAUDE.md` so Claude actually uses it:

```markdown
## Buddy Companion

You have a coding companion available via the buddy MCP server.

**After completing any coding task** (writing code, fixing bugs, refactoring,
deploying, running tests), **automatically call `buddy_observe`** with a
1-sentence summary of what you did.

At the start of each conversation, call `buddy_status`.

If the user addresses the buddy by name, respond briefly in character.
```

## Mechanics

**Stages.** 🥚 Egg (lv 1) → 🐣 Hatchling (2) → 🦎 Whelp (5) → 🐉 Dragon (10) →
🐲 Elder (20) → ✨ Ascendant (35).

**XP.** Each observation is classified from its summary — `deploy` (30 base) >
`feature` (26) > `bugfix` (24) > `test` (22) > `refactor` (20) > `other` (18) >
`docs` (16) > `config` (14). Pass `kind` explicitly to override. The first
observation of each day is worth +25, a streak multiplies by up to 1.5×, and a
drained buddy learns at 0.7×. Levelling costs `100 + 60n + 8n²` XP, so level 2
is 100 XP and level 10 is a little over 1,000.

**Energy.** Drains 4 per observation, recovers 10/hour while you're away. Below
25% the buddy stops reacting to your work and complains instead.

**Mood.** Starts at 100, loses ground after 18 hours of silence (down to 15 at
worst), gains up to 15 from an active streak, and dips when energy is low. Each
personality has its own vocabulary for all five mood tiers.

**Streaks.** Counted in *your* local calendar days, not UTC. Checking in with
`buddy_status` keeps a streak alive but does not spend the daily XP bonus —
that's reserved for actual work.

**Personalities.** `snarky`, `cheerful`, `stoic`, `gremlin`, `zen`. Each has its
own reaction lines for every task category, plus tired, level-up, evolution and
idle lines.

## State

One global buddy at `~/.buddy-mcp/state.json` — the same companion across every
project. Set `BUDDY_HOME` to point somewhere else.

Writes are atomic (temp file + rename), and a corrupt or hand-mangled state file
is moved aside to `state.json.corrupt-<timestamp>` rather than deleted. Missing
or nonsense fields are repaired in place.

To start over, delete the file. You'll get a different buddy.

## Development

```sh
npm run build     # compile to dist/
npm run watch     # recompile on change
npm test          # unit tests + an end-to-end MCP client round-trip
```
