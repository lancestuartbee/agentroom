'use client';

import type { Sandbox, SandboxMemoryV1, SandboxRunRecordV1 } from '@cat-cafe/shared';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F247 Phase D — the sandbox RUN pane (right half of the dual-pane layout).
 *
 * The left half is the dev pane: an ordinary conversation where the operator and the
 * members shape the spec. This half is the run pane: what the sandbox has actually been
 * doing while nobody was watching. The operator is meant to be "on the loop", not "in
 * it" — so this is a read surface plus exactly one action (run once now).
 *
 * Everything here is derived from the reports on disk via GET /runtime. It deliberately
 * does NOT keep its own model of the runs: the backend already treats the directory as
 * the source of truth, and a second, drifting copy in the browser is precisely the class
 * of bug this feature has spent its whole review cycle removing.
 */

interface RuntimeState {
  sandbox: Sandbox;
  memory: SandboxMemoryV1 | null;
  runs: SandboxRunRecordV1[];
  runsAvailable: boolean;
  runsError?: string;
}

const POLL_INTERVAL_MS = 30_000;

function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString();
}

function statusLabel(status: Sandbox['status']): string {
  if (status === 'active') return '运行中';
  if (status === 'paused') return '已暂停';
  return '已归档';
}

export function SandboxRunPane(): JSX.Element | null {
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const threads = useChatStore((s) => s.threads);
  const sandboxId = threads.find((t) => t.id === currentThreadId)?.sandboxId;

  const [state, setState] = useState<RuntimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerNote, setTriggerNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sandboxId) return;
    try {
      const res = await apiFetch(`/api/sandboxes/${encodeURIComponent(sandboxId)}/runtime`);
      if (!res.ok) {
        setError(`无法读取沙盒运行态（HTTP ${res.status}）`);
        return;
      }
      setState((await res.json()) as RuntimeState);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取沙盒运行态');
    }
  }, [sandboxId]);

  // A failed poll leaves the last good snapshot on screen. That is the right call — an
  // empty pane would be worse — but only if the operator can tell it is frozen. Silently
  // showing stale runs as current is the same class of lie the backend refuses to tell
  // when it distinguishes "unreadable" from "never ran".
  const isStale = state !== null && error !== null;

  useEffect(() => {
    void load();
    // The run loop fires on a daily cadence, so this poll only needs to catch a manual
    // run or a report the member wrote mid-conversation.
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const runNow = useCallback(async () => {
    if (!sandboxId || triggering) return;
    setTriggering(true);
    setTriggerNote(null);
    try {
      const res = await apiFetch(`/api/sandboxes/${encodeURIComponent(sandboxId)}/run`, { method: 'POST' });
      if (res.ok) {
        // Dispatch is fire-and-forget: the member has been woken, but its report will
        // not exist for a while. Say so, rather than implying the run has finished.
        setTriggerNote('已触发运行。成员开始执行后，运行结果会写入报告并出现在下方。');
        void load();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setTriggerNote(body.error ?? `触发失败（HTTP ${res.status}）`);
      }
    } catch (err) {
      setTriggerNote(err instanceof Error ? err.message : '触发失败');
    } finally {
      setTriggering(false);
    }
  }, [sandboxId, triggering, load]);

  if (!sandboxId) return null;

  if (error && !state) {
    return (
      <div className="p-4 text-sm text-[var(--console-text-muted)]" data-testid="sandbox-run-pane-error">
        {error}
      </div>
    );
  }
  if (!state) {
    return (
      <div className="p-4 text-sm text-[var(--console-text-muted)]" data-testid="sandbox-run-pane-loading">
        正在读取运行态…
      </div>
    );
  }

  const { sandbox, memory, runs, runsAvailable, runsError } = state;
  const schedule = sandbox.spec.schedule;
  const learned = memory?.learnedItems ?? [];

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 gap-4 text-sm" data-testid="sandbox-run-pane">
      {isStale && (
        <div
          className="px-3 py-2 rounded border border-[var(--console-border)] text-[var(--console-text-muted)]"
          data-testid="sandbox-stale-banner"
        >
          下面显示的是上一次成功读取的数据，可能已过期（{error}）
        </div>
      )}

      <section className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">运行态 · {sandbox.title}</h2>
          <span data-testid="sandbox-status">{statusLabel(sandbox.status)}</span>
        </div>
        <div className="text-[var(--console-text-muted)]">
          {schedule?.cron ? (
            <span data-testid="sandbox-schedule">
              定时：{schedule.cron}
              {schedule.timezone ? `（${schedule.timezone}）` : ''}
            </span>
          ) : (
            <span data-testid="sandbox-schedule">未设置定时，仅手动运行</span>
          )}
        </div>
        <div className="text-[var(--console-text-muted)]" data-testid="sandbox-backflow">
          学习成果回流：{sandbox.settings.allowBackflow ? '开启' : '关闭'}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void runNow()}
          disabled={triggering || sandbox.status !== 'active'}
          data-testid="sandbox-run-now"
          className="px-3 py-1.5 rounded border border-[var(--console-border)] disabled:opacity-50"
        >
          {triggering ? '触发中…' : '立即运行一次'}
        </button>
        {sandbox.status !== 'active' && (
          <span className="text-[var(--console-text-muted)]">沙盒已暂停，恢复后才能运行。</span>
        )}
        {triggerNote && (
          <span className="text-[var(--console-text-muted)]" data-testid="sandbox-trigger-note">
            {triggerNote}
          </span>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-medium">已积累的认知</h3>
        <div className="text-[var(--console-text-muted)]" data-testid="sandbox-runs-incorporated">
          已纳入 {memory?.runsIncorporated ?? 0} 次运行
          {memory?.lastRunAt ? ` · 最近 ${formatTime(memory.lastRunAt)}` : ''}
        </div>
        {learned.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="sandbox-learnings">
            {learned
              .slice(-20)
              .reverse()
              .map((item) => (
                <li key={item.id}>· {item.content}</li>
              ))}
          </ul>
        ) : (
          <span className="text-[var(--console-text-muted)]">还没有沉淀下来的结论。</span>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-medium">运行历史</h3>
        {/* "unreadable" and "never ran" are different facts, and the backend goes out of
            its way to keep them apart — so the pane must not collapse them into one
            empty list. */}
        {!runsAvailable ? (
          <span className="text-[var(--console-text-muted)]" data-testid="sandbox-runs-unavailable">
            {runsError ?? '暂时读不到运行历史'}（沙盒本身正常，稍后重试）
          </span>
        ) : runs.length === 0 ? (
          <span className="text-[var(--console-text-muted)]" data-testid="sandbox-runs-empty">
            还没有运行过。
          </span>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="sandbox-runs">
            {runs.map((run) => (
              <li key={run.runId} className="flex flex-col">
                <span className="text-[var(--console-text-muted)]">
                  {formatTime(run.triggeredAt)} · {run.trigger === 'scheduled' ? '定时' : '手动'}
                </span>
                <span>{run.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
