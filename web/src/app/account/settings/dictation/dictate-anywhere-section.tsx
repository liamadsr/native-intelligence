'use client'

/**
 * Settings → Dictation → Dictate anywhere: tap the right Option key in any app,
 * talk, tap it again, and the words are pasted where the cursor is
 * (dial8-desktop src-tauri/src/dictate.rs; docs/plans/dictate-anywhere.md).
 *
 * One switch and nothing else to set up (Liam, 2026-10-25: less
 * configuration). It needs the Accessibility permission Read anywhere asks
 * for, through the same row and the same "Allow access". Off until turned on.
 *
 * Renders nothing in a browser, on a desktop build without it, or until the
 * on-device transcription is ready, unless it's already on: then it stays
 * reachable to turn off.
 */

import { useCallback, useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useLocalModule } from '@/hooks/use-local-module'
import { LOCAL_STT_MODULE_ID, isLocalModuleUsable } from '@/lib/local-modules'
import { tauriBridge, type DictateStatus } from '@/lib/tauri-bridge'
import { PermissionRow } from '../voice/read-anywhere-section'

const PERMISSION_POLL_MS = 1500

export function DictateAnywhereSection() {
  const [status, setStatus] = useState<DictateStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [asked, setAsked] = useState(false)
  const stt = useLocalModule(LOCAL_STT_MODULE_ID)
  const sttReady = isLocalModuleUsable(stt.info)

  const refresh = useCallback(async () => {
    setStatus(await tauriBridge.dictateStatus())
  }, [])

  useEffect(() => {
    void refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const granted = !!status?.accessibility && !!status?.keystrokes
  const waiting = !!status?.supported && !granted && (asked || !!status?.enabled)
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => void refresh(), PERMISSION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [waiting, refresh])

  const setEnabled = useCallback(async (on: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await tauriBridge.dictateSetEnabled(on))
    } catch (e) {
      setError(String(e).includes('needs_permission') ? 'Allow access first.' : 'Couldn’t save that. Try again.')
    } finally {
      setBusy(false)
    }
  }, [])

  const requestAccess = useCallback(async () => {
    setAsked(true)
    setBusy(true)
    try {
      await tauriBridge.readSelectionRequestAccess()
    } catch {
      // The pane opened instead: the poll notices the grant.
    } finally {
      setBusy(false)
      void refresh()
    }
  }, [refresh])

  if (!status?.supported || (!sttReady && !status.enabled)) return null

  return (
    <div data-testid="dictate-anywhere-section">
      <Separator className="my-6" />

      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Dictate anywhere</div>

      <div className="mt-3 space-y-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <PermissionRow
          accessibility={status.accessibility}
          keystrokes={status.keystrokes}
          asked={asked}
          busy={busy}
          onAllow={() => void requestAccess()}
        />

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label className="text-sm font-medium">Type with your voice</Label>
            <p className="text-xs text-muted-foreground">
              In any app, tap the right ⌥ key, talk, and tap it again. Your words are pasted where the cursor is.
            </p>
          </div>
          <Switch
            aria-label="Type with your voice"
            checked={status.enabled}
            disabled={busy || (!status.enabled && !status.accessibility)}
            onCheckedChange={(on) => void setEnabled(on)}
          />
        </div>

        {status.enabled && status.error === 'no_event_tap' && (
          <p className="text-[11px] text-red-700 dark:text-red-400">
            Native Intelligence can’t watch the right ⌥ key yet. Allow access above, then turn this off and on.
          </p>
        )}
        {error && <p className="text-[11px] text-red-700 dark:text-red-400">{error}</p>}
      </div>
    </div>
  )
}
