'use client'

/**
 * A plain `<textarea>` with the one `@` picker (docs/plans/mentions-everywhere.md).
 *
 * It behaves like a textarea — the same props, the same controlled
 * value/onChange — and adds `@`: typing `@word` opens the shared menu
 * (CommandMenu, as the chat and the documents' editor draw it) under the
 * field, and picking a record replaces `@word` with `@label ` and tells the
 * host (`onMention`). Plain text in, plain text out: nothing is stored in the
 * text but the `@label`; a host that keeps mentions keeps the refs `onMention`
 * hands it and sends them beside the words, as comments and team chat do.
 *
 * For the textareas that store no mention (an event's description, a campaign's
 * notes), inserting the `@label` text is all it does.
 *
 * `;` too: the person's snippets (docs/plans/snippets.md), their words put in
 * place of `;query`.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { CommandMenu, type CommandMenuHandle } from '@/app/account/(dashboard)/chat/command-menu'
import type { SkillCommand } from '@/app/account/(dashboard)/chat/chat-panel'
import { findTriggerToken, replaceToken, type ComposerMentionList, type ComposerMentionOption } from '@/app/account/(dashboard)/chat/command-menu-model'
import { MENTION_PICKER_KINDS, menuRowMention, type MenuSearchRow } from '@/lib/search/menu-search'
import type { LabeledMentionRef } from '@/lib/entity-links/mentionable'
import { SnippetMenu } from '@/components/snippets/snippet-menu'
import { useTextareaSnippets } from '@/components/snippets/use-textarea-snippets'

const NO_SKILLS: readonly SkillCommand[] = []
const noop = () => {}
/** The menu's width beside a field (a name, a line under it). */
const MENU_WIDTH = 360

/** Set a controlled textarea's value and fire React's onChange (as a keystroke would). */
function nativeSetValue(ta: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(ta, value)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

export type MentionTextareaProps = Omit<React.ComponentPropsWithoutRef<'textarea'>, 'value'> & {
  value: string
  /** A record picked from `@`: its chip's words are already in the text; the host keeps the ref if it stores mentions. */
  onMention?: (ref: LabeledMentionRef) => void
  /**
   * Teammates `@` offers ahead of the records (a comment box: canvas, spreadsheet). A pick
   * puts `@Name` in the words and is handed to `onMemberMention`; the host sends their ids.
   */
  members?: readonly ComposerMentionOption[]
  onMemberMention?: (member: ComposerMentionOption) => void
  /** Forwarded to the underlying textarea. */
  ref?: React.Ref<HTMLTextAreaElement>
}

export function MentionTextarea({ value, onChange, onKeyDown, onSelect, onBlur, onFocus, onMention, members, onMemberMention, ref: forwardedRef, ...rest }: MentionTextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const menuRef = useRef<CommandMenuHandle>(null)
  const [caret, setCaret] = useState(-1)
  const [focused, setFocused] = useState(false)
  // The trigger Esc put away (its start): it stays away until the caret leaves it.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  // The labels already picked: a trigger sitting on a completed `@label` is no
  // trigger (findTriggerToken), so the menu doesn't reopen on a just-inserted
  // mention. Forgotten when the box empties.
  const [pickedLabels, setPickedLabels] = useState<readonly string[]>([])
  if (value === '' && pickedLabels.length > 0) setPickedLabels([])

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el
      if (typeof forwardedRef === 'function') forwardedRef(el)
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
    },
    [forwardedRef],
  )

  // The `@…` token the caret is in (never a `/`, which is a plain character
  // here, and never a completed `@label` already picked).
  const token = useMemo(() => {
    const t = findTriggerToken(value, caret, { mentions: pickedLabels })
    return t?.trigger === '@' ? t : null
  }, [value, caret, pickedLabels])
  // `;`: the snippet menu (its own state; the `@` menu steps aside for it).
  const snippetsBox = useTextareaSnippets({
    value,
    enabled: focused,
    onCommit: (next) => {
      const ta = innerRef.current
      if (!ta) return
      nativeSetValue(ta, next.value)
      requestAnimationFrame(() => {
        const el = innerRef.current
        if (!el) return
        el.focus()
        if (el.value === next.value) el.setSelectionRange(next.caret, next.caret)
        setCaret(next.caret)
      })
    },
  })
  const menuOpen = !!token && focused && dismissedAt !== token.start && !snippetsBox.open

  const noteCaret = (ta: HTMLTextAreaElement) => {
    const next = ta.selectionStart === ta.selectionEnd ? ta.selectionStart : -1
    setCaret(next)
    snippetsBox.noteCaret(ta.value, next)
    // An Esc lasts while its trigger is typed on; leave it and it is forgotten.
    const t = findTriggerToken(ta.value, next)
    if (dismissedAt !== null && t?.start !== dismissedAt) setDismissedAt(null)
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(e)
    noteCaret(e.currentTarget)
  }
  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    onSelect?.(e)
    noteCaret(e.currentTarget)
  }
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the menu shows, its keys are its own (↑ ↓ ↵ tab esc).
    if (menuOpen && menuRef.current?.handleKey(e)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (snippetsBox.handleKey(e)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    onKeyDown?.(e)
  }

  /** Put `@label` where the `@word` being typed is. False when there is nowhere to put it. */
  const insert = (label: string, picked: () => void): boolean => {
    const ta = innerRef.current
    if (!ta) return false
    const current = findTriggerToken(value, caret)
    if (!current || current.trigger !== '@') return false
    const next = replaceToken(value, current, `@${label}`)
    nativeSetValue(ta, next.value)
    picked()
    setPickedLabels((prev) => (prev.includes(label) ? prev : [...prev, label]))
    setDismissedAt(null)
    requestAnimationFrame(() => {
      const el = innerRef.current
      if (!el) return
      el.focus()
      if (el.value === next.value) el.setSelectionRange(next.caret, next.caret)
      setCaret(next.caret)
    })
    return true
  }

  const pick = (row: MenuSearchRow) => {
    const mention = menuRowMention(row)
    if (mention) insert(mention.label, () => onMention?.(mention))
  }
  const pickMember = (member: ComposerMentionOption) => {
    insert(member.label, () => onMemberMention?.(member))
  }
  // With teammates: the host's own list leads, and the records are found under it (as in team chat).
  const mentionList: ComposerMentionList | undefined = members ? { options: members, onPick: pickMember, records: { kinds: MENTION_PICKER_KINDS, onPick: pick } } : undefined

  return (
    <>
      <textarea
        {...rest}
        ref={setRef}
        value={value}
        onChange={handleChange}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        onFocus={(e) => {
          setFocused(true)
          noteCaret(e.currentTarget)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          // Let a press on the menu land before it closes (the menu keeps focus itself).
          setTimeout(() => setFocused(false), 120)
          onBlur?.(e)
        }}
      />
      <CommandMenu
        open={menuOpen}
        trigger="@"
        query={token?.query ?? ''}
        skills={NO_SKILLS}
        onSelectSkill={noop}
        onMentionRecord={pick}
        mentionList={mentionList}
        mentionKinds={MENTION_PICKER_KINDS}
        onDismiss={() => token && setDismissedAt(token.start)}
        anchorRef={innerRef}
        menuRef={menuRef}
        placement={{ side: 'bottom', width: Math.min(MENU_WIDTH, (typeof window !== 'undefined' ? window.innerWidth : MENU_WIDTH) - 32), mentionWord: 'mention' }}
      />
      <SnippetMenu {...snippetsBox.menuProps} anchorRef={innerRef} side="bottom" width={MENU_WIDTH} />
    </>
  )
}
