import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How often work gets recorded without being asked.
 *
 * The dragon-dev-buddy pack ships a Stop hook that blocks a turn which changed
 * code and never called buddy_observe. That gate is either load-bearing or it is
 * ceremony, and nothing here could tell the difference — the buddy sees an
 * observation arrive and cannot know whether it came freely or under duress.
 * Both produce identical XP.
 *
 * The gate's own log distinguishes them, as a side effect of how it works rather
 * than by design. It marks a session dirty on an edit and clears the mark on an
 * observation, and it clears the mark *before* blocking so a failure to nag can
 * never wedge a session. That ordering is what makes this measurable:
 *
 *   clear with had:true   the mark was still there, so the observation came
 *                         first: recorded unprompted.
 *   stop with block:true  the turn changed code and ended without recording:
 *                         the gate had to ask.
 *
 * Every code-changing turn produces exactly one of the two, which is why they
 * sum to a total rather than overlapping. A `clear` with had:false is neither —
 * it is an observation on a turn that changed nothing, or the one that follows a
 * nag — and is deliberately not counted on either side. Neither is a `reset`,
 * which pack 1.3.1 writes when a new prompt drops a mark left by a turn that has
 * already ended: nothing recorded, and nothing was asked to.
 *
 * That reset is also why the ratio is only honest going forward. Before it, a
 * mark could outlive its turn — a background agent's edit, an interrupted turn,
 * a session resumed by id — and be consumed by the next Stop, so some share of
 * every `stop`/block:true logged before 2026-08-10 belongs to a turn that
 * changed nothing. The window forgets them at its own pace; nothing here
 * rewrites them.
 *
 * Reading a file another project writes is a real coupling and worth naming.
 * It is one-directional, the format is append-only JSON lines, and an absent or
 * unreadable file means the pack is not installed — which is not an error, just
 * a buddy with nothing to say on the subject.
 */

/** Where the pack's gate writes. Overridable so tests need no home directory. */
export function gateLogPath(): string {
  return process.env.BUDDY_GATE_LOG || join(homedir(), '.claude', 'buddy-gate.log');
}

export interface Compliance {
  /** Code-changing turns that recorded before the gate had to ask. */
  voluntary: number;
  /** Code-changing turns the gate had to block. */
  prompted: number;
  /** voluntary + prompted — every turn that changed code and was seen. */
  total: number;
  /** voluntary / total, 0..1. */
  rate: number;
  /** Size of the window in days. */
  window: number;
  /**
   * Blocks discarded because the turn had already recorded: the mark that
   * tripped them was written *after* the observation, by an edit later in the
   * same turn. Counted in neither `voluntary` nor `prompted`, and exposed only
   * so the exclusion is visible rather than silent.
   */
  rearmed: number;
}

/**
 * Count the window's gate events. Returns null when there is nothing to say:
 * no log, no readable log, or no code-changing turns inside the window. A card
 * line built from two events is noise, so the caller renders nothing.
 */
export function compliance(now: Date, window = 30): Compliance | null {
  let raw: string;
  try {
    raw = readFileSync(gateLogPath(), 'utf8');
  } catch {
    return null; // pack not installed, or not ours to read
  }

  // The gate stamps local time without an offset, so it is parsed the same way
  // it was written. Comparing it against a UTC instant would shift the window
  // edge by the offset and silently drop or admit a day.
  const cutoff = new Date(now.getTime() - window * 86_400_000);

  let voluntary = 0;
  let prompted = 0;
  let rearmed = 0;

  /**
   * Whether the turn currently open in each session has already recorded.
   *
   * A `stop` with block:true is not by itself evidence that a turn failed to
   * record. The gate marks the session dirty on every edit and clears the mark
   * on every observation, in tool order — so a turn that records and *then*
   * edits again ends with a fresh mark standing, and gets blocked for work it
   * already reported. The second observation the block extracts is a duplicate:
   * it pays XP twice and lands in the log as a `clear` with had:false.
   *
   * Seen on 2026-08-10, in the session that prompted this fix:
   *
   *   18:14:57  clear  had:true                 recorded, voluntarily
   *   18:15:30  mark   Edit                     a memory file, after the fact
   *   18:15:52  stop   block:true  markedAt:18:15:30
   *   18:16:01  clear  had:false                the duplicate
   *
   * Counting that `stop` as prompted charges one turn to both columns, which is
   * the one thing this metric exists not to do: it inflates the nagged count
   * with turns that did exactly what was asked, and every such turn also adds a
   * phantom to `total`.
   *
   * The gate logs `markedAt` on the block precisely so the two cases can be
   * told apart, and it is tempting to use it directly — but it is absent from
   * entries written before it was added, and when the flag below is set it is
   * necessarily later than the clear anyway. Turn-scoped state is both simpler
   * and correct on older logs.
   */
  const recorded = new Map<string, boolean>();
  const sessionOf = (event: { session?: unknown }) => String(event.session ?? 'unknown');

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a truncated final line is normal for an append-only log
    }

    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < cutoff.getTime()) continue;

    const session = sessionOf(event);

    if (event.event === 'clear') {
      // had:true is a turn that recorded before anything asked it to. had:false
      // is not counted — it is either an observation on a turn that changed
      // nothing, or the duplicate that follows a nag. Both still prove the turn
      // called buddy_observe, which is what the flag tracks.
      if (event.had === true) voluntary++;
      recorded.set(session, true);
    } else if (event.event === 'reset') {
      // UserPromptSubmit: a new turn begins, so nothing it inherits is evidence.
      recorded.set(session, false);
    } else if (event.event === 'stop') {
      if (event.block === true) {
        if (recorded.get(session)) rearmed++;
        else prompted++;
      }
      // The turn is over either way. Pre-1.3.1 logs carry no `reset`, so this is
      // the only boundary they have; a turn interrupted before Stop ran leaks
      // its flag into the next one, which can only ever suppress a block that
      // should have counted. Undercounting nags is the safe direction to err.
      recorded.set(session, false);
    }
  }

  const total = voluntary + prompted;
  if (total === 0) return null;

  return { voluntary, prompted, total, rate: voluntary / total, window, rearmed };
}
