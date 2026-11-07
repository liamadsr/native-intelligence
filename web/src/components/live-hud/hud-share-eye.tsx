'use client'

/**
 * The HUD header's eye (live sidekick plan, Phase 2; Liam, 10-17), in the
 * desktop HUD window only, where the live agent's face used to be: whether
 * the window shows in screen shares and recordings. Closed (the default, the
 * desktop's own) keeps the user's nudges off the call; open is for demos.
 *
 * It reads the real state on mount and shows nothing until it has it. A
 * desktop build without the commands (tauri-bridge `agentHudCapture`), or a
 * page outside the desktop app, gets no eye at all: never a dead button. A
 * click sets the other state and shows what the desktop answers; a refused
 * set (the window going away) leaves the eye as it was. It acts on the mouse
 * press, as the header's other controls do (./use-press-action.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { tauriBridge } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import { BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import { usePressAction } from './use-press-action'

export const SHARE_EYE_HIDDEN_LABEL = 'Hidden from screen share'
export const SHARE_EYE_VISIBLE_LABEL = 'Visible on screen share'

export function HudShareEye() {
  // null: not known yet, or no such command (no eye either way).
  const [visible, setVisible] = useState<boolean | null>(null)
  const busy = useRef(false)
  useEffect(() => {
    let live = true
    void tauriBridge.agentHudCapture.get().then((v) => {
      if (live) setVisible(v)
    })
    return () => {
      live = false
    }
  }, [])
  const toggle = useCallback(() => {
    if (busy.current || visible == null) return
    busy.current = true
    tauriBridge.agentHudCapture
      .set(!visible)
      .then(setVisible, () => {})
      .finally(() => {
        busy.current = false
      })
  }, [visible])
  const press = usePressAction(toggle)

  if (visible == null) return null
  const label = visible ? SHARE_EYE_VISIBLE_LABEL : SHARE_EYE_HIDDEN_LABEL
  const Icon = visible ? Eye : EyeOff
  return (
    <button
      type="button"
      {...press}
      aria-label={label}
      aria-pressed={visible}
      title={label}
      data-hud-share-eye={visible ? 'visible' : 'hidden'}
      className={cn(
        // Opaque: the meeting's time fills the header behind it (hud-schedule-bar.tsx), never through it.
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 transition-colors hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:bg-zinc-700 dark:hover:bg-zinc-600',
        visible ? 'text-foreground' : BOT_GLASS_MUTED,
      )}
    >
      <Icon aria-hidden className="h-4 w-4" />
    </button>
  )
}
