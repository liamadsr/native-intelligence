'use client'

/**
 * Read anywhere's shortcut: its keys as chips, a pencil to record a new one
 * and a bin to go back to the default. Recording happens on the desktop,
 * which watches the keyboard (so fn works, which a web page never sees) and
 * checks the combo (desktop/src-tauri/src/read_selection/keys.rs); a
 * refusal is one short line.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { tauriBridge, type ReadSelectionHotkeyRefusal, type ReadSelectionStatus } from '@/lib/tauri-bridge'

/** One short line for a refused recording; null when there's nothing to say. */
function refusalMessage(rejection: unknown): string | null {
  const raw = String(rejection).replace(/^Error:\s*/, '')
  switch (raw.split(':')[0] as ReadSelectionHotkeyRefusal) {
    case 'cancelled':
    case 'timeout':
      return null
    case 'no_tap':
      return 'Allow access first.'
    case 'unknown_key':
      return 'That key can’t be used.'
    case 'needs_modifier':
      return 'Add ⌃, ⌘ or fn.'
    case 'option_only':
      return 'macOS doesn’t allow ⌥ alone. Add ⌃, ⌘ or fn.'
    case 'taken':
      return 'Already used by another app.'
    default:
      return 'Couldn’t set that shortcut.'
  }
}

/** "fn ⌃⌥R" → ["Fn", "⌃", "⌥", "R"]. */
function keyChips(label: string): string[] {
  const fn = label.startsWith('fn')
  const rest = (fn ? label.slice(2) : label).trim()
  const chips: string[] = fn ? ['Fn'] : []
  let i = 0
  while (i < rest.length && '⌃⌥⇧⌘'.includes(rest[i])) chips.push(rest[i++])
  if (rest.slice(i)) chips.push(rest.slice(i))
  return chips
}

export function ShortcutField({
  status,
  busy,
  onStatus,
  run,
}: {
  status: ReadSelectionStatus
  busy: boolean
  onStatus: (status: ReadSelectionStatus) => void
  run: (change: () => Promise<ReadSelectionStatus>) => Promise<void>
}) {
  const [recording, setRecording] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const recordingRef = useRef(false)

  const record = useCallback(() => {
    setRefusal(null)
    setRecording(true)
    recordingRef.current = true
    tauriBridge
      .readSelectionRecordHotkey()
      .then(onStatus)
      .catch((err) => setRefusal(refusalMessage(err)))
      .finally(() => {
        recordingRef.current = false
        setRecording(false)
      })
  }, [onStatus])

  // Leaving the page mid-recording stops it (the desktop puts the old one back).
  useEffect(
    () => () => {
      if (recordingRef.current) void tauriBridge.readSelectionCancelRecord().catch(() => {})
    },
    [],
  )

  const defaultId = status.hotkeys[0]?.id
  const isDefault = status.hotkey === defaultId

  return (
    <div className="space-y-1">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <Label className="text-sm font-medium">Shortcut</Label>
        {recording ? (
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-48 items-center rounded-lg border border-blue-500 bg-muted/60 px-3 text-sm ring-1 ring-blue-500/40">
              Press shortcut
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="h-9 rounded-lg text-muted-foreground"
              onClick={() => void tauriBridge.readSelectionCancelRecord()}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <div className="mr-2 flex items-center gap-1">
              {keyChips(status.hotkeyLabel).map((key, i) => (
                <kbd
                  key={i}
                  className="flex h-8 min-w-8 items-center justify-center rounded-full bg-muted px-3 font-sans text-sm text-foreground/80"
                >
                  {key}
                </kbd>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              aria-label="Change shortcut"
              disabled={busy}
              onClick={record}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            {!isDefault && defaultId && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                aria-label="Reset shortcut"
                disabled={busy}
                onClick={() => {
                  setRefusal(null)
                  void run(() => tauriBridge.readSelectionSetHotkey(defaultId))
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>
      {(refusal || status.hotkeyError) && (
        <p className="text-right text-[11px] text-red-700 dark:text-red-400">{refusal ?? status.hotkeyError}</p>
      )}
    </div>
  )
}
