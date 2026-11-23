'use client'

/**
 * The document's offline line (docs/plans/doc-editor-extras.md, phase 5):
 * "Offline: saved on this device" while the text waits on this device, and
 * "Back online: saving…" while it goes up. Nothing once it has landed.
 */
import { CloudOff, Loader2 } from 'lucide-react'

export type OfflineState = 'kept' | 'syncing' | null

export function OfflineNote({ state }: { state: OfflineState }) {
  if (!state) return null
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="offline-note">
      {state === 'kept' ? <CloudOff className="h-3 w-3 shrink-0" /> : <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
      {state === 'kept' ? 'Offline: saved on this device' : 'Back online: saving…'}
    </p>
  )
}
