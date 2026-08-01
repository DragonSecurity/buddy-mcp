# Security backlog: buddy-mcp

2026-08-01 · from `2026-08-01-audit-buddy-mcp.md` · workable without reading the report

> **Status: all 10 rows applied 2026-08-01.** Build clean, 167/167 tests pass
> including 12 new regressions in `test/hardening.test.js`. The three F1 bypasses
> were re-run against the rebuilt `dist/` and all three are closed. Rows are kept
> below as the record of what changed and why.

Ranked by risk reduction per unit of effort. Rows 1–3 are one focused sitting.

| # | Change | File | Closes | Effort |
| --- | --- | --- | --- | --- |
| 1 | Make `installedPlugins()` return `Set<string>` instead of `Set \| null`, returning an **empty set** on any read/parse failure. Drop the `installed &&` guard at the call site so an empty set excludes all plugin skills. Personal and project skills are unaffected. | `src/skills.ts:97`, `:141`, `:145` | F1 | S |
| 2 | Surface the degradation: when the manifest is unreadable, add `⚠️ plugin manifest unreadable — plugin skills excluded` to `renderSkills`, next to the existing "cached but not installed" warning. Without this, row 1 turns a silent over-trust into a silent under-report. | `src/skills.ts`, `src/render.ts:168` | F1 | S |
| 3 | Clamp frontmatter at parse time: `name` to 64 chars, `description` to 200, in `readFrontmatter` before returning. Fixes every downstream consumer at once. | `src/skills.ts:36-53` | F2 | S |
| 4 | Clamp the render column width: `Math.min(40, Math.max(...stats.map(s => s.name.length)))`. Defends rows already in the registry from before row 3 existed. | `src/render.ts:153` | F2 | S |
| 5 | Filter `uninstalledPlugins()` output to `[A-Za-z0-9._-]{1,64}` and cap the rendered list at 10 entries with an "and N more" suffix. | `src/skills.ts:109-126` | F3 | S |
| 6 | Wrap the destructive import in `BEGIN IMMEDIATE` / `COMMIT` with `ROLLBACK` on throw, matching the pattern already used in `backfillFromTranscripts`. | `src/import.ts:347-350` | F5 | S |
| 7 | Clamp `name` to 32 and `bio` to 500 at import. The `buddy_rename` tool path already enforces 32 via zod; the import path bypasses it. | `src/import.ts:316`, `:322`, `:324` | F4 | S |
| 8 | Add `--ignore-scripts` to the CI install step: `npm ci --ignore-scripts`. Build and tests need no lifecycle scripts. | `.github/workflows/ci.yml:32` | F6 | S |
| 9 | Add `.claude/settings.local.json` to `.gitignore`. Leave `.dragon-buddy/config.json` tracked. | `.gitignore` | F7 | S |
| 10 | Add a size guard to transcript reads — `statSync` and skip files over ~50 MB — rather than `readFileSync` on every `.jsonl` unconditionally. Robustness, not security. | `src/backfill.ts:52` | cleanup | S |

## Regression tests worth writing

The repo already has good `node --test` coverage and existing scoping tests in
`test/skills.test.js` and `test/scoping.test.js` to model these on.

| Test | Asserts | Covers |
| --- | --- | --- |
| Manifest deleted ⇒ no plugin skills discovered | `discoverSkills()` returns no `plugin:*` entries when `installed_plugins.json` is absent | F1 |
| Manifest malformed ⇒ no plugin skills discovered | same, with `{ oops` as the file body | F1 |
| Manifest valid but missing `plugins` key ⇒ no plugin skills | same, with `{"version":2,"installed":{}}` — the shape-drift case, which needs no attacker | F1 |
| Manifest valid ⇒ listed plugins still discovered | guards against row 1 over-correcting into fail-closed-always | F1 |
| 4,000-char `name` ⇒ stored name ≤ 64 | truncation happens at parse, not render | F2 |
| 4,000-char `name` + 10 used skills ⇒ `renderSkills` output < 8 KB | the amplification is actually gone (pre-fix baseline: 40,556 bytes) | F2 |
| Import throwing mid-write ⇒ prior buddy still intact | inject a failure after the DELETEs and assert rollback | F5 |

## Notes for whoever picks this up

- **Rows 1 and 2 ship together.** Row 1 alone converts a silent over-trust into a silent
  under-report — the user sees fewer skills and is told nothing. That trades one invisible
  failure for another.
- **Row 3 before row 4**, but ship both. Row 3 fixes new data, row 4 defends against rows
  already written to the registry by an earlier version.
- **Nothing here is blocked on a design decision.** Every row is S. There is no Critical, so
  none of this is on fire — but rows 1–3 should land before the npm publish, because
  publishing changes who bears the risk from you to every installer.
