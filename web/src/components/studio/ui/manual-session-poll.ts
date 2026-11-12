import type { ManualSession } from '@/lib/studio/engine/api';

export const manualSessionActive = (session: ManualSession | null | undefined) =>
  !!session && ['preparing', 'countdown', 'recording', 'finalizing'].includes(session.status);

const progress = (status: ManualSession['status']) => ({ preparing: 0, countdown: 1, recording: 2, finalizing: 3, completed: 4, failed: 4, cancelled: 4, interrupted: 4 })[status];
export function newerManualSession(previous: ManualSession | undefined, incoming: ManualSession): ManualSession {
  if (!previous || previous.id !== incoming.id) return incoming;
  if (progress(previous.status) > progress(incoming.status)) return previous;
  if (progress(previous.status) === progress(incoming.status) && previous.elapsedMs > incoming.elapsedMs) return previous;
  if (progress(previous.status) === 4 && progress(incoming.status) === 4 && (previous.projectId || previous.partialAssetId) && !incoming.projectId && !incoming.partialAssetId) return previous;
  return incoming;
}

/** A late list response may predate a newly accepted active session. Keep polling that session. */
export function reconcileManualSessionList(previous: ManualSession[], incoming: ManualSession[]): ManualSession[] {
  const ids = new Set(incoming.map(session => session.id));
  return [
    ...previous.filter(session => manualSessionActive(session) && !ids.has(session.id)),
    ...incoming.map(session => newerManualSession(previous.find(item => item.id === session.id), session)),
  ];
}

const delay = (status: ManualSession['status']) => status === 'countdown' ? 300 : status === 'recording' ? 750 : 1200;

/** Serialized polling continues even when the server reports the same state or a transient error. */
export function watchManualSession(
  id: string,
  read: (id: string) => Promise<ManualSession>,
  accept: (session: ManualSession) => void,
  error: (cause: unknown) => void,
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  unschedule: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
) {
  let alive = true, timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const session = await read(id);
      if (!alive) return;
      accept(session);
      if (manualSessionActive(session)) timer = schedule(() => { void poll(); }, delay(session.status));
    } catch (cause) {
      if (!alive) return;
      error(cause);
      timer = schedule(() => { void poll(); }, 2500);
    }
  };
  timer = schedule(() => { void poll(); }, 100);
  return () => { alive = false; unschedule(timer); };
}
