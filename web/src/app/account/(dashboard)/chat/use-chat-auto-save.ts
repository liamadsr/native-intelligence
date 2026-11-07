import { useEffect, useRef, useCallback } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { EVE_WRITTEN_METADATA_KEY } from '@/lib/chat/eve-message-writer'
import { isOpenedCardMessage, openedCardFromPart } from '@/lib/chat-cards/opened-card'

function generateTitle(messages: UIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user' && !isOpenedCardMessage(m))
  if (!firstUserMsg) {
    // A chat that so far holds only pages opened from `/` is named for the first.
    const opened = messages.flatMap((m) => m.parts.map(openedCardFromPart)).find((c) => c !== null)
    return opened ? opened.spec.title.slice(0, 60) : 'New conversation'
  }

  const textPart = firstUserMsg.parts?.find((p) => p.type === 'text') as
    | { text: string }
    | undefined
  const text = textPart?.text ?? ''

  const trimmed = text.trim().slice(0, 60)
  if (!trimmed) return 'New conversation'
  return trimmed.length < text.trim().length ? trimmed + '...' : trimmed
}

/** True for messages the SERVER already persisted, which the client must NOT
 *  re-save. Two sources, both born-saved:
 *    - live-capture agent posts (greeting/say_to_user/proposals) injected into
 *      useChat via Realtime — tagged metadata.live_capture===true;
 *    - eve-routed turns projected into chat_messages server-side by the eve
 *      message-writer (Phase 4) — tagged metadata.eve_written===true.
 *  Re-sending either would duplicate rows but for the DB unique index, and would
 *  misattribute them in the epoch/title logic. */
function isServerWritten(m: UIMessage): boolean {
  const meta = m.metadata as
    | { live_capture?: unknown; [EVE_WRITTEN_METADATA_KEY]?: unknown }
    | undefined
  return meta?.live_capture === true || meta?.[EVE_WRITTEN_METADATA_KEY] === true
}

/**
 * Client half of chat persistence. Diffing is by MESSAGE ID (a saved-id set),
 * not by position: a count-based slice broke the moment anything other than a
 * completed turn grew the array — live-capture agent messages arriving over
 * Realtime shifted the base and got the tail re-sent (duplicate rows on
 * reload). The saved-id set + the server's upsert-on-(conversation,message-id)
 * make persistence idempotent from both ends.
 */
