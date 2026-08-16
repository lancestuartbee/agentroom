/**
 * F247 AC-D1 — the request the sidebar actually sends.
 *
 * Twice now review has caught me testing a mechanism while the wiring that calls it was
 * broken, because the test hand-built what the caller was supposed to build. So this
 * drives the real submit function with a fake transport: what URL went out, what came
 * back, and what the sidebar is handed to navigate to.
 */

import { describe, expect, it, vi } from 'vitest';
import { submitThreadCreate } from '../thread-create';

function fetcherReturning(response: { ok: boolean; status?: number; body?: unknown; text?: string }) {
  return vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 201 : 500),
    json: async () => response.body,
    text: async () => response.text ?? JSON.stringify(response.body ?? {}),
  })) as unknown as Parameters<typeof submitThreadCreate>[1];
}

const SANDBOX_OPTS = {
  mode: 'sandbox' as const,
  title: '港股盯盘',
  projectPath: '/tmp/proj',
  preferredCats: ['opus'],
  sandbox: { goal: '盯住异动' },
};

describe('submitThreadCreate', () => {
  it('sends a sandbox to /api/sandboxes with both member lists in step', async () => {
    const fetcher = fetcherReturning({ ok: true, body: { sandbox: { id: 's1' }, thread: { id: 't1' } } });
    const result = await submitThreadCreate(SANDBOX_OPTS, fetcher);

    expect(result.ok && result.thread.id).toBe('t1');
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/sandboxes');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.spec.members).toEqual(body.members);
    expect(body.spec.goal).toBe('盯住异动');
  });

  it('sends an ordinary thread to /api/threads and returns the thread itself', async () => {
    const fetcher = fetcherReturning({ ok: true, body: { id: 't2' } });
    const result = await submitThreadCreate({ mode: 'casual', preferredCats: ['opus'] }, fetcher);

    expect(result.ok && result.thread.id).toBe('t2');
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/threads');
  });

  // An incomplete draft must never reach the network — the operator gets the reason.
  it('refuses an incomplete sandbox without calling the server', async () => {
    const fetcher = fetcherReturning({ ok: true, body: {} });
    const result = await submitThreadCreate({ ...SANDBOX_OPTS, sandbox: { goal: '' } }, fetcher);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/目标/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces a server rejection instead of pretending it worked', async () => {
    const fetcher = fetcherReturning({ ok: false, status: 400, text: 'bad members' });
    const result = await submitThreadCreate(SANDBOX_OPTS, fetcher);
    expect(result.ok).toBe(false);
  });

  // A 201 whose body we cannot read is still a failure to navigate — treating it as
  // success would drop the operator on a blank screen after a create that succeeded.
  it('fails loudly when the response carries no usable thread', async () => {
    const fetcher = fetcherReturning({ ok: true, body: { sandbox: { id: 's1' } } });
    const result = await submitThreadCreate(SANDBOX_OPTS, fetcher);
    expect(result.ok).toBe(false);
  });

  it('does not turn a network exception into a silent no-op', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as Parameters<typeof submitThreadCreate>[1];
    const result = await submitThreadCreate(SANDBOX_OPTS, fetcher);
    expect(result.ok).toBe(false);
  });
});
