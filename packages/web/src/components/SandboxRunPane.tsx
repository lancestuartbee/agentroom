'use client';

import type { Sandbox, SandboxMemoryV1, SandboxRunRecordV1 } from '@cat-cafe/shared';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useSandboxResource } from '@/hooks/useSandboxResource';
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

const buildRuntimePath = (id: string) => `/api/sandboxes/${encodeURIComponent(id)}/runtime`;

export function SandboxRunPane({ threadId }: { threadId: string | null | undefined }): JSX.Element | null {
  // The thread comes from the parent, NOT from the global `currentThreadId`. ChatContainer
  // syncs the thread it is rendering into the store from an effect, so for one render/effect
  // window after a switch the global still says A while the pane belongs to B. Deriving the
  // sandbox from the global there does not just paint the wrong history — it aims "立即运行"
  // at a sandbox the operator has already left. useSandboxResource guards responses; it
  // cannot rescue a request that was addressed wrongly before it was sent.
  const sandboxId = useChatStore((s) => s.threads.find((t) => t.id === threadId)?.sandboxId);

  const [triggering, setTriggering] = useState(false);
  const [triggerNote, setTriggerNote] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [promoteNote, setPromoteNote] = useState<string | null>(null);

  // A trigger note is about one sandbox's run; carrying it across a switch would tell the
  // operator something about B that only ever happened to A.
  useEffect(() => {
    setTriggerNote(null);
    setTriggering(false);
    setPromotingId(null);
    setPromoteNote(null);
  }, [sandboxId]);

  // A failed poll still leaves the last good snapshot on screen — an empty pane would be
  // worse — but only labelled as stale, because silently showing old runs as current is the
  // same class of lie the backend refuses to tell when it distinguishes "unreadable" from
  // "never ran".
  const {
    data: state,
    error,
    isStale,
    reload: load,
    isCurrent,
  } = useSandboxResource<RuntimeState>(sandboxId, buildRuntimePath, {
    // The run loop fires on a daily cadence, so this poll only needs to catch a manual run
    // or a report the member wrote mid-conversation.
    intervalMs: POLL_INTERVAL_MS,
    errorMessage: '无法读取沙盒运行态',
  });

  const runNow = useCallback(async () => {
    const targetId = sandboxId;
    if (!targetId || triggering) return;
    setTriggering(true);
    setTriggerNote(null);
    try {
      const res = await apiFetch(`/api/sandboxes/${encodeURIComponent(targetId)}/run`, { method: 'POST' });
      // Everything past this await belongs to the sandbox the click started on. Clearing
      // the note when the thread changes only clears the value that exists AT the switch;
      // a reply still in flight puts it back. Worse than a wrong note: the success branch
      // calls load(), and that closure was captured on A — it refetches A and its
      // generation bump blanks B's pane. Writing another sandbox's outcome is the visible
      // symptom; stealing the current one's data is the expensive one.
      if (!isCurrent(targetId)) return;
      if (res.ok) {
        // Dispatch is fire-and-forget: the member has been woken, but its report will
        // not exist for a while. Say so, rather than implying the run has finished.
        setTriggerNote('已触发运行。成员开始执行后，运行结果会写入报告并出现在下方。');
        void load();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!isCurrent(targetId)) return;
        setTriggerNote(body.error ?? `触发失败（HTTP ${res.status}）`);
      }
    } catch (err) {
      if (isCurrent(targetId)) setTriggerNote(err instanceof Error ? err.message : '触发失败');
    } finally {
      if (isCurrent(targetId)) setTriggering(false);
    }
  }, [sandboxId, triggering, load, isCurrent]);

  const promote = useCallback(
    async (itemId: string) => {
      const targetId = sandboxId;
      if (!targetId || promotingId === itemId) return;
      setPromotingId(itemId);
      setPromoteNote(null);
      try {
        const res = await apiFetch(
          `/api/sandboxes/${encodeURIComponent(targetId)}/learned-items/${encodeURIComponent(itemId)}/promote`,
          { method: 'POST' },
        );
        if (!isCurrent(targetId)) return;
        if (res.ok) {
          setPromoteNote('已提升为系统知识。');
          void load();
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!isCurrent(targetId)) return;
          setPromoteNote(body.error ?? `提升失败（HTTP ${res.status}）`);
        }
      } catch (err) {
        if (isCurrent(targetId)) setPromoteNote(err instanceof Error ? err.message : '提升失败');
      } finally {
        if (isCurrent(targetId)) setPromotingId(null);
      }
    },
    [sandboxId, promotingId, load, isCurrent],
  );

  if (!sandboxId) return null;

  if (error && !state) {
    return (
      <div className="p-4 text-sm text-[var(--console-text-muted)]" data-testid="sandbox-run-pane-error">
        {error}
      </div>
    );
  }
  // A 200 whose body has no sandbox in it is not data. Destructuring it used to white-screen
  // the pane; calling it "正在读取运行态…" instead was barely better — the operator waits
  // forever for a shape the response is never going to take. It is unreadable, which is a
  // state this pane already knows how to say.
  if (state && !state.sandbox) {
    return (
      <div className="p-4 text-sm text-[var(--console-text-muted)]" data-testid="sandbox-run-pane-error">
        运行态响应格式不对，读不出这个沙盒。
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

      {promoteNote && (
        <div className="text-xs text-[var(--console-text-muted)]" data-testid="sandbox-promote-note">
          {promoteNote}
        </div>
      )}

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
                <li key={item.id} className="flex items-start justify-between gap-2">
                  <span className="flex-1">· {item.content}</span>
                  {sandbox.settings.allowBackflow && !item.promoted && (
                    <button
                      type="button"
                      onClick={() => void promote(item.id)}
                      disabled={promotingId === item.id}
                      data-testid={`sandbox-promote-${item.id}`}
                      className="shrink-0 text-xs px-2 py-0.5 rounded border border-[var(--console-border)] disabled:opacity-50"
                    >
                      {promotingId === item.id ? '提升中…' : '提升为系统知识'}
                    </button>
                  )}
                  {item.promoted && <span className="shrink-0 text-xs text-[var(--console-text-muted)]">已提升</span>}
                </li>
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
