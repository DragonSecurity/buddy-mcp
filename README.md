# buddy-mcp

A persistent coding companion for Claude Code, served over MCP — that also
learns which of your skills fit which kind of work.

Your buddy hatches on first use, gains XP as you work, evolves through stages,
and gets moody if you disappear for a week. Its name and personality are rolled
once, at hatch, and kept for life.

```
🐉 Emberchaos the Dragon · gremlin
Lv 13  ░░░░░░░░░░░░░░  0/1900 xp
Mood  🤩 feral with joy   ·   Energy ▓▓▓▓▓▓▓▓▓▓ 100%
Streak 2 days (best 12) · 632 observations · 113 days old
Skills 1/13 used · most-used dataviz (1)

A rotund, fidgety chonk that thrashes through your code like a wrecking ball…

> still here. still a problem
```

## Install

Point an MCP client at this repository. npx fetches and builds it on demand, so
there is nothing for you to clone and nothing to keep built:

```sh
claude mcp add buddy --scope user -- npx -y 'github:DragonSecurity/buddy-mcp#semver:^2'
```

The quotes are for zsh: with `extendedglob` on, `^` is a negation operator, and
an unquoted spec dies with `zsh: no matches found` before npx is ever reached.

The same thing as a config file, for clients that want one — a project's
`.mcp.json`, or the `mcpServers` block in `~/.claude.json`:

```json
{
  "mcpServers": {
    "buddy": {
      "command": "npx",
      "args": ["-y", "github:DragonSecurity/buddy-mcp#semver:^2"]
    }
  }
}
```

**This package is not on the npm registry, and is not going there.** Releases
are GitHub releases, and the tags in this repository are the distribution
channel — `v2.1.0` is the thing `^2` resolves to. Searching npm for `buddy-mcp`
will find nothing, or worse will one day find a package somebody else published
under a name this project never claimed; either way it is not this. Install it
from the git spec above or from a checkout, and from nowhere else.

**What the git spec actually does, and what it costs.** `#semver:^2` tells npm
to read this repository's tags, pick the highest `v2.x.y` among them, clone that
tag, install its devDependencies and run the `prepare` script — `tsc` — to
compile `dist/` before anything can start. That is real work that a registry
install does not do: `dist/` is not committed, so the build happens on your
machine. The first launch on a cold npx cache takes tens of seconds rather than
a couple, and the machine needs `git` on the `PATH` and enough of a toolchain to
run the TypeScript compiler. Every later launch is served from the npx cache and
starts immediately. If your MCP client gives a server a short window to come up,
the first launch after a new release is the one that will hit it — running the
command once by hand warms the cache before the client ever asks.

**If your npm has `ignore-scripts` on, this install fails silently.** Turning it
on globally is a reasonable thing to have done — it is the standard defence
against a dependency running code at install time — but `prepare` is a script,
and `prepare` is what compiles `dist/`. With it suppressed npm reports success
and exits zero, having installed a package with nothing in it: no `dist/`, no
`buddy-mcp` binary linked, and no warning that anything was skipped. The only
symptom is your MCP client reporting that the server would not start. Check with
`npm config get ignore-scripts`; if it is `true`, allow scripts for this one
install rather than everywhere:

```sh
claude mcp add buddy --scope user -- npx -y --ignore-scripts=false 'github:DragonSecurity/buddy-mcp#semver:^2'
```

**The caret is load-bearing.** `^2` accepts every patch and minor tag
automatically, so fixes and new tools arrive without anyone editing a config,
and it refuses a `v3.0.0` tag. That refusal is the point: a major bump here
means the shape of an existing tool changed, and a caller written against the
old shape — your `CLAUDE.md`, a hook, a skill — would start failing calls that
used to work. Pinning to a single tag (`#v2.1.0`) freezes the fixes too; asking
for no ref at all (`github:DragonSecurity/buddy-mcp`) takes whatever is on the
default branch, which means both the breaking change and work that has not been
released yet. The caret is the only one of the three that tracks fixes *and*
stops at the break.

The maintenance commands ship in the same package, under a second binary. The
examples further down are written as `node dist/cli.js …`, which is the
from-source form; through npx the same commands are:

```sh
npx -p 'github:DragonSecurity/buddy-mcp#semver:^2' buddy-import rescue
npx -p 'github:DragonSecurity/buddy-mcp#semver:^2' buddy-import serve --port 8787
```

### With the dragon-dev-buddy skill pack

The `dragon-dev-buddy` skill pack ships this server in its own `.mcp.json`, so
installing that plugin brings a compatible buddy with it — nothing to configure
twice, and every skill in the pack can call `buddy_advise` before it starts and
`buddy_observe` when it finishes.

That coupling is exactly what the major version protects. The pack's skills are
written against the `buddy_observe` / `buddy_advise` tool shape — those argument
names, those types. If an argument there is ever renamed, dropped or made
required, the pack would be calling a tool that no longer accepts what it sends,
and it would fail one skill at a time rather than obviously. So a change to that
shape is a major release, and a `^2` range declines the upgrade instead of
letting it land under a plugin that has not been updated for it.

### From source

Building from a checkout is the development path — reach for it when you are
changing the server, not when you are using it:

