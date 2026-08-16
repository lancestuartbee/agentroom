/**
 * F247 AC-D1 — turning the new-thread modal's choices into the right request.
 *
 * The "A2A 沙盒" option used to POST /api/threads like every other mode, which produced a
 * thread wearing sandbox mode with no Sandbox behind it: no goal, no schedule, no
 * directory, and a run pane with nothing to read. Which endpoint a mode belongs to is a
 * decision, so it lives here as one — not as a literal buried in a click handler.
 */

import { describe, expect, it } from 'vitest';
import { extractCreatedThread, planThreadCreate } from '../thread-create';

const VALID = {
  mode: 'sandbox' as const,
  title: '港股盯盘',
  projectPath: '/tmp/proj',
  preferredCats: ['opus', 'luna'],
  sandbox: { goal: '每天盯住持仓的异动' },
};

function expectError(input: Parameters<typeof planThreadCreate>[0]) {
  const plan = planThreadCreate(input);
  if (plan.ok) throw new Error('expected the plan to be refused');
  return plan.error;
}

describe('planThreadCreate — ordinary modes', () => {
  it('still posts to /api/threads and omits the default mode', () => {
    const plan = planThreadCreate({ mode: 'development', projectPath: '/tmp/proj', title: 'T', backlogItemId: 'F1' });
    expect(plan.ok && plan.request.url).toBe('/api/threads');
    expect(plan.ok && plan.request.body).toEqual({ projectPath: '/tmp/proj', title: 'T', backlogItemId: 'F1' });
  });

  it('carries casual mode and preferred cats through unchanged', () => {
    const plan = planThreadCreate({ mode: 'casual', preferredCats: ['opus'], pinned: true });
    expect(plan.ok && plan.request.body).toEqual({ mode: 'casual', preferredCats: ['opus'], pinned: true });
  });
});

describe('planThreadCreate — sandbox mode', () => {
  it('posts to /api/sandboxes, not /api/threads', () => {
    const plan = planThreadCreate(VALID);
    expect(plan.ok && plan.request.url).toBe('/api/sandboxes');
  });

  // The server refuses a members / spec.members mismatch (KD-5). The client must not be
  // able to produce one at all — both lists come from the same array.
  it('emits one membership list into both places the server compares', () => {
    const plan = planThreadCreate(VALID);
    if (!plan.ok) throw new Error(plan.error);
    const body = plan.request.body as { members: string[]; spec: { members: string[]; name: string; goal: string } };
    expect(body.members).toEqual(['opus', 'luna']);
    expect(body.spec.members).toEqual(body.members);
    expect(body.spec.name).toBe('港股盯盘');
    expect(body.spec.goal).toBe('每天盯住持仓的异动');
    expect((body.spec as { specVersion?: string }).specVersion).toBe('1');
  });

  // A sandbox's memory, spec history and run reports all live in <projectPath>/.a2a-sandbox/.
  // "Lobby" is not a place a sandbox can exist.
  it('refuses a sandbox with no project directory', () => {
    expect(expectError({ ...VALID, projectPath: undefined })).toMatch(/目录|项目/);
  });

  it('refuses a sandbox with no goal', () => {
    expect(expectError({ ...VALID, sandbox: { goal: '   ' } })).toMatch(/目标/);
  });

  it('refuses a sandbox with no members — nobody would ever run it', () => {
    expect(expectError({ ...VALID, preferredCats: [] })).toMatch(/成员/);
  });

  it('refuses a sandbox with no name', () => {
    expect(expectError({ ...VALID, title: '  ' })).toMatch(/名称|名字/);
  });

  it('refuses half a schedule — a cron with no prompt never has anything to run', () => {
    expect(expectError({ ...VALID, sandbox: { goal: 'g', cron: '0 9 * * *' } })).toMatch(/内容|prompt|指令/);
    expect(expectError({ ...VALID, sandbox: { goal: 'g', schedulePrompt: '看盘' } })).toMatch(/cron|时间/);
  });

  it('omits schedule entirely when neither half is given', () => {
    const plan = planThreadCreate(VALID);
    expect(plan.ok && 'schedule' in (plan.request.body as { spec: object }).spec).toBe(false);
  });

  it('carries a complete schedule including timezone', () => {
    const plan = planThreadCreate({
      ...VALID,
      sandbox: { goal: 'g', cron: '0 9 * * *', schedulePrompt: '看盘', timezone: 'Asia/Shanghai' },
    });
    if (!plan.ok) throw new Error(plan.error);
    const spec = (plan.request.body as { spec: { schedule?: unknown } }).spec;
    expect(spec.schedule).toEqual({ cron: '0 9 * * *', prompt: '看盘', timezone: 'Asia/Shanghai' });
  });

  it('passes the backflow switch through as a setting', () => {
    const plan = planThreadCreate({ ...VALID, sandbox: { goal: 'g', allowBackflow: true } });
    expect(plan.ok && (plan.request.body as { settings?: unknown }).settings).toEqual({ allowBackflow: true });
  });

  it('trims free text so a stray newline does not become the goal', () => {
    const plan = planThreadCreate({ ...VALID, title: ' 港股盯盘 ', sandbox: { goal: ' 盯住异动\n' } });
    if (!plan.ok) throw new Error(plan.error);
    const body = plan.request.body as { title: string; spec: { goal: string } };
    expect(body.title).toBe('港股盯盘');
    expect(body.spec.goal).toBe('盯住异动');
  });
});

describe('extractCreatedThread', () => {
  // The two endpoints answer in different shapes; navigating to `undefined` would strand
  // the operator on a blank screen right after a successful create.
  it('reads the thread out of a sandbox response', () => {
    expect(extractCreatedThread('/api/sandboxes', { sandbox: { id: 's1' }, thread: { id: 't1' } })).toEqual({
      id: 't1',
    });
  });

  it('reads the thread response itself for ordinary threads', () => {
    expect(extractCreatedThread('/api/threads', { id: 't2' })).toEqual({ id: 't2' });
  });

  it('returns null rather than a broken navigation target', () => {
    expect(extractCreatedThread('/api/sandboxes', { sandbox: { id: 's1' } })).toBeNull();
    expect(extractCreatedThread('/api/threads', {})).toBeNull();
  });
});
