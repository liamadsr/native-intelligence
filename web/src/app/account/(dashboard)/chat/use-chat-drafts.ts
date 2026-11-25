'use client'

/**
 * The main chat's box keeps each chat's own words (chat-drafts.ts): when
 * Home's current chat changes, the box's words stay with the chat they were
 * typed in and the new chat's come in, before paint.
 */
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { chatKey, getCurrentChat, subscribeCurrentChat, type CurrentChat } from './current-chat-store'
import { agentDraft, swapDraft } from './chat-drafts'

const AGENT: CurrentChat = { kind: 'agent' }
const serverChat = () => AGENT

export function useChatDrafts({ enabled, input, setInput }: { enabled: boolean; input: string; setInput: (text: string) => void }): {
  /** The agent's draft as the chat's saved copy keeps it, given the box's words now. */
  agentDraftOf: (boxText: string) => string
} {
  const chat = useSyncExternalStore(subscribeCurrentChat, getCurrentChat, serverChat)
  const key = chatKey(chat)
  const last = useRef(chat)
  const inputRef = useRef(input)
  inputRef.current = input
  const setRef = useRef(setInput)
  setRef.current = setInput
  useLayoutEffect(() => {
    const from = last.current
    last.current = chat
    if (!enabled || chatKey(from) === key) return
    const next = swapDraft(from, chat, inputRef.current)
    if (next !== inputRef.current) setRef.current(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the chat's identity
  }, [key, enabled])
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  return { agentDraftOf: useCallback((boxText: string) => (enabledRef.current ? agentDraft(getCurrentChat(), boxText) : boxText), []) }
}
