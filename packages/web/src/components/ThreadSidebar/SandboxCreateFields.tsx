'use client';

import { CatSelector } from './CatSelector';
import type { SandboxDraft } from './thread-create';

/**
 * F247 AC-D1 — the fields a sandbox needs before it can exist.
 *
 * A sandbox is not a thread with a label on it: without a goal it has nothing to judge
 * against, without members nobody is ever woken to run it, and without a project directory
 * it has nowhere to keep what it learns. Those three are required here so the operator
 * finds out in the form rather than from a 400 after the modal closed.
 *
 * The schedule is optional on purpose — a new sandbox is usually run by hand a few times
 * before it earns a cron.
 */
export function SandboxCreateFields({
  draft,
  onChange,
  selectedCats,
  onCatsChange,
  error,
}: {
  draft: SandboxDraft;
  onChange: (patch: Partial<SandboxDraft>) => void;
  selectedCats: string[];
  onCatsChange: (ids: string[]) => void;
  error: string | null;
}) {
  const fieldClass =
    'w-full text-sm px-3 py-2 rounded-lg border border-cafe bg-cafe-surface focus:outline-none focus:ring-1 focus:ring-cafe-accent';

  return (
    <div className="px-5 py-3 border-t border-cafe-subtle space-y-3">
      <div>
        <div className="text-micro text-cafe-muted font-medium mb-1">沙盒目标（必填）</div>
        <textarea
          value={draft.goal}
          onChange={(e) => onChange({ goal: e.target.value })}
          placeholder="沙盒目标：它每次运行要判断什么？例如「盯住持仓的异动并给出处置建议」"
          rows={2}
          maxLength={2000}
          className={`${fieldClass} resize-none`}
        />
      </div>

      <input
        type="text"
        value={draft.learningGoal ?? ''}
        onChange={(e) => onChange({ learningGoal: e.target.value })}
        placeholder="学习目标（可选）：希望它长期积累出什么判断"
        maxLength={2000}
        className={fieldClass}
      />

      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={draft.cron ?? ''}
          onChange={(e) => onChange({ cron: e.target.value })}
          placeholder="cron（可选）：0 9 * * *"
          maxLength={100}
          className={`${fieldClass} font-mono text-xs`}
        />
        <input
          type="text"
          value={draft.timezone ?? ''}
          onChange={(e) => onChange({ timezone: e.target.value })}
          placeholder="时区（可选）：Asia/Shanghai"
          maxLength={100}
          className={`${fieldClass} text-xs`}
        />
      </div>

      <input
        type="text"
        value={draft.schedulePrompt ?? ''}
        onChange={(e) => onChange({ schedulePrompt: e.target.value })}
        placeholder="到点了做什么（填了 cron 就必填）"
        maxLength={2000}
        className={fieldClass}
      />

      <label className="flex items-center gap-1.5 text-xs text-cafe-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={draft.allowBackflow ?? false}
          onChange={(e) => onChange({ allowBackflow: e.target.checked })}
          className="rounded border-cafe text-cafe-accent focus:ring-cafe-accent"
        />
        <span>允许把学到的东西回流到系统知识（默认关闭）</span>
      </label>

      <CatSelector selectedCats={selectedCats} onSelectionChange={onCatsChange} title="沙盒成员（必填）" />

      {error && <p className="text-micro text-conn-red-text">{error}</p>}
    </div>
  );
}
