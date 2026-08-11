# Changelog

Notable changes to the server. Versions track `package.json`.

## 2.3.2

### Fixed

- **The compliance line no longer charges one turn to both columns.** The gate
  marks the session dirty on every edit and clears the mark on every
  observation, in tool order, so a turn that records and *then* edits again ends
  with a fresh mark standing and is blocked for work it already reported. Every
  such block was counted as `prompted`, alongside the `clear` that had already
  counted the same turn as `voluntary` — inflating the nagged count with turns
  that did exactly what was asked, and adding a phantom to the total each time.

  Caught live on 2026-08-10, in a turn that recorded and then wrote two memory
  files:

  ```
  18:14:57  clear  had:true                 recorded, voluntarily
  18:15:30  mark   Edit                     a memory file, after the fact
  18:15:52  stop   block:true  markedAt:18:15:30
  18:16:01  clear  had:false                the duplicate the block extracted
  ```

  `compliance()` now tracks, per session, whether the open turn has already
  recorded, and discards a block from a turn that had. On the log that found it
  this moved 5 of 62 blocks out of `prompted`, from 57% recorded-unprompted to
  59%. The discarded count is exposed as `rearmed` so the exclusion is visible
  rather than silent; it is deliberately in neither column and not on the card.

### Notes

- The gate logs `markedAt` on a block so these two cases can be told apart, and
  using it directly is the obvious implementation. It is not the one here: the
  field is absent from entries written before it was added, and whenever the
  turn-scoped flag is set `markedAt` is necessarily later than the clear anyway.
  Turn-scoped state is simpler and stays correct on older logs.

- Turns are delimited by `reset` (which pack 1.3.1 writes on
  `UserPromptSubmit`) and by `stop`. Logs written before 1.3.1 carry no `reset`,
  so `stop` is their only boundary; a turn interrupted before `Stop` ran leaks
  its flag into the next turn, which can only suppress a block that should have
  counted. Undercounting nags is the safe direction to err.

- The gate's blocking behaviour is unchanged. A turn that records and then edits
  is still stopped and still asked for a second observation — this only stops
  that block being *scored* as a nag. Changing when the gate fires is a decision
  for the pack, not for the metric that reads its log.

## 2.3.1

What the compliance line is worth, now that the gate feeding it has been fixed.

### Notes

- The dragon-dev-buddy gate's dirty mark was keyed by session with nothing
  bounding it to a turn, so an edit could outlive the turn that made it — a
  background subagent writing under the parent's session id after the turn
  ended, a turn interrupted before `Stop` ran, a session resumed by id — and be
  consumed by the next `Stop`. Some share of every `stop`/`block:true` written
  before 2026-08-10 therefore belongs to a turn that changed nothing, and the
  prompted count reads high for as long as those events stay inside the 30-day
  window. Nothing here rewrites them; the window forgets them at its own pace.

- Pack 1.3.1 fixes it by clearing the mark on `UserPromptSubmit`, which logs a
  new `reset` event. `compliance()` ignores it, as it ignores a `clear` with
  `had:false`: nothing recorded, and nothing was asked to. `src/gate.ts` says so,
  so the next reader of that log does not have to work out why a third event
  exists.

## 2.3.0

The status card can say whether work gets recorded without being asked.

### Added

- A compliance line on `buddy_status`: how many code-changing turns in the last
  30 days recorded an observation before the dragon-dev-buddy gate had to ask
  for one, and how many needed the nudge.

  The buddy could never tell those apart on its own — an observation arrives
  either way and pays the same XP. The gate's log distinguishes them as a side
  effect of its ordering rather than by design: it clears a session's mark
  *before* blocking, so a `clear` that found a mark still present is a record
  that came first, and a `stop` that blocked is a turn that ended without one.
  Every code-changing turn produces exactly one of the two, so they sum rather
  than overlap. A `clear` with no mark is neither, and is counted on neither
  side.

  The point is to answer one question: is the gate still catching anything, or
  has it become ceremony. It is phrased as what happened rather than as a score,
  because a grade invites gaming a number whose only value is being honest.

- `src/gate.ts`, with `BUDDY_GATE_LOG` to point it elsewhere for tests.

### Notes

- This reads a file the dragon-dev-buddy pack writes, which is a real coupling
  and is named as such in the source. It is one-directional and the format is
  append-only JSON lines; an absent or unreadable log means the pack is not
  installed, which is not an error — the line is simply omitted, as it is when
  the window contains no code-changing turns. A line built from two events would
  be noise.

## 2.2.0

Energy measures a break in the work rather than a break in the conversation.

### Changed

