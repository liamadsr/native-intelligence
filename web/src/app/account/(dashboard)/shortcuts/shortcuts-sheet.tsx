'use client'

/**
 * The keyboard shortcuts sheet: every shortcut the app has (lib/shortcuts.ts),
 * by section, opened with `?` or the workspace menu's "Keyboard shortcuts"
 * (./open-shortcuts-sheet.ts). A field at its top narrows the list as you
 * type, Esc closes it.
 *
 * Go to lists the pages this workspace offers, in its own words (pagesFor:
 * Contacts is "Customers" in a service business), as the rail does.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { isMacPlatform } from '@/lib/hotkeys'
import { GO_TO, SHORTCUTS_BESIDES_GO_TO, goToKeys, keysChips, type ShortcutDef, type ShortcutSection } from '@/lib/shortcuts'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import { useIsDesktop } from '@/components/desktop-titlebar'
import { useIsWorkspaceGuest, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { PAGE_GROUPS } from '../rail/page-groups'
import { OPEN_SHORTCUTS_SHEET_EVENT } from './open-shortcuts-sheet'

const SECTIONS: readonly ShortcutSection[] = ['General', 'Go to', 'Mail', 'Tasks, projects and initiatives']

export const KBD_CHIP =
  'inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border bg-muted/60 px-1 font-sans text-[11px] font-medium text-muted-foreground'

const subscribeNoop = () => () => {}

/** A shortcut's keys as chips: `g m` → [G] then [M]; several keys → "or". */
export function ShortcutKeysChips({ keys, mac }: { keys: readonly string[]; mac: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <span key={k} className="flex items-center gap-1">
          {i > 0 && <span className="text-[11px] text-muted-foreground/70">or</span>}
          {keysChips(k, mac).map((step, j) => (
            <span key={j} className="flex items-center gap-1">
              {j > 0 && <span className="text-[11px] text-muted-foreground/70">then</span>}
              {step.map((chip) => (
                <kbd key={chip} className={KBD_CHIP}>
                  {chip}
                </kbd>
              ))}
            </span>
          ))}
        </span>
      ))}
    </span>
  )
}

export function ShortcutsSheet() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false)
  const mac = mounted ? isMacPlatform() : true
  const edition = useWorkspaceEdition()
  const desktop = useIsDesktop()
  const guest = useIsWorkspaceGuest()

  useEffect(() => {
    const onOpen = () => {
      setQuery('')
      setOpen((was) => !was)
    }
    window.addEventListener(OPEN_SHORTCUTS_SHEET_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SHORTCUTS_SHEET_EVENT, onOpen)
  }, [])

  // Go to: the pages this workspace offers, in its words; the rest as before.
  const rows = useMemo<ShortcutDef[]>(() => {
    const offered = new Map(pagesFor(edition, { desktop, guest }).map((p) => [p.slug, p.label]))
    const goTo = GO_TO.flatMap((g): ShortcutDef[] => {
      let label = g.label
      if (g.target.type === 'page') {
        const named = offered.get(g.target.slug)
        if (!named) return []
        label = named
      } else if (g.target.type === 'group' && !PAGE_GROUPS[g.target.id].members.some((s) => offered.has(s))) {
        return []
      }
      return [{ id: `go-${g.letter}`, keys: [goToKeys(g.letter)], label, section: 'Go to', scope: 'global' }]
    })
    return [...SHORTCUTS_BESIDES_GO_TO.filter((s) => s.section === 'General'), ...goTo, ...SHORTCUTS_BESIDES_GO_TO.filter((s) => s.section !== 'General')]
  }, [edition, desktop, guest])

  const q = query.trim().toLowerCase()
  const shown = q ? rows.filter((r) => r.label.toLowerCase().includes(q) || r.section.toLowerCase().includes(q)) : rows

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-shortcuts-sheet="" className="flex max-h-[min(640px,calc(100vh-4rem))] max-w-lg flex-col gap-3 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press G, then a letter, to go to a page. Shortcuts wait while you type.</DialogDescription>
        </DialogHeader>
        <div className="px-5">
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            data-shortcuts-search=""
            className="h-8 w-full rounded-lg border border-border bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {SECTIONS.map((section) => {
            const inSection = shown.filter((r) => r.section === section)
            if (!inSection.length) return null
            return (
              <section key={section} data-shortcuts-section={section} className="mt-3 first:mt-0">
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">{section}</h3>
                <ul>
                  {inSection.map((r) => (
                    <li key={r.id} data-shortcut={r.id} className="flex items-center justify-between gap-3 border-b border-border/50 py-1.5 text-sm last:border-b-0">
                      <span className="min-w-0 truncate">{r.label}</span>
                      <ShortcutKeysChips keys={r.keys} mac={mac} />
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
          {!shown.length && <p className="py-6 text-center text-sm text-muted-foreground">No shortcut matches.</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
