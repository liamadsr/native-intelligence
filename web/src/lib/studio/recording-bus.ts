// What the app's shell needs to know about a Studio take, without loading the Studio: whether one is recording or
// being saved (the workspace switcher and Sign out ask first), how to stop it and wait for it to be saved, and the
// notices a take sends when no Studio is on screen to show them ("Recording saved · Open in Studio"). The take
// itself lives in components/studio/record/controller.ts, which registers here when it starts; nothing here imports it.

export type RecordingNotice = {
  id: string
  text: string
  tone: 'ok' | 'error'
  /** "Open in Studio": the video the take became. */
  videoId?: string | null
}

export type RecordingGuard = {
  /** A take is recording, or its files are still going to the Studio. */
  busy(): boolean
  /** Stop the take (if one records) and wait until it is saved, at most `timeoutMs`. */
  stopAndSettle(timeoutMs: number): Promise<void>
  /** Forget everything of the take and the recorder (the person signed out). */
  reset(): void
}

let guard: RecordingGuard | null = null
const listeners = new Set<(notice: RecordingNotice) => void>()
let queued: RecordingNotice[] = []

export function registerRecordingGuard(next: RecordingGuard | null): void { guard = next }

/** Whether a Studio take is recording or still being saved in this window. */
export function recordingBusy(): boolean { return !!guard?.busy() }

/** Stop this window's take and wait for it to be saved (at most `timeoutMs`); then forget it if `reset`. */
export async function stopRecording(timeoutMs: number, { reset = false }: { reset?: boolean } = {}): Promise<void> {
  const g = guard
  if (!g) return
  try { await g.stopAndSettle(timeoutMs) } finally { if (reset) g.reset() }
}

/** Forget this window's take and recorder at once (the account changed under it). */
export function resetRecording(): void { guard?.reset(); queued = [] }

/** A notice for the shell to show. Kept until a listener is there (the shell mounts after the Studio's code loads). */
export function postRecordingNotice(notice: RecordingNotice): void {
  if (!listeners.size) { queued = [...queued, notice].slice(-5); return }
  for (const cb of listeners) cb(notice)
}

export function onRecordingNotice(cb: (notice: RecordingNotice) => void): () => void {
  listeners.add(cb)
  const waiting = queued
  queued = []
  for (const notice of waiting) cb(notice)
  return () => { listeners.delete(cb) }
}
