'use client';

import type { Sandbox } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { useSandboxResource } from '@/hooks/useSandboxResource';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F247 AC-D2/AC-D3 — what this sandbox is currently set to, at the top of the dev pane.
 *
 * The left column is where a sandbox is shaped, and the only way to change it is to say so
 * in chat (AC-D4). Until now the operator was talking to something they could not see: the
 * goal, members, schedule and backflow switch existed only on disk. This bar is the
 * referent that conversation is about — you say "改到 9 点" and watch it change here.
 *
 * It also carries pause/resume. The run pane refuses to run a paused sandbox, which
 * without a control anywhere is a dead end: paused, with no way back.
 *
 * Polling rather than pushing: a spec edit lands through an MCP callback on the server, so
 * there is no client-side event to react to. The server stays the single truth; this is
 * one view of it that re-reads, and the run pane is another.
 *
 * The thread comes in as a prop rather than from the global `currentThreadId`. Review
 * found the global read made a switch mid-flight able to render sandbox A's title and goal
 * while every button acted on B — reading the id the parent is rendering removes the
 * disagreement at the source, and useSandboxResource guards what is left.
 */
const REFRESH_MS = 30_000;

interface SandboxResponse {
  sandbox: Sandbox;
}

function statusLabel(status: Sandbox['status']): string {
  if (status === 'active') return '运行中';
  if (status === 'paused') return '已暂停';
  return '已归档';
}

const buildSandboxPath = (id: string) => `/api/sandboxes/${encodeURIComponent(id)}`;

export function SandboxSpecBar({ threadId }: { threadId: string | null | undefined }): JSX.Element | null {
  const sandboxId = useChatStore((s) => s.threads.find((t) => t.id === threadId)?.sandboxId);

  const {
    data,
    error: loadError,
    reload,
    apply,
    isCurrent,
  } = useSandboxResource<SandboxResponse>(sandboxId, buildSandboxPath, {
    intervalMs: REFRESH_MS,
    errorMessage: '无法读取沙盒设置',
  });
  const sandbox = data?.sandbox ?? null;

  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const error = mutationError ?? loadError;

  // Both of these belong to one sandbox's mutation, so both are reset when the sandbox
  // changes — the run pane already did this and the bar did not, which is how a guard meant
  // to protect B ended up disabling it: `busy` was set for A's pause, and the `finally`
  // that clears it is correctly skipped once A is no longer current, so nothing ever
  // cleared it. An identity guard without a reset does not make the flag safe, it makes it
  // permanent.
  useEffect(() => {
    setBusy(false);
    setMutationError(null);
  }, [sandboxId]);

  const setStatus = useCallback(
    async (status: 'active' | 'paused') => {
      // Capture the id this click belongs to: awaiting below can outlive the thread the
      // operator was looking at, and a status write must never land on a sandbox they
      // never saw.
      const targetId = sandboxId;
      if (!targetId || busy) return;
      setBusy(true);
      try {
        const res = await apiFetch(`${buildSandboxPath(targetId)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        // Past this await the reply belongs to the sandbox the click started on. The
        // resource guard keeps A's DATA from rendering as B's, but it cannot see the state
        // this callback owns: an error message, the busy flag, or the act of clearing an
        // error B legitimately has.
        if (!isCurrent(targetId)) return;
        if (!res.ok) {
          setMutationError(`暂停/恢复失败（HTTP ${res.status}）`);
          return;
        }
        const body = (await res.json()) as { sandbox?: Sandbox };
        if (!isCurrent(targetId)) return;
        // Trust the server's answer over the status we asked for: a rejected or coerced
        // transition must not leave the bar claiming something the sandbox is not.
        if (body.sandbox) {
          apply({ sandbox: body.sandbox });
        } else {
          // reload() is another await, and the operator can leave during it. Clearing the
          // error afterwards without re-checking wipes one B produced in the meantime.
          await reload();
          if (!isCurrent(targetId)) return;
        }
        setMutationError(null);
      } catch {
        if (isCurrent(targetId)) setMutationError('暂停/恢复失败');
      } finally {
        if (isCurrent(targetId)) setBusy(false);
      }
    },
    [sandboxId, busy, reload, apply, isCurrent],
  );

  if (!sandboxId) return null;

  if (!sandbox) {
    // A 200 whose body carries no sandbox is unreadable, not pending — "正在读取沙盒设置…"
    // would leave the operator waiting for a shape the response will never take. Same lie
    // the run pane had to stop telling.
    const unreadableBody = data !== null;
    const message = error ?? (unreadableBody ? '沙盒设置响应格式不对，读不出这个沙盒。' : '正在读取沙盒设置…');
    return (
      <div
        className="px-4 py-2 text-xs text-[var(--console-text-muted)] border-b border-cafe-subtle"
        data-testid={error || unreadableBody ? 'spec-bar-error' : 'spec-bar-loading'}
      >
        {message}
      </div>
    );
  }

  const spec = sandbox.spec;
  const schedule = spec.schedule;

  return (
    <div className="px-4 py-2 border-b border-cafe-subtle text-xs space-y-1" data-testid="sandbox-spec-bar">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-cafe-black">{sandbox.title}</span>
        <span className="text-cafe-muted" data-testid="spec-bar-status">
          {statusLabel(sandbox.status)}
        </span>
        {sandbox.status === 'active' ? (
          <button
            type="button"
            onClick={() => void setStatus('paused')}
            disabled={busy}
            data-testid="spec-bar-pause"
            className="px-2 py-0.5 rounded border border-cafe text-cafe-secondary disabled:opacity-50"
          >
            暂停
          </button>
        ) : sandbox.status === 'paused' ? (
          <button
            type="button"
            onClick={() => void setStatus('active')}
            disabled={busy}
            data-testid="spec-bar-resume"
            className="px-2 py-0.5 rounded border border-cafe text-cafe-secondary disabled:opacity-50"
          >
            恢复
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto text-cafe-secondary"
          data-testid="spec-bar-toggle"
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      <div className="text-cafe-secondary" data-testid="spec-bar-goal">
        目标：{spec.goal}
      </div>

      <div className="flex items-center gap-3 flex-wrap text-cafe-muted">
        <span data-testid="spec-bar-schedule">
          {schedule?.cron
            ? `定时：${schedule.cron}${schedule.timezone ? `（${schedule.timezone}）` : ''}`
            : '未设置定时，仅手动运行'}
        </span>
        <span data-testid="spec-bar-backflow">回流：{sandbox.settings.allowBackflow ? '开启' : '关闭'}</span>
        <span data-testid="spec-bar-members">成员：{spec.members.join('、')}</span>
      </div>

      {expanded && (
        <div className="space-y-1 text-cafe-muted pt-1">
          {spec.learningGoal && <div data-testid="spec-bar-learning-goal">学习目标：{spec.learningGoal}</div>}
          {schedule?.prompt && <div data-testid="spec-bar-schedule-prompt">到点执行：{schedule.prompt}</div>}
          <div className="text-micro">改这些直接在下面说，例如「把它改到每天 9 点」。</div>
        </div>
      )}

      {error && (
        <div className="text-conn-red-text" data-testid="spec-bar-stale">
          {error}
        </div>
      )}
    </div>
  );
}
