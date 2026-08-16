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

const scheduleSchema = z.object({
  cron: z
    .string()
    .min(1)
    .max(100)
    .describe('Cron expression, e.g. "0 9 * * *" for 09:00 daily. Omit the schedule field to leave it unchanged.'),
  prompt: z.string().min(1).max(2000).describe('Kept for compatibility; the run instruction is built from the spec.'),
  timezone: z
    .string()
    .max(100)
    .optional()
    .describe('IANA timezone such as Asia/Shanghai. Strongly recommended: "09:00" is meaningless without it.'),
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
  schedule: scheduleSchema.optional().describe('Run cadence. Editing this re-registers the scheduled task.'),
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
