/**
 * The active tab's chat input: every awake tab keeps its chat mounted, and the
 * hidden ones are inert. Only the main chat's: a teammate's or a run's floating
 * chat has the same composer (`data-chat-input-floating`), but it's not the
 * main chat box (UI automation types into this one: automation-bridge.tsx).
 */
export function activeComposer(): Element | null {
  for (const el of document.querySelectorAll('[data-chat-input-root]')) {
    if (!el.closest('[inert]') && !el.hasAttribute('data-chat-input-floating')) return el
  }
  return null
}
