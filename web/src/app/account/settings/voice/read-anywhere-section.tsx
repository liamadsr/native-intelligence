'use client'

/**
 * Settings → Voice → Read anywhere: select text in any app on the Mac (a
 * terminal, a browser, a PDF) and press a shortcut to hear it in the
 * read-aloud voice (dial8-desktop src-tauri/src/read_selection.rs). Its own
 * page until 2026-10-22, when Liam folded it in here with no voice picker of
 * its own: it reads in the voice Read aloud picks (@/lib/read-aloud/read-anywhere-voice).
 *
 * Off until the user turns it on here, and it can't be turned on until the
 * permission is granted: this is the only place Native Intelligence asks for Accessibility
 * (called Device Control and Data Access from macOS 27), and no other feature
 * needs it. "Allow access" shows macOS's prompt (once ever), else opens the
 * pane; the section notices the grant on its own. The same switch lets Native Intelligence
 * send the ⌘C that reads terminals; when that half is missing, "Finish setup"
 * repairs it, with a relaunch as the last step. The settings live on the
 * desktop, not in this page's storage: the shortcut works with no Native Intelligence page
 * open.
 *
 * Renders nothing in a browser, on a desktop build without the commands, or
 * until the on-device voice is ready (Read aloud above shows its download),
 * unless Read anywhere is already on: it always stays reachable to turn off.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useLocalModule } from '@/hooks/use-local-module'
import { LOCAL_TTS_MODULE_ID, isLocalModuleUsable } from '@/lib/local-modules'
import { syncReadAnywhereVoice } from '@/lib/read-aloud/read-anywhere-voice'
import { tauriBridge, type ReadSelectionStatus } from '@/lib/tauri-bridge'
import { ShortcutField } from './shortcut-field'
import { APP_IN_SYSTEM_SETTINGS } from '@/lib/desktop-app-name'

/** How often the section re-checks the grant while it waits for the user to
 *  turn Native Intelligence on in System Settings. */
const PERMISSION_POLL_MS = 1500

export function ReadAnywhereSection() {
  const [status, setStatus] = useState<ReadSelectionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** "Allow access" was pressed: the section now waits for the grant. */
  const [asked, setAsked] = useState(false)
  const tts = useLocalModule(LOCAL_TTS_MODULE_ID)
  const voiceReady = isLocalModuleUsable(tts.info)

  const refresh = useCallback(async () => {
    setStatus(await tauriBridge.readSelectionStatus())
  }, [])

  useEffect(() => {
    // Read anywhere reads in the read-aloud voice: bring it in step first.
    void syncReadAnywhereVoice().then(refresh)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  // Waiting on the grant: notice it as soon as the user flips Native Intelligence on.
  const granted = !!status?.accessibility && status.keystrokes
  const waiting = !!status?.supported && !granted && (asked || status.enabled)
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => void refresh(), PERMISSION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [waiting, refresh])

  const run = useCallback(async (change: () => Promise<ReadSelectionStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await change())
    } catch (e) {
      setError(
        String(e).includes('needs_permission') ? 'Allow access first.' : 'Couldn’t save that. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }, [])

  const requestAccess = useCallback(() => {
    setAsked(true)
    void run(() => tauriBridge.readSelectionRequestAccess())
  }, [run])

  // Hidden until the voice is ready, unless it is already on: then it must
  // stay reachable to turn off, whatever the voice is doing.
  if (!status?.supported || (!voiceReady && !status.enabled)) return null

  return (
    <div data-testid="read-anywhere-section">
      <Separator className="my-6" />

      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Read anywhere
      </div>

      <div className="mt-3 space-y-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <PermissionRow
          accessibility={status.accessibility}
          keystrokes={status.keystrokes}
          asked={asked}
          busy={busy}
          onAllow={requestAccess}
        />

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label className="text-sm font-medium">Read selected text aloud</Label>
            <p className="text-xs text-muted-foreground">
              Select text in any app and press the shortcut to hear it, in the voice above.
            </p>
          </div>
          <Switch
            aria-label="Read selected text aloud"
            checked={status.enabled}
            disabled={busy || (!status.enabled && (!voiceReady || !status.accessibility))}
            onCheckedChange={(on) => void run(() => tauriBridge.readSelectionSetEnabled(on))}
          />
        </div>

        {status.enabled && <ShortcutField status={status} busy={busy} onStatus={setStatus} run={run} />}
        {error && <p className="text-[11px] text-red-700 dark:text-red-400">{error}</p>}
      </div>
    </div>
  )
}

/**
 * The permission, first in the section: the feature's switch stays off until
 * it is granted. Three states: nothing yet (Allow access), Accessibility
 * without the ⌘C half (Finish setup, then Relaunch), granted.
 */
export function PermissionRow({
  accessibility,
  keystrokes,
  asked,
  busy,
  onAllow,
}: {
  accessibility: boolean
  keystrokes: boolean
  asked: boolean
  busy: boolean
  onAllow: () => void
}) {
  // Granted: nothing to show.
  if (accessibility && keystrokes) return null

  const missingAll = !accessibility
  const title = missingAll ? 'Allow Native Intelligence to read your selection' : 'One more step for terminals'
  const body = missingAll
    ? 'Read anywhere needs the Device Control and Data Access permission (called Accessibility before macOS 27). Native Intelligence uses it only to read the text you select when you press the shortcut.'
    : 'Native Intelligence can read most apps now. To read terminals like Warp, it also needs to copy your selection with ⌘C.'
  const hint = missingAll
    ? `In System Settings, turn on ${APP_IN_SYSTEM_SETTINGS}. This page updates on its own.`
    : 'If nothing changes, relaunch Native Intelligence: macOS can apply the change only after a restart.'

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">{body}</p>
            {asked && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Button size="sm" className="h-8" disabled={busy} onClick={onAllow}>
            {missingAll ? (asked ? 'Open System Settings' : 'Allow access') : 'Finish setup'}
          </Button>
          {asked && !missingAll && (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void tauriBridge.readSelectionRelaunch().catch(() => {})}
            >
              Relaunch Native Intelligence
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