export function useChatAutoSave(
  messages: UIMessage[],
  status: string,
  initialConversationId?: string,
) {
  const conversationIdRef = useRef<string | null>(initialConversationId ?? null)
  const savedIdsRef = useRef<Set<string>>(
    new Set(initialConversationId ? messages.map((m) => m.id) : []),
  )
  const savingRef = useRef(false)
  const prevStatusRef = useRef(status)
  // Bumped whenever the tracked conversation is reset (New chat / falsy sync).
  // A create-save captures the epoch before firing; if it changed by the time
  // the POST resolves, the conversation was cleared underneath it, so the
  // resolved id is stale and must NOT be written back (else New chat's next turn
  // would append to the conversation we just abandoned).
  const epochRef = useRef(0)

  // Sync initial conversation id when it changes (e.g. loading a historical
  // conversation, or remounting on workspace switch with a different stored id).
  // A falsy transition (e.g. a remount onto a fresh, empty shared chat) RESETS
  // the refs so the next turn creates a new conversation rather than appending
  // to a stale one.
  useEffect(() => {
    if (initialConversationId) {
      conversationIdRef.current = initialConversationId
    } else {
      conversationIdRef.current = null
      savedIdsRef.current = new Set()
      epochRef.current += 1
    }
  }, [initialConversationId])

  // The thread as last rendered, for a save asked for outside a render (persistNow).
  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  })
  // A persistNow that arrived while a save was out: run once that save settles.
  const persistPendingRef = useRef(false)
  // The create-save in flight (resolving to its conversation id, null if it
  // failed or was abandoned), for pendingCreate.
  const createRef = useRef<Promise<string | null> | null>(null)
  // writeUnsaved and runPendingPersist call each other: a settled save reaches
  // the latest runPendingPersist through this ref.
  const runPendingPersistRef = useRef<() => void>(() => {})

  /**
   * Write `unsaved` (messages of `all` not saved yet): onto the tracked
   * conversation, or into a new one. One save at a time (savingRef); the
   * caller checks it.
   */
  const writeUnsaved = useCallback((unsaved: UIMessage[], all: UIMessage[]) => {
    savingRef.current = true
    const messages = all
    const unsavedIds = unsaved.map((m) => m.id)

    if (!conversationIdRef.current) {
      // First save: create conversation. Capture the epoch so a New chat (or
      // workspace switch) that fires while this POST is in flight invalidates
      // the resolved id instead of resurrecting the abandoned conversation.
      // The row is named from its first message (the main chat shows no
      // title: one-chat Slice 1).
      const epochAtSave = epochRef.current
      const title = generateTitle(messages)
      const created: Promise<string | null> = fetch('/api/account/chat-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, messages: unsaved }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status))
          return r.json()
        })
        .then((data) => {
          if (data.conversationId && epochRef.current === epochAtSave) {
            conversationIdRef.current = data.conversationId
            for (const id of unsavedIds) savedIdsRef.current.add(id)
            return data.conversationId as string
          }
          return null
        })
        .catch(() => {
          // Silently fail — will retry on next response
          return null
        })
        .finally(() => {
          if (createRef.current === created) createRef.current = null
          savingRef.current = false
          runPendingPersistRef.current()
        })
      createRef.current = created
    } else {
      fetch(`/api/account/chat-history/${conversationIdRef.current}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: unsaved }),
      })
        .then((r) => {
          if (r.ok) for (const id of unsavedIds) savedIdsRef.current.add(id)
        })
        .catch(() => {
          // Silently fail — will retry on next response
        })
        .finally(() => {
          savingRef.current = false
          runPendingPersistRef.current()
        })
    }
  }, [])

  /** The unsaved messages of `all` the client must write (not server-written ones). */
  const unsavedOf = (all: UIMessage[]) => all.filter((m) => !savedIdsRef.current.has(m.id) && !isServerWritten(m))

  /** A persistNow held back by a save in flight, run with the thread as it is now. */
  function runPendingPersist() {
    if (!persistPendingRef.current || savingRef.current) return
    persistPendingRef.current = false
    const unsaved = unsavedOf(messagesRef.current)
    if (unsaved.length) writeUnsaved(unsaved, messagesRef.current)
  }
  useEffect(() => {
    runPendingPersistRef.current = runPendingPersist
  })

  useEffect(() => {
    const wasStreaming =
      prevStatusRef.current === 'streaming' || prevStatusRef.current === 'submitted'
    prevStatusRef.current = status

    // Only save when status transitions from streaming/submitted to ready
    if (!wasStreaming || status === 'streaming' || status === 'submitted') return
    if (savingRef.current) return

    const unsaved = unsavedOf(messages)
    if (unsaved.length === 0) return

    // Must have at least one assistant message
    const hasAssistantMessage = messages.some((m) => m.role === 'assistant')
    if (!hasAssistantMessage) return

    writeUnsaved(unsaved, messages)
  }, [messages, status, writeUnsaved]) // eslint-disable-line react-hooks/exhaustive-deps -- unsavedOf reads refs only

  /**
   * Save what is unsaved NOW, with no turn: a card the person opened from `/`
   * (lib/chat-cards/opened-card.ts) is a message of theirs that no reply
   * follows, so the turn-end save above would never write it. `thread` is the
   * chat with it in (setMessages has not rendered yet); on a chat with no
   * conversation yet, this creates one. A save already out finishes first.
   */
  const persistNow = useCallback((thread: UIMessage[]) => {
    messagesRef.current = thread
    if (savingRef.current) {
      persistPendingRef.current = true
      return
    }
    const unsaved = unsavedOf(thread)
    if (unsaved.length) writeUnsaved(unsaved, thread)
  }, [writeUnsaved]) // eslint-disable-line react-hooks/exhaustive-deps -- unsavedOf reads refs only

  const setConversationId = useCallback((id: string, loadedMessages: UIMessage[]) => {
    conversationIdRef.current = id
    savedIdsRef.current = new Set(loadedMessages.map((m) => m.id))
    // Invalidate any in-flight create-save: loading a conversation (esp. the
    // live-capture thread) switches the tracked id out from under a POST that
    // may still be resolving. Without bumping the epoch, that POST's .then
    // would clobber conversationIdRef back to the abandoned new-chat id, and
    // the user's talk-back turns would autosave to the wrong conversation.
    epochRef.current += 1
  }, [])

  /**
   * Adopt a conversation id MINTED SERVER-SIDE before the client would have
   * created one (the eve transport's mint route creates the durable
   * `chat_conversations` row on a fresh chat and hands its id back here). Binding
   * it now means the next auto-save PATCHes the user message onto THAT row rather
   * than POSTing a fresh conversation — the fix for the eve conversation split
   * (mint row A vs client row B). Unlike setConversationId this does NOT mark any
   * messages saved (the pending user turn is still unsaved and must be written to
   * the adopted row), and it only binds when the client hasn't already tracked a
   * conversation — a no-op if we're mid-conversation, so it never re-homes an
   * established thread. */
  const adoptServerConversationId = useCallback((id: string) => {
    if (conversationIdRef.current) return
    conversationIdRef.current = id
    // Do NOT reset savedIdsRef — any ids already marked saved stay saved; the
    // unsaved user turn will PATCH onto the adopted row. Bump the epoch so an
    // in-flight create-save (should not exist on a fresh chat, but be safe)
    // can't clobber the adopted id back to null.
    epochRef.current += 1
  }, [])

  const getConversationId = useCallback(() => conversationIdRef.current, [])

  /**
   * The conversation this chat's first save is creating right now, resolving
   * to its id (null if it failed or the chat was cleared under it), or null
   * when no create is out. The eve transport's first send waits for it, so
   * the turn mints against that row instead of making another.
   */
  const pendingCreate = useCallback(() => createRef.current, [])

  /** Mark ids as already persisted (server-written rows merged in via Realtime,
   *  which arrive born-saved). Belt-and-suspenders next to isServerWritten. */
  const markSaved = useCallback((ids: string[]) => {
    for (const id of ids) savedIdsRef.current.add(id)
  }, [])

  /** Drop the tracked conversation so the next save creates a new one (New chat).
   *  Bumps the epoch so an in-flight create-save can't write its id back. */
  const clearConversation = useCallback(() => {
    conversationIdRef.current = null
    savedIdsRef.current = new Set()
    epochRef.current += 1
  }, [])

  return { setConversationId, adoptServerConversationId, getConversationId, pendingCreate, clearConversation, markSaved, persistNow }
}
