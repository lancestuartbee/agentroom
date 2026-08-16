import type { ThreadMode } from '@cat-cafe/shared';

/**
 * F247 AC-D1 — how the new-thread modal's choices become a create request.
 *
 * The "A2A 沙盒" option shipped pointing at POST /api/threads, so choosing it produced a
 * thread wearing sandbox mode with nothing behind it: no goal, no members list the
 * scheduler could read, no `<projectPath>/.a2a-sandbox/` directory to think in, and a run
 * pane reading an id that did not exist. A sandbox and its thread are born together or
 * not at all, so "which endpoint does this mode go to" is a decision worth naming — and
 * worth testing without mounting a modal.
 */

/** Sandbox-only fields collected by the create form. */
export interface SandboxDraft {
  goal: string;
  learningGoal?: string;
  cron?: string;
  schedulePrompt?: string;
  timezone?: string;
  allowBackflow?: boolean;
}

export interface ThreadCreateInput {
  projectPath?: string;
  mode?: ThreadMode;
  preferredCats?: string[];
  title?: string;
  pinned?: boolean;
  backlogItemId?: string;
  sandbox?: SandboxDraft;
}

export interface ThreadCreateRequest {
  url: '/api/threads' | '/api/sandboxes';
  body: Record<string, unknown>;
}

export type ThreadCreatePlan = { ok: true; request: ThreadCreateRequest } | { ok: false; error: string };

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

function planSandboxCreate(input: ThreadCreateInput): ThreadCreatePlan {
  const name = trimmed(input.title);
  if (!name) return { ok: false, error: '给沙盒起个名称，运行报告和目录都用它命名' };

  // The sandbox's memory, spec history and run reports all live under
  // <projectPath>/.a2a-sandbox/. "大厅" is not a place a sandbox can exist.
  const projectPath = trimmed(input.projectPath);
  if (!projectPath) return { ok: false, error: '沙盒需要一个项目目录存放它的记忆和运行记录' };

  const goal = trimmed(input.sandbox?.goal);
  if (!goal) return { ok: false, error: '写下沙盒的目标——它是每次运行的判断依据' };

  // One list, written into both places the server compares (KD-5): Sandbox.members drives
  // authorization, spec.members drives which member the scheduler wakes. Building them
  // from a single array makes the mismatch the server rejects unrepresentable here.
  const members = (input.preferredCats ?? []).filter((id) => id.trim().length > 0);
  if (members.length === 0) return { ok: false, error: '至少选一位成员，否则没有猫会执行这个沙盒' };

  const cron = trimmed(input.sandbox?.cron);
  const prompt = trimmed(input.sandbox?.schedulePrompt);
  if (cron && !prompt) return { ok: false, error: '定时运行还缺运行内容——到点了要它做什么？' };
  if (prompt && !cron) return { ok: false, error: '运行内容还缺 cron 时间——它什么时候跑？' };

  const timezone = trimmed(input.sandbox?.timezone);
  const learningGoal = trimmed(input.sandbox?.learningGoal);

  return {
    ok: true,
    request: {
      url: '/api/sandboxes',
      body: {
        title: name,
        projectPath,
        members,
        spec: {
          specVersion: '1',
          name,
          goal,
          ...(learningGoal ? { learningGoal } : {}),
          ...(cron ? { schedule: { cron, prompt, ...(timezone ? { timezone } : {}) } } : {}),
          members,
        },
        ...(input.sandbox?.allowBackflow ? { settings: { allowBackflow: true } } : {}),
      },
    },
  };
}

export function planThreadCreate(input: ThreadCreateInput): ThreadCreatePlan {
  if (input.mode === 'sandbox') return planSandboxCreate(input);

  return {
    ok: true,
    request: {
      url: '/api/threads',
      body: {
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
        ...(input.mode && input.mode !== 'development' ? { mode: input.mode } : {}),
        ...(input.preferredCats?.length ? { preferredCats: input.preferredCats } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.pinned ? { pinned: input.pinned } : {}),
        ...(input.backlogItemId ? { backlogItemId: input.backlogItemId } : {}),
      },
    },
  };
}

/**
 * The two endpoints answer in different shapes — POST /api/sandboxes returns
 * `{ sandbox, thread }` while POST /api/threads returns the thread itself. Navigating to
 * `undefined` would strand the operator on a blank screen right after a create that
 * actually succeeded, so an unrecognisable body is null rather than a broken target.
 */
export function extractCreatedThread<T extends { id: string }>(
  url: ThreadCreateRequest['url'],
  body: unknown,
): T | null {
  const candidate = url === '/api/sandboxes' ? (body as { thread?: unknown } | null)?.thread : (body as unknown);
  if (!candidate || typeof candidate !== 'object') return null;
  const id = (candidate as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? (candidate as T) : null;
}

type Fetcher = (
  path: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export type ThreadCreateResult<T extends { id: string }> = { ok: true; thread: T } | { ok: false; error: string };

/**
 * The whole network side of creating a thread, in one drivable function.
 *
 * It lives here rather than inside the sidebar's click handler because that is exactly
 * where the sandbox bug hid: the handler posted a sandbox to /api/threads and nothing in
 * the test suite could see it. Every outcome the caller has to distinguish — refused
 * draft, server rejection, unreadable body, transport failure — is a return value.
 */
export async function submitThreadCreate<T extends { id: string }>(
  input: ThreadCreateInput,
  fetcher: Fetcher,
): Promise<ThreadCreateResult<T>> {
  const plan = planThreadCreate(input);
  if (!plan.ok) return { ok: false, error: plan.error };

  try {
    const res = await fetcher(plan.request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan.request.body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: detail || `创建失败（${res.status}）` };
    }
    const thread = extractCreatedThread<T>(plan.request.url, await res.json());
    // A 201 we cannot read a thread out of is not a success we can act on: navigating to
    // `undefined` would leave the operator staring at a blank screen after a create that
    // actually happened.
    if (!thread) return { ok: false, error: '创建成功但没有拿到会话信息，请刷新列表' };
    return { ok: true, thread };
  } catch {
    return { ok: false, error: '无法连接到服务器' };
  }
}
