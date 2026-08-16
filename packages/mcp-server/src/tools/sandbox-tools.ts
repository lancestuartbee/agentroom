import { sandboxSchedulePatchSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { buildAuthHeaders, getCallbackConfig, NO_CONFIG_ERROR } from './callback-tools.js';
import { errorResult, successResult, type ToolResult } from './file-tools.js';

/**
 * F247 AC-D4 — the dev pane's write path, from the member's side.
 *
 * In A2A sandbox mode the operator shapes the project by TALKING to a member: "run at
 * 09:00 Shanghai time", "also track turnover". The member turns that into a spec edit,
 * and the spec is the only interface between the dev pane and the run pane.
 *
 * Two things are deliberately absent from the input:
 *
 *  - No sandbox id. The target is derived server-side from the caller's own invocation
 *    thread, so a member editing someone else's sandbox is structurally impossible
 *    rather than merely rejected.
 *  - No file path. A member could write spec.yaml directly — it has the directory — but
 *    that persists the change without reconverging the cron, so a schedule edit would
 *    silently do nothing until a restart. Going through the API is what makes "edit
 *    now, applies on the next run" true rather than aspirational.
 */

/**
 * NESTED-PARTIAL, and it must stay that way.
 *
 * The natural request is "move it to 09:00": the member knows the new cron and has never
 * seen the stored prompt or timezone. Review found this schema once demanding the whole
 * object after the API had been relaxed — so the tool rejected the request locally and
 * never even reached the fixed endpoint.
 *
 * EXTENDED from the shared object, not reassembled from its field shapes. The first
 * attempt at removing the duplicate rebuilt a fresh `z.object()` out of
 * `sandboxSchedulePatchSchema.shape`: the field rules came across but `.strict()` did not,
 * so the tool quietly accepted and stripped `{cron, futureField}` while the API rejected
 * it. Same divergence class, one layer down — found by probing key parity, which is
 * something neither side's own tests could ever notice. Extending carries the unknown-key
 * policy with it. Only the prose is local, because the model needs wording the server has
 * no use for.
 */
const scheduleSchema = sandboxSchedulePatchSchema.extend({
  cron: sandboxSchedulePatchSchema.shape.cron.describe(
    'Cron expression, e.g. "0 9 * * *" for 09:00 daily. Required when no schedule exists yet.',
  ),
  prompt: sandboxSchedulePatchSchema.shape.prompt.describe(
    'What to do when it fires. Omit to keep the stored value; required when creating the first schedule.',
  ),
  timezone: sandboxSchedulePatchSchema.shape.timezone.describe(
    'IANA timezone such as Asia/Shanghai. Omit to keep the stored one — never guess it.',
  ),
});

export const sandboxUpdateSpecInputSchema = {
  name: z.string().trim().min(1).max(200).optional().describe('Display name of the sandbox project.'),
  goal: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe('What this sandbox is for. Rewritten in full — send the complete new goal, not a delta.'),
  learningGoal: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe('What the sandbox should accumulate over time, as opposed to what it does each run.'),
  schedule: scheduleSchema
    .optional()
    .describe('Run cadence. Send only the fields you are changing; editing this re-registers the scheduled task.'),
};

const inputObject = z.object(sandboxUpdateSpecInputSchema);

export async function handleSandboxUpdateSpec(input: unknown): Promise<ToolResult> {
  const parsed = inputObject.safeParse(input);
  if (!parsed.success) {
    return errorResult(`Invalid sandbox spec update: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }

  const spec = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  if (Object.keys(spec).length === 0) {
    return errorResult('Nothing to update — provide at least one of name, goal, learningGoal or schedule.');
  }

  const config = getCallbackConfig();
  if (!config) return errorResult(NO_CONFIG_ERROR);

  try {
    const response = await fetch(`${config.apiUrl}/api/callback/sandbox/spec`, {
      method: 'PATCH',
      headers: { ...buildAuthHeaders(config), 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      // 404 is the common, meaningful case: this thread has no sandbox. Say that plainly
      // so the member reports it instead of retrying a call that can never work.
      if (response.status === 404) {
        return errorResult(body.error ?? 'This thread is not an A2A sandbox, so there is no spec to update.');
      }
      return errorResult(body.error ?? `Failed to update sandbox spec (HTTP ${response.status})`);
    }

    const body = (await response.json()) as { sandbox?: { spec?: Record<string, unknown> } };
    const updated = body.sandbox?.spec ?? {};
    return successResult(
      [
        'Sandbox spec updated. It takes effect on the next run — the schedule has already been reconverged.',
        JSON.stringify(updated, null, 2),
      ].join('\n\n'),
    );
  } catch (err) {
    return errorResult(`Failed to update sandbox spec: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const sandboxTools = [
  {
    name: 'cat_cafe_sandbox_update_spec',
    description:
      'Update the A2A sandbox spec for THIS thread (F247 dev pane). Use when the operator asks to change what the sandbox does, what it should learn, or when it runs. The sandbox is resolved from your own thread — you cannot edit another one, and you must not edit spec.yaml directly, because only this path re-registers the schedule. Changes apply on the next run.',
    inputSchema: sandboxUpdateSpecInputSchema,
    handler: handleSandboxUpdateSpec,
  },
];
