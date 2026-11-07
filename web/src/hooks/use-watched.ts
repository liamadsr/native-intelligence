'use client'

import { useEffect, useState } from 'react'
import {
  isInteractionIdle,
  PIXEL_IDLE_MS,
  shouldRunPixelCanvas,
} from '@/app/account/(dashboard)/backdrop/pixel-canvas-gate'

/**
 * Is anyone watching? The dotted canvas's run gate (pixel-canvas-gate.ts):
 * `active` (what the caller knows of its own surface being on screen), the
 * page visible, the window
 * focused, and pointer or keyboard input within PIXEL_IDLE_MS. Bots that move
 * only while this is true cost nothing while the app sits open all day.
 *
 * The Agents page's roster bots read it here.
 *
 * `idle: false` drops the input rule (page visible and window focused only):
 * the voice bird, whose person talks hands-free, never touching the mouse or
 * keys, for as long as it is there. No input listeners and no idle timer then.
 *
 * DOM focus/blur only. The dotted canvas also takes the desktop shell's native
 * focus events, which catch a cmd-tab the DOM can miss; here the idle gate
 * bounds a missed one to a minute.
 */
export function useWatched(active = true, { idle: idleRule = true }: { idle?: boolean } = {}): boolean {
  // Stay still until the first DOM snapshot. Starting optimistically watched
  // would mount live canvases in a hidden/unfocused window before the effect.
  const [signals, setSignals] = useState({ hidden: false, focused: false, idle: false })
  useEffect(() => {
    let focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
    let idle = false
    let lastInput = performance.now()
    let idleTimer: ReturnType<typeof setTimeout> | undefined

    const sync = () => setSignals({ hidden: document.hidden, focused, idle })

    // One timer, re-armed for what is left of the idle window when it fires;
    // input only records its time, which is all pointermove rates can afford.
    const checkIdle = () => {
      const now = performance.now()
      if (isInteractionIdle(now, lastInput)) {
        idleTimer = undefined
        idle = true
        sync()
      } else {
        idleTimer = setTimeout(checkIdle, lastInput + PIXEL_IDLE_MS - now)
      }
    }
    const onInput = () => {
      lastInput = performance.now()
      if (!idle) return
      idle = false
      idleTimer = setTimeout(checkIdle, PIXEL_IDLE_MS)
      sync()
    }
    // Coming back to the window counts as input: the bots wake at once.
    const onFocus = () => {
      focused = true
      if (idleRule) onInput()
      sync()
    }
    const onBlur = () => {
      focused = false
      sync()
    }

    const inputEvents = idleRule ? (['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) : []
    if (idleRule) idleTimer = setTimeout(checkIdle, PIXEL_IDLE_MS)
    sync()
    for (const type of inputEvents) window.addEventListener(type, onInput, { passive: true })
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', sync)
    return () => {
      clearTimeout(idleTimer)
      for (const type of inputEvents) window.removeEventListener(type, onInput)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [idleRule])
  return active && shouldRunPixelCanvas({
    documentHidden: signals.hidden,
    windowFocused: signals.focused,
    interactionIdle: signals.idle,
  })
}