- Energy now resets after `SESSION_GAP_HOURS` without a recorded **observation**,
  not without a tool call. There is one server process per Claude Code session,
  and any one of them calling `buddy_status` refreshed `last_seen_at` for all of
  them — so the gap that restores energy could only happen when every open
  session fell quiet together. On a machine running five sessions the reset was
  effectively unreachable: 93% of that user's sessions never ran long enough to
  tire the buddy, and it sat at 22% anyway.

  The drain still steps off `last_seen_at`, which advances on every call.
  Anchoring the drain on the observation as well would re-subtract the same
  interval on every status call between two observations.

- Mood's neglect term moved to the same anchor, for the same reason: with
  several sessions open, `last_seen_at` was never stale enough for the buddy to
  register being ignored, so a buddy that had not been told about work in two
  days still read as radiant.

### Added

- `last_observed_at` on the buddy row, and schema **v8** to add it. Backfilled
  from the newest non-milestone event, so no buddy starts this version looking
  neglected for work it was already thanked for, and energy is restored once —
  the stored value was produced under rules that no longer apply.

## 2.1.1

Fixes silent XP loss when more than one session is open.

### Fixed

- A buddy is one server process per Claude Code session, and every one of them
  writes the same database — five open sessions were five concurrent writers.
  `save()` rewrites all fifteen columns of the singleton row from whatever the
  caller last read, so an unsynchronised read-modify-write lost whichever update
  committed in between: a `buddy_status` that loaded before a concurrent
  `buddy_observe` wrote the pre-observation `xp`, `level` and `last_observed_day`
  straight back over it. The XP reverted, and the restored `last_observed_day`
  re-armed the first-of-day bonus for the next observation to collect twice.

  Read-modify-write now happens inside `withBuddy()`, which holds the write lock
  for the whole cycle with `BEGIN IMMEDIATE`, so a second session blocks on the
  existing 5s `busy_timeout` instead of racing. The regression test runs two real
  processes against one database and fails by exactly the number of lost
  increments without it.

- An observation and the event row recording it were two separate transactions,
  so a crash between them left XP with no event, or an event whose XP had been
  rolled back. `recordEvent` now commits with the state it describes.

- A tool call that threw partway through could leave a half-applied buddy
  written to disk. The transaction rolls it back.

## 2.1.0

The server gets a way to be installed by version instead of by absolute path,
and a read-only HTTP view of the buddy for anything that wants to display it.
Both are additive: every tool keeps the arguments it had, so a `^2` range takes
this without a caller changing a line.

### Added

- **`serve`**: the buddy read-only over HTTP, for an ambient display that shows
  the companion without anyone asking it to. It is deliberately a separate
  long-lived process rather than an endpoint on the MCP server, because that one
  is spawned per client session over stdio and dies with it — a display bound to
  it would go dark during exactly the hours nobody is working, and several
  concurrent sessions would mean several processes racing for one port. Reading
  goes through a new `peek()` rather than `load()`, since `load()` hatches and
  saves a brand-new buddy when the table is empty and `getDb()` migrates, so an
  outside observer polling the database would create companions and move the
  schema under a running server. It does not advance `lastSeenAt`: that is what
  energy drain and streaks are measured against, and a display polling every
  second would pin the buddy at "just seen" forever, freeze energy at full and
  hand it an unearned streak. It binds loopback, not `0.0.0.0` — reaching it
  from a device on the LAN has to be a decision someone types, because the
  payload names your machine's owner and broadcasts when they are at the
  keyboard.
- **A versioned way to install this**, as a git dependency rather than a
  registry one: `npx -y github:DragonSecurity/buddy-mcp#semver:^2`, backed by
  `repository`, `homepage`, `bugs`, `author` and `engines` in the manifest. The
  server was consumed by an absolute path out of one person's global config,
  which made every `npm run build` swap the server under every project on the
  machine, with no version to name and no way to roll back. A range fixes that
  without a registry account in the loop: npm resolves `^2` against this
  repository's tags, so the tags are the distribution channel and nothing is
  ever published to npm. `engines` floors at Node 24 for the same reason CI's
  matrix starts there: `node:sqlite` is only usable without a flag from 24
  onwards. It is a declaration and not a gate — npm answers a mismatch with an
  `EBADENGINE` warning and installs anyway, and an MCP client that launches the
  server for you never shows that line to anybody — so it does not stop a
  consumer on 22. What it does is put the requirement where a person reading the
  manifest and an `engine-strict` install can both act on it, rather than
  leaving the first symptom to be a `node:sqlite` import that will not load.
- `prepare` runs the build, because a git install has to compile the tag it just
  cloned. `dist/` is gitignored, so a tag carries source and no build, and
  `prepare` is the one lifecycle script npm runs for a git dependency — which is
  also why `typescript` has to stay a declared devDependency, since npm installs
  those for a git spec precisely so `prepare` can succeed. `prepublishOnly`
  would never run at all: it fires on `npm publish`, which nothing here does.