```sh
npm install
npm run build
claude mcp add buddy-dev --scope user -- node /absolute/path/to/buddy-mcp/dist/index.js
```

An absolute path into `dist/` carries no version. Every project on the machine
runs whatever was built last, so an interrupted rebuild takes the buddy down
everywhere at once and a change made for one repo silently changes all of them.
That is a reasonable trade for a working copy you are editing, and a poor way to
run the thing day to day.

If the `dragon-dev-buddy` pack is installed, this entry does not replace the
server the pack declares — it joins it. Claude Code registers a plugin's servers
under `plugin:<plugin>:<server>` and suppresses a duplicate only when the command
matches exactly, so `node …/dist/index.js` and `npx -y github:…` both start, and
the session ends up with two full sets of `buddy_*` tools. Neither declaration
sets `BUDDY_HOME`, so both processes open `~/.buddy-mcp/buddy.db` — the live
buddy, not a copy. Concurrent readers and writers are safe there (WAL, with a
five-second busy timeout), but the damage is a level up from corruption: every
tool call loads the buddy row, edits it in memory and writes all of it back, so
whichever save lands second reverts the other's XP, level and `last_observed_day`
— and a reverted `last_observed_day` hands out the first-observation-of-the-day
bonus a second time. One task reported to both tool sets is inserted into
`events` twice, and nothing afterwards can tell that duplicate from a real
observation. Give the development copy its own buddy with
`--env BUDDY_HOME=$HOME/.buddy-mcp-dev`, or take the other server out; do not
point both at the one you actually keep.

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
🐉 Voidkin · +61 xp (deploy) · first of the day 🌅  →  Lv 13, 61/1900

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
🐲 Elder (20) → ✨ Ascendant (35) → 🌌 Astral (60) → 🌟 Eternal (100).

**XP.** Each observation is classified from its summary — `deploy` (30 base) >
`feature` (26) > `bugfix` (24) > `test` (22) > `refactor` (20) > `other` (18) >
`docs` (16) > `config` (14). The first observation of each day is worth +25, a
streak multiplies by up to 1.5×, and a drained buddy learns at 0.7×. Levelling
costs `100 + 150n` XP, with the stages rather than the curve carrying the
rarity — the two are independent, and coupling them bought rare stages at the
price of a progress bar that did not visibly move for a week.

**Energy.** Measures how long the current session has run, not how much was done
in it: 8 drains per elapsed hour, and a gap of four hours or more starts a fresh
session at full. Below 25% the buddy complains instead of reacting.

**Mood.** Loses ground after 18 hours of silence, gains up to 15 from an active
streak. Energy caps the tier rather than nudging the score, so the card can
never claim more animation than the buddy has left. Each personality has its own
vocabulary for all five mood tiers.

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
npm test     # 208 tests: engine, storage, skills, scoping, advice, presence, backfill, import, rescue, serve, hardening, end-to-end MCP
```

## Versioning and releases

Semver, with one clarification that decides most of the calls: **the MCP tool
surface is the public API.** What a caller can write down and depend on is the
set of tools, their argument names and their types — nothing else.

- **major** — an existing tool changes shape. An argument renamed, removed, made
  required, or narrowed to accept less than it used to; a tool removed. Anything
  a caller written against the previous version can get wrong.
- **minor** — a new tool, a new optional argument, a new CLI subcommand, a new
  personality. Every existing call still means what it meant.
- **patch** — fixes and wording that leave every call site valid.

The internals are deliberately not part of that promise. The SQLite schema, the
XP curve, the level costs and the rendering all change on minor releases:
migrations run forward on their own, and a re-priced curve cannot break a caller
that only ever sends a summary string. Locking those down would mean never
correcting the economy again.

[CHANGELOG.md](CHANGELOG.md) records what changed in each release, newest first.

### Cutting a release

1. Move the unreleased entries in `CHANGELOG.md` under a heading for the new
   version. That section *is* the release notes, so a version with no section is
   a version that cannot be released at all.
2. Bump `version` in `package.json`. It is what the server reports in the MCP
   handshake, and the release refuses a tag that disagrees with it.
3. Merge to main. **Releases are cut from main only** — a tag becomes resolvable
   by `^2` the instant it is pushed, so tagging a side branch hands code that no
   pull request gate ever looked at to every machine on the range, immediately
   and without asking.
4. Tag `vX.Y.Z` on main and push the tag.

Pushing the tag is the release. The workflow checks the tag against
`package.json`, runs the same build and test matrix a pull request runs, packs
the tarball, and cuts the GitHub release from the changelog section for that
version. None of it is done by hand, which is what keeps the tag, the version
and the changelog from drifting apart.

The tag is not a label on the release — it *is* the release, because
`npx -y github:DragonSecurity/buddy-mcp#semver:^2` resolves against these tags
and clones one. Deleting a released tag takes that version away from everyone
who has not already cached it, and moving one silently changes what a cache miss
will build tomorrow on a machine that was never told anything changed. A tag
that went out wrong is fixed by cutting the next patch, never by rewriting the
one that shipped.

## License

Apache-2.0. See [LICENSE](LICENSE).
