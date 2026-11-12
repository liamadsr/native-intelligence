'use client'

/**
 * A document's `@` menu: the one `@` picker (CommandMenu, its search and its
 * rows, as the main chat and team chat draw them), opened under the `@…` being
 * typed. The editor's suggestion plugin (record-mention.ts) says what's typed
 * and where; picking a row puts the record's chip there.
 *
 * Mounted once per editor, beside it. Draws nothing while no `@` is open (a
 * zero-size anchor at most): no timers, no animation left running.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CommandMenu, type CommandMenuHandle } from '@/app/account/(dashboard)/chat/command-menu'
import type { SkillCommand } from '@/app/account/(dashboard)/chat/chat-panel'
import { MENTION_PICKER_KINDS, menuRowMention, type MenuSearchRow } from '@/lib/search/menu-search'
import type { MentionSuggestionStore } from './record-mention'

const NO_SKILLS: readonly SkillCommand[] = []
const noop = () => {}
const noState = () => null

/** The menu's width beside a document (its rows: a name, a line under it). */
const MENU_WIDTH = 380

export function RecordMentionMenu({ store }: { store: MentionSuggestionStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get, noState)
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<CommandMenuHandle>(null)

  // The editor's keys reach the menu while it shows (↑ ↓ ↵ tab).
  useEffect(() => {
    store.setKeys((e) => menuRef.current?.handleKey(e) ?? false)
    return () => store.setKeys(null)
  }, [store])

  const pick = (row: MenuSearchRow) => {
    const mention = menuRowMention(row)
    if (mention) store.get()?.pick(mention)
  }

  if (!state) return null
  return (
    <>
      {createPortal(
        // Where `@…` sits on screen: the menu opens under it.
        <div
          ref={anchorRef}
          aria-hidden
          data-record-mention-anchor=""
          style={{
            position: 'fixed',
            left: state.rect.left,
            top: state.rect.top,
            width: 1,
            height: Math.max(state.rect.bottom - state.rect.top, 1),
            pointerEvents: 'none',
          }}
        />,
        document.body,
      )}
      <CommandMenu
        open
        trigger="@"
        query={state.query}
        skills={NO_SKILLS}
        onSelectSkill={noop}
        onMentionRecord={pick}
        mentionKinds={MENTION_PICKER_KINDS}
        onDismiss={store.dismiss}
        anchorRef={anchorRef}
        menuRef={menuRef}
        placement={{ side: 'bottom', width: Math.min(MENU_WIDTH, window.innerWidth - 32), mentionWord: 'mention' }}
      />
    </>
  )
}