- **A tag-driven release workflow, and a pull request guard in front of it.**
  Pushing `vX.Y.Z` checks the tag against `package.json`, re-runs the full test
  matrix, packs the tarball and cuts the GitHub release from the changelog
  section for that version — so the notes on the releases page and the notes in
  the repository cannot drift. The guard catches, while it is still a pull
  request, the two states that only hurt later: a version with no changelog
  section, which makes the tag unreleasable and is discovered by whoever tries
  to release it long after the change was reviewed and forgotten; and a change
  under `src/` with the version left alone, which is quieter still, because a
  caret range only ever resolves to a version that exists, so the fix would sit
  on main reaching nobody and reporting no error while it failed to.

### Fixed

- The version handed to the MCP server identity was a literal in `src/index.ts`.
  A literal is a second copy of the version string with nothing keeping it in
  step with the manifest, so the first release that bumped `package.json` and
  forgot it would have had every client on the machine reporting a server
  version that was never released. It is read from `package.json` at startup
  now — the same path from a git checkout and from the tag npx clones into its
  cache — and pinned by a test.

## 2.0.0

Storage moves to SQLite and the progression model is rebuilt around measured
use rather than guesses. The major is the storage change: a 1.x JSON state file
is not read by this version.

### Added

- **SQLite storage** via Node's built-in `node:sqlite`. No native module is
  involved, so a Node major upgrade cannot leave the buddy unloadable — which is
  exactly how the upstream companion this imports from stayed dead for three
  weeks. Times are epoch-millisecond integers rather than SQLite's zone-less
  `CURRENT_TIMESTAMP` strings, which JavaScript parses as local time. The
  single-buddy invariant is a `CHECK` constraint, so a second row is
  unrepresentable rather than merely unreachable, and history is append-only in
  an events table.
- **Skill tracking and discovery** across installed plugins, the personal skills
  directory and the current project. `buddy_observe` takes `skills_used`,
  `buddy_skills` reports what is known and what gets reached for, and an unused
  but relevant skill is suggested — backing off after three unheeded nudges.
- **`buddy_advise`** and skill affinity ranking, which read back the data
  `buddy_observe` was already collecting and answer the question that matters
  before work starts rather than after. Relevance is scored against an absolute
  ceiling rather than against the best candidate in the field, because
  field-relative scoring made a single incidental word a perfect match whenever
  nothing else competed, ranking a never-used skill above one used for every
  task of that kind.
- **`buddy-import`**, which reads a `@fiorastudio/buddy` database read-only and
  carries across name, level, lifetime XP and the full event history, and
  **`buddy-import rescue`**, which restores the identity Claude Code's removed
  `/buddy` feature left behind in `~/.claude.json` — name, free-text personality
  and the true `hatchedAt` — optionally grafting progression onto it. The
  original description is kept verbatim in a `bio` column and rendered on the
  card, since it is the one thing a fixed-personality system cannot reconstruct.
- **Presence tracking**: a heartbeat for every day the server runs, recorded
  separately from whether work was observed. Without it a silent stretch is
  ambiguous — the user may have been away, or the server may have been broken —
  and this project exists partly because a companion sat unloadable for 20 days
  during peak activity. Days are worked, quiet or unrecorded, and only the first
  two are evidence.
- **`buddy-import backfill`**, which matches imported events against Claude
  Code's own transcripts by timestamp and relabels them with the current
  classifier. Only events still carrying the `imported:` placeholder are
  candidates, so it is idempotent and cannot touch natively recorded work.
- **Migration v6**, repricing imported history at this engine's rates. A rescued
  companion arrives carrying its previous host's XP on every event, numbers that
  meant something there and nothing here — a lifetime average of 7.5 xp against
  an engine whose cheapest observation pays 14. Levels are awarded if the
  corrected total now reaches them and never taken back, and the rewrite writes
  itself into the milestone list, because silently restating a companion's
  history should not happen without a trace.
- **Migration v7**, discarding energy left over from the retired model. v6
  repriced the XP but left the old energy value in place, and under the new
  rules that number means nothing: a buddy that had simply been busy came back
  reading 1%, which the new model would only produce twelve hours into one
  unbroken sitting. It would have corrected itself at the next break, but
  leaving a companion visibly sulking until then — for work it was thanked for
  under different rules — is the wrong way to land a change whose entire purpose
  was to stop punishing that work.
- CI running the build and tests on Node 24 and 26, and a Renovate config.

### Changed

