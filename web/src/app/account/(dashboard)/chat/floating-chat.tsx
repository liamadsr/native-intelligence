'use client'

import { createContext, useContext, useCallback, useMemo, useRef } from 'react'

interface FloatingChatContextValue {
  isExpanded: boolean
  forceExpanded: boolean
  collapse: () => void
  containerRef: React.RefObject<HTMLDivElement | null>
}

const FloatingChatContext = createContext<FloatingChatContextValue>({
  isExpanded: false,
  forceExpanded: false,
  collapse: () => {},
  containerRef: { current: null },
})

export function useFloatingChatExpanded() {
  return useContext(FloatingChatContext).isExpanded
}

export function useFloatingChatCollapse() {
  return useContext(FloatingChatContext).collapse
}

export function useFloatingChatForceExpanded() {
  return useContext(FloatingChatContext).forceExpanded
}

export function useFloatingChatContainerRef() {
  return useContext(FloatingChatContext).containerRef
}

interface FloatingChatProps {
  children: React.ReactNode
  /** When true, force the chat panel to expand (e.g. during recording). In the
   *  persistent strip the messages are always shown, so this only drives the
   *  `forceExpanded` flag consumers read off the context. */
  forceExpanded?: boolean
}

// ─── Chat strip — the chat fills the shell's dark right strip ───────────────
//
// The chat is painted (via a portal from EACH tab — every tab's chat stays
// mounted in the slot, only the active one is visible) into the dark
// `bg-sidebar` dock the shell renders (`#dial8-chat-strip-slot`). It fills that
// dock; the messages are always shown (the panel is given `alwaysShowMessages`),
// so there's no in-strip collapse rail. The FloatingChatContext API is preserved
// so ChatPanel / picker-popover need no changes:
//   isExpanded = true (messages always visible in the persistent strip)
//   collapse() = no-op (the chevron is hidden via alwaysShowMessages)
//   containerRef = the strip's inner panel (picker anchors off this)
export function FloatingChat({ children, forceExpanded = false }: FloatingChatProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const collapse = useCallback(() => {}, [])

  // `containerRef` and `collapse` are stable identities, so `forceExpanded` is
  // the only thing that can change the value. Without the memo the object
  // literal is new on every parent render and every context consumer — the
  // whole chat subtree — re-renders with it.
  const value = useMemo(
    () => ({ isExpanded: true, forceExpanded, collapse, containerRef }),
    [forceExpanded, collapse],
  )

  return (
    <FloatingChatContext.Provider value={value}>
      {/* The chat panel fills the shell strip. It's TRANSPARENT so the shell-level
          photo background (dashboard-shell.tsx) — which spans the whole shell incl.
          the header — shows through continuously behind the chat. */}
      <div ref={containerRef} className="relative flex h-full w-full min-h-0 flex-col">
        {children}
      </div>
    </FloatingChatContext.Provider>
  )
}
