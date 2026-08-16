import { z } from 'zod';

/**
 * F247 — the one contract for an A2A sandbox schedule.
 *
 * This existed as two hand-written copies: one in the API route, one in the MCP tool. They
 * drifted exactly once and it cost a production path — the server was relaxed to accept a
 * cron-only edit, the tool was not, so `cat_cafe_sandbox_update_spec({schedule:{cron}})`
 * was rejected locally and the request the fix was written for never left the process.
 * Two suites can prove today's copies agree; neither can stop tomorrow's edit to one side.
 *
 * The asymmetry below is the actual rule, and it is why a plain `.partial()` is wrong:
 *
 *  - EDITING an existing schedule takes a fragment. A member told "把它改到 9 点" knows the
 *    new cron and has never seen the stored prompt or timezone; demanding the whole object
 *    would either fail that ordinary request or silently drop the timezone.
 *  - CREATING the first schedule takes the whole thing. There is nothing to merge onto, so
 *    a fragment persists a `SandboxScheduleV1` missing its required `prompt` — an object
 *    the type system says cannot exist, handed to the scheduler as if it were valid.
 */
export const sandboxScheduleSchema = z
  .object({
    cron: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(2000),
    timezone: z.string().trim().max(100).optional(),
  })
  .strict();

/** The fragment shape accepted on the wire. Completeness is decided against stored state. */
export const sandboxSchedulePatchSchema = sandboxScheduleSchema.partial();

export type SandboxSchedulePatch = z.infer<typeof sandboxSchedulePatchSchema>;
export type SandboxScheduleShape = z.infer<typeof sandboxScheduleSchema>;

export type SandboxScheduleMergeResult = { ok: true; schedule: SandboxScheduleShape } | { ok: false; error: string };

/**
 * Merge a schedule fragment onto what is stored, refusing anything that would persist an
 * invalid schedule.
 *
 * This is the MEMBER path's rule. The operator route does not merge — its schema demands a
 * complete schedule and replaces, because an operator holding the whole object may mean
 * "and no timezone", while a member knows only the field they were asked to change. Both
 * paths share the invariant that matters (nothing invalid is ever persisted) and reach it
 * differently on purpose; an earlier comment here claimed both called this function, which
 * was simply false.
 */
export function mergeSandboxSchedule(
  existing: SandboxScheduleShape | undefined,
  patch: SandboxSchedulePatch,
): SandboxScheduleMergeResult {
  const merged = { ...(existing ?? {}), ...patch };
  if (!merged.cron) {
    return { ok: false, error: 'This sandbox has no schedule yet — say when it should run (cron)' };
  }
  if (!merged.prompt) {
    return {
      ok: false,
      error: 'This sandbox has no schedule yet — say what it should do when it fires (prompt)',
    };
  }
  return {
    ok: true,
    schedule: {
      cron: merged.cron,
      prompt: merged.prompt,
      ...(merged.timezone ? { timezone: merged.timezone } : {}),
    },
  };
}
