import type { SandboxMemoryV1 } from '@cat-cafe/shared';
import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { ISandboxStore } from '../../../domains/sandbox/ports/SandboxStore.js';
import { foldRunsIntoMemory } from '../../../domains/sandbox/services/fold-runs-into-memory.js';
import { buildSandboxRunPrompt } from '../../../domains/sandbox/services/sandbox-run-prompt.js';
import { createModuleLogger } from '../../logger.js';
import type { TaskSpec_P1 } from '../types.js';
import type { DynamicTaskParams, TaskTemplate } from './types.js';

const log = createModuleLogger('scheduler/sandbox-run');

/**
 * Fold any run reports written since the last fold into the sandbox's rolling memory,
 * and return the memory this run should be briefed with.
 *
 * Never fatal: a sandbox that cannot fold should still run (and try again next time)
 * rather than skip the day entirely.
 */
async function foldPendingRuns(store: ISandboxStore, sandboxId: string): Promise<SandboxMemoryV1 | null> {
  const memory = await store.getMemory(sandboxId);
  try {
    // No limit: processedRunIds cannot rescue a report that was never read. With a
    // tail-500 window, sandbox #501 onwards would make the OLDEST unprocessed report
    // permanently invisible — it would sit on disk forever, never folded.
    const runs = await store.listRuns(sandboxId);
    const folded = foldRunsIntoMemory(memory, runs);

    // A promoted learning whose source report was rewritten is deliberately NOT updated
    // in place — the copy already exported out of the sandbox would silently desync.
    // Surface it instead, so the divergence is a visible decision rather than a quiet one.
    if (folded.divergedPromotedIds.length > 0) {
      log.warn(
        { sandboxId, learningIds: folded.divergedPromotedIds },
        'Promoted sandbox learnings diverge from their rewritten reports — local copy left unchanged',
      );
    }

    if (!folded.changed) return memory;
    await store.updateMemory(sandboxId, folded.memory);
    return folded.memory;
  } catch (err) {
    // Degrade, don't die: this run proceeds on the previous memory and the fold retries
    // next fire (the cursor makes it idempotent). But log it — a fold that keeps failing
    // looks exactly like a sandbox that has quietly stopped learning.
    log.warn({ err, sandboxId }, 'Failed to fold pending sandbox runs into memory — using previous memory');
    return memory;
  }
}

/** Instance ids minted for sandbox schedules. Also gates pre-fire defer (see below). */
export const SANDBOX_RUN_INSTANCE_PREFIX = 'sandbox-run-';

export function buildSandboxRunInstanceId(sandboxId: string): string {
  // sandboxId is `sandbox:sb-<uuid>`; strip the kind prefix so the instance id stays flat.
  return `${SANDBOX_RUN_INSTANCE_PREFIX}${sandboxId.replace(/^sandbox:/, '')}`;
}

function mintRunId(now: number): string {
  // Stable, sortable, filename-safe: run-20260811T163000000Z
  return `run-${new Date(now).toISOString().replace(/[-:.]/g, '')}`;
}

/**
 * F247 Phase C — A2A sandbox daily run.
 *
 * Wakes one sandbox member in the bound thread with an instruction built from the
 * CURRENT spec (read at fire time, so dev-pane edits apply to the next run) plus the
 * accumulated sandbox memory (so the run compounds instead of restarting from zero).
 *
 * The run is closed out by the cat writing a report into `.a2a-sandbox/runs/`, which
 * the sandbox store reads back — see sandbox-run-prompt.ts for why the closure goes
 * through the filesystem rather than a completion callback.
 */
