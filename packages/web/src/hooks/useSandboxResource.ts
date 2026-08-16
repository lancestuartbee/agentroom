'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

/**
 * F247 — polling a sandbox endpoint without ever showing one sandbox's data under
 * another's identity.
 *
 * Both sandbox panels derive their id from the globally-current thread and then fetch. A
 * thread switch mid-flight makes that a real hazard, not a staleness nuisance: A's slow
 * response can resolve after B's and land in state while the operator is looking at B. The
 * panel then shows A's title and goal, and every button on it acts on B — review caught it
 * as "wrong object plus wrong mutation target".
 *
 * Two guards, deliberately redundant, because the failure is silent and its blast radius
 * is a write:
 *
 *  - a generation counter drops superseded in-flight responses;
 *  - data is stored WITH the id it was fetched for, and handed back only when that id is
 *    still the current one. Even a mis-sequenced response cannot be rendered as B's.
 *
 * On a switch, data goes to null rather than lingering: showing nothing for one tick is
 * honest, showing the previous sandbox is not.
 */
export interface SandboxResource<T> {
  data: T | null;
  error: string | null;
  /** True when the last poll failed but an earlier good snapshot is still on screen. */
  isStale: boolean;
  reload: () => Promise<void>;
  /** Apply a fresh payload obtained outside the poll (e.g. the reply to a mutation). */
  apply: (data: T) => void;
}

export function useSandboxResource<T>(
  sandboxId: string | undefined,
  buildPath: (id: string) => string,
  options: { intervalMs?: number; errorMessage: string },
): SandboxResource<T> {
  const { intervalMs, errorMessage } = options;
  const [held, setHeld] = useState<{ sandboxId: string; data: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    if (!sandboxId) return;
    const generation = ++generationRef.current;
    const stillCurrent = () => generationRef.current === generation;
    try {
      const res = await apiFetch(buildPath(sandboxId));
      if (!stillCurrent()) return;
      if (!res.ok) {
        setError(`${errorMessage}（HTTP ${res.status}）`);
        return;
      }
      const body = (await res.json()) as T;
      if (!stillCurrent()) return;
      setHeld({ sandboxId, data: body });
      setError(null);
    } catch {
      if (stillCurrent()) setError(errorMessage);
    }
  }, [sandboxId, buildPath, errorMessage]);

  useEffect(() => {
    // Invalidate anything in flight and drop the previous sandbox's data in the same tick
    // the id changes, so no render can pair them.
    generationRef.current++;
    setHeld(null);
    setError(null);
    if (!sandboxId) return;
    void load();
    if (!intervalMs) return;
    const timer = setInterval(() => void load(), intervalMs);
    return () => clearInterval(timer);
  }, [sandboxId, intervalMs, load]);

  const apply = useCallback(
    (data: T) => {
      if (!sandboxId) return;
      generationRef.current++;
      setHeld({ sandboxId, data });
      setError(null);
    },
    [sandboxId],
  );

  const data = held && held.sandboxId === sandboxId ? held.data : null;
  return { data, error, isStale: data !== null && error !== null, reload: load, apply };
}