- **Energy is a function of session length, not of work done.** It used to cost
  4 per observation against a regeneration clock, making break-even a
  twelve-minute gap between observations — but the measured median gap is ten
  minutes and the lower quartile three and a half, so a burst, the exact rhythm
  this server's own instructions ask for, was the fastest way to exhaust the
  buddy. It now drains eight per hour of elapsed session and nothing per
  observation: tired around nine hours in, empty at twelve and a half, full
  again after any real break.
- **The level curve is linear at 100 + 150n, with the stages carrying the
  rarity.** Coupling the two bought stage rarity at the price of a progress bar
  that did not visibly move for a week; they tune separately, so both improved
  and neither had to be traded. Elder, Ascendant, Astral and Eternal sit at 20,
  35, 60 and 100.
- **Energy caps the mood tier instead of nudging the score.** The `drained` term
  could never move the tier while the user was active, so a buddy on 15% energy
  rendered "feral with joy" directly above a reaction line drawn from the tired
  pool — one card claiming elation and exhaustion at once. The two remain
  separate axes, since you can be delighted and still be spent, but the card may
  not claim more animation than the buddy has left.
- The XP bar renders in eighths. Rounding to whole cells meant a wide level
  showed one block for days regardless of work done, and a progress bar that
  does not move after real progress states the opposite of the truth.
- `applyIdle` is now `applySessionEnergy`, the old name having described the
  opposite of what it does. The old export stays as a deprecated alias.
- Relicensed from ISC to Apache-2.0.

### Fixed

- **The plugin trust gate now fails closed.** `installedPlugins()` returned null
  when the manifest could not be read and the call site tested
  `installed && !installed.has(plugin)`, so a missing, malformed or reshaped
  manifest removed the gate entirely and re-admitted every cached plugin —
  including the ones Claude Code is deliberately refusing to load. Whether a
  plugin is trusted is the host's decision, and this process does not get to
  reverse it because a file went missing.
- **Skill frontmatter is bounded at the parse boundary** (name 64, description
  200). Neither had any limit, and `renderSkills` padded every used row out to
  the longest name, so a 4000-character name across ten used skills produced
  40kB of 89% whitespace — roughly 10k tokens of context per `buddy_skills`
  call. The render column is capped too, so rows already in the registry cannot
  exploit what the parse clamp now prevents.
- **Both destructive import paths run in one transaction.** They deleted the
  buddy, its events and its milestones before writing the replacement, so a
  throw in between left nothing — and unlike a corrupt database, which `load()`
  quarantines by renaming, there was nothing left to quarantine.
- **`classify()` scores position-weighted evidence** rather than taking the
  first match. Its `test` pattern matched the word anywhere in the string, and
  Claude Code's summary convention appends a verification clause, so
  "…(tests pass, vet clean)" filed the work as test-writing: 45% of 88 real
  summaries misclassified. `kind` keys skill affinity and sets the XP award, so
  every recommendation `buddy_advise` had learned was built on corrupted labels.
- **Migrations run in one transaction with rollback.** `migrate()` set
  `user_version` only after every step, so an interrupted run left a
  half-applied schema, and the unguarded `CREATE` in the v3 table rebuild made
  the retry throw — which makes `load()` quarantine the database and hatch a
  replacement buddy.
- **Project skills are scoped to their repository.** `./.claude/skills` belongs
  to one repo but every skill was stored in one global table keyed by name
  alone, so once two repos had project skills each listed, suggested and advised
  the other's, and two skills of the same name silently shadowed one another.
- **Discovery reconciles instead of only upserting**, so a skill that was
  uninstalled stops being recommended forever. It is flagged unavailable rather
  than deleted, so usage counters survive a reinstall.
- Skills from a cached but uninstalled plugin are no longer recommended and then
  failing to load with "Unknown skill"; `buddy_skills` names the plugin so the
  install can be fixed rather than the disappearance being a mystery.
- `syncMilestones` short-circuited when the row count matched, so any edit that
  preserved the count — renaming one, or replacing the oldest at the cap — was
  silently never written. It compares content now.
- `src/skills.ts` used raw NUL bytes as a composite-key separator, which tripped
  git's binary heuristic: the most security-sensitive file in the repo was the
  one file no reviewer could read a diff of. Written as `\0` escapes now, with
  `.gitattributes` so the guarantee does not depend on content sniffing.
- A 50 MB guard on whole-file transcript reads, and `npm ci --ignore-scripts` in
  CI, where two declared dependencies resolve 94 packages.

## 1.0.0

Initial server: buddies hatch on first use, gain XP from observed work, evolve
through six stages, and track mood, energy and daily streaks across sessions.
Five fixed personalities with per-category reaction lines, a summary classifier,
atomic state writes with corrupt-file quarantine, and an end-to-end MCP client
round-trip over stdio in the tests. State lives in `~/.buddy-mcp/` rather than
`~/.buddy/`, which belongs to a separate buddy implementation.
