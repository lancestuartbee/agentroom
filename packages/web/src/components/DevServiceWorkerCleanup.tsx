'use client';

import { useEffect } from 'react';

const CLEANUP_SESSION_KEY = 'clowder:dev-sw-cleaned';

function isLocalDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function DevServiceWorkerCleanup() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    if (process.env.NEXT_PUBLIC_ENABLE_PWA_IN_DEV === '1') return;
    if (!isLocalDevHost(window.location.hostname)) return;

    let cancelled = false;

    const cleanup = async () => {
      const registrations =
        'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistrations() : [];
      const cacheKeys = 'caches' in window ? await window.caches.keys() : [];

      await Promise.all([
        ...registrations.map((registration) => registration.unregister()),
        ...cacheKeys.map((key) => window.caches.delete(key)),
      ]);

      const cleanedAnything = registrations.length > 0 || cacheKeys.length > 0;
      if (cancelled || !cleanedAnything || window.sessionStorage.getItem(CLEANUP_SESSION_KEY)) return;

      window.sessionStorage.setItem(CLEANUP_SESSION_KEY, '1');
      window.location.reload();
    };

    void cleanup().catch(() => {
      // Best-effort dev cleanup. A failed browser API call should not block app boot.
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