export const sandboxRunTemplate: TaskTemplate = {
  templateId: 'sandbox-run',
  label: 'A2A 沙盒运行',
  category: 'thread',
  description: '按沙盒 spec 定义的节奏唤醒成员执行一次运行，结论写回沙盒目录',
  subjectKind: 'thread',
  defaultTrigger: { type: 'cron', expression: '0 9 * * *' },
  paramSchema: {
    sandboxId: { type: 'string', required: true, description: '沙盒 ID' },
    triggerUserId: { type: 'string', required: false, description: '归属用户（沙盒创建者）' },
  },
  createSpec(instanceId: string, p: DynamicTaskParams): TaskSpec_P1 {
    const sandboxId = (p.params.sandboxId as string) || '';
    const triggerUserId = (p.params.triggerUserId as string) || 'default-user';
    const threadId = p.deliveryThreadId;

    // Dev pane and run pane share one thread. If the user is mid-edit on the spec when
    // cron fires, defer rather than interrupting them — and rather than running against
    // a spec that is being rewritten right now.
    // Mirrors reminder.ts's security gate: only ids minted by the sandbox routes
    // (`sandbox-run-*`) can activate pre-fire defer, so a forged param on a public
    // `dyn-*` task cannot turn it on.
    const canDefer = instanceId.startsWith(SANDBOX_RUN_INSTANCE_PREFIX);

    return {
      id: instanceId,
      profile: 'awareness',
      trigger: p.trigger,
      ...(canDefer && threadId ? { firePolicy: { deferWhileThreadBusy: true, threadId } } : {}),
      admission: {
        async gate() {
          if (!threadId) return { run: false, reason: 'no deliveryThreadId' };
          if (!sandboxId) return { run: false, reason: 'no sandboxId' };
          return { run: true, workItems: [{ signal: sandboxId, subjectKey: `thread-${threadId}` }] };
        },
      },
      run: {
        overlap: 'skip',
        timeoutMs: 30_000,
        async execute(signal, subjectKey, ctx) {
          if (!ctx.deliver) throw new Error('deliver not available');
          if (!ctx.sandboxStore) throw new Error('sandboxStore not available');

          const tid = subjectKey.startsWith('thread-') ? subjectKey.slice(7) : subjectKey;
          const sid = typeof signal === 'string' ? signal : sandboxId;

          const sandbox = await ctx.sandboxStore.get(sid);
          if (!sandbox) {
            // Sandbox deleted but schedule survived — do not wake a cat into a void.
            throw new Error(`sandbox ${sid} not found`);
          }
          if (sandbox.status === 'paused' || sandbox.status === 'archived') return;

          // Read CURRENT spec + memory at fire time: this is what makes the dev pane a
          // live control surface instead of a one-shot setup form.
          //
          // Fold first: reports written since the last fire (by the previous scheduled
          // run, a manual run, or a cat that finished late) become accumulated knowledge
          // now, so THIS run is briefed on them. Doing it here rather than on a separate
          // job is what makes the loop self-healing — however a report arrived, the next
          // run picks it up, and the fold is idempotent so re-reading the directory
          // cannot double-count.
          const memory = await foldPendingRuns(ctx.sandboxStore, sid);
          const runId = mintRunId(Date.now());
          const triggeredAt = Date.now();
          const prompt = buildSandboxRunPrompt({
            spec: sandbox.spec,
            memory,
            runId,
            trigger: 'scheduled',
            triggeredAt,
          });

          const content = `${SCHEDULER_TRIGGER_PREFIX} ${prompt}`;

          // Store the trigger message first so the invocation has a real messageId.
          const messageId = await ctx.deliver({
            threadId: tid,
            content,
            userId: 'scheduler',
            ...(ctx.invokeTrigger ? { extra: { scheduler: { hiddenTrigger: true } } } : {}),
          });

          // v1: members are fixed and a single runner executes the day's work. Waking all
          // members daily would multiply cost and produce N competing reports for one run
          // record. Multi-member run policy is a spec-level decision deferred to v2.
          //
          // No hardcoded member fallback: the sandbox declares its own members, and if a
          // deployment has none of them, waking some unrelated default is worse than
          // failing loudly — the run would execute under an identity the spec never chose.
          const runner = sandbox.spec.members[0] ?? sandbox.members[0] ?? ctx.assignedCatId;
          if (!runner) {
            throw new Error(`sandbox ${sid} has no runnable member (spec.members and sandbox.members are empty)`);
          }

          if (ctx.invokeTrigger) {
            try {
              void Promise.resolve(
                ctx.invokeTrigger.trigger(tid, runner, triggerUserId, content, messageId, undefined, {
                  sourceCategory: 'scheduled',
                }),
              ).catch((err: unknown) => {
                // Dispatch is fire-and-forget, so this is the ONLY place a failed wake-up
                // can surface. Swallowing it silently means a sandbox that looks scheduled
                // but never actually runs.
                log.warn({ err, sandboxId: sid, runner, threadId: tid }, 'Sandbox run dispatch failed');
              });
            } catch (err) {
              log.warn({ err, sandboxId: sid, runner, threadId: tid }, 'Sandbox run trigger threw synchronously');
            }
          }
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: {
        label: `沙盒运行 · ${sandboxId.slice(0, 20)}`,
        category: 'thread',
        description: '按沙盒 spec 执行一次运行',
        subjectKind: 'thread',
      },
    };
  },
};
