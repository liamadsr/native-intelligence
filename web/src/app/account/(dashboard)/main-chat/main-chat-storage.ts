/**
 * What the device keeps of the main chat (docs/plans/one-chat.md, Slice 1):
 * ONE chat per workspace, under its own key.
 *
 *   `dial8-chat:<workspaceId>`    the chat (ChatSlice): its stable session id,
 *                                 the conversation it is bound to, the retained
 *                                 thread and the composer's draft.
 *   `dial8-chat:last-workspace`   the workspace whose chat was on screen last,
 *                                 so boot reads the right key before the real
 *                                 workspace id arrives (it is fetched async).
 *
 * Written when the chat is made (so its session id is stable from the first
 * boot), and from the panel's live thread on pagehide and on a workspace
 * switch. Nothing writes during use: a restored panel catches its thread up
 * from the conversation's rows, so a copy that is behind costs nothing.
 *
 * The tabs this replaced kept `dial8-tabs:*`, `dial8-tabs-chat:*` and
 * `dial8-tabs-head:*`; sweepLegacyTabKeys frees them once. The retired in-app
 * browser's `dial8-tabs-browser*` go with the rest of its data
 * (lib/cloud-browser/retired-browser-data.ts), never here. The
 * retired local Claude Code pipeline's keys go once per device
 * (sweepClaudeCodeKeys).
 *
 * Every writer honours the sign-out wipe (state-wipe.ts), which takes this
 * prefix with the rest.
 */
import { applyChatRetention } from '@/lib/chat/message-retention'
import { scrubMailToolOutputsForStorage } from '@/lib/chat/mail-tool-scrub'
import { isTabStateWipeActive } from './state-wipe'
import type { ChatSlice } from './types'

export const CHAT_STORAGE_PREFIX = 'dial8-chat:'
const LAST_WORKSPACE_KEY = `${CHAT_STORAGE_PREFIX}last-workspace`

/** The key the chat of `workspaceId` is kept under. */
export function chatStorageKey(workspaceId: string): string {
  return `${CHAT_STORAGE_PREFIX}${workspaceId}`
}

/** A fresh, empty chat with a new session id. */
export function createChatSlice(): ChatSlice {
  return { chatSessionId: crypto.randomUUID(), chatMessages: [], chatInput: '', conversationId: undefined }
}

/** The chat stored for `workspaceId`, validated and bounded, or null. */
export function readStoredChat(workspaceId: string): ChatSlice | null {
  try {
    const raw = localStorage.getItem(chatStorageKey(workspaceId))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<ChatSlice> | null
    if (!v || typeof v !== 'object' || typeof v.chatSessionId !== 'string' || !v.chatSessionId) return null
    return {
      chatSessionId: v.chatSessionId,
      chatMessages: applyChatRetention(Array.isArray(v.chatMessages) ? v.chatMessages : []),
      chatInput: typeof v.chatInput === 'string' ? v.chatInput : '',
      conversationId: typeof v.conversationId === 'string' && v.conversationId ? v.conversationId : undefined,
    }
  } catch {
    // Corrupt or unreadable: the workspace starts a fresh chat.
    return null
  }
}

/** Keep `chat` as the chat of `workspaceId`. False when it wasn't written. */
export function writeStoredChat(workspaceId: string, chat: ChatSlice): boolean {
  // After a sign-out wipe a write would hand the next person on this device
  // the previous person's thread (the pagehide flush fires on /sign-out).
  if (isTabStateWipeActive()) return false
  try {
    const slice: ChatSlice = {
      chatSessionId: chat.chatSessionId,
      // No stored mail: mail tool outputs are kept as pointers in the browser too.
      chatMessages: scrubMailToolOutputsForStorage(applyChatRetention(chat.chatMessages ?? [])),
      chatInput: chat.chatInput ?? '',
      ...(chat.conversationId ? { conversationId: chat.conversationId } : {}),
    }
    localStorage.setItem(chatStorageKey(workspaceId), JSON.stringify(slice))
    return true
  } catch {
    // Storage full or unavailable: the conversation's rows still hold it.
    return false
  }
}

/** The chat a workspace has stored on this device, as its session id, or null (the automation bridge's resetUi waits on it). */
export function storedChatSummary(workspaceId: string): { chatSessionId: string } | null {
  const chat = readStoredChat(workspaceId)
  return chat ? { chatSessionId: chat.chatSessionId } : null
}

export function readLastWorkspaceId(): string | null {
  try {
    const raw = localStorage.getItem(LAST_WORKSPACE_KEY)
    return raw && raw !== 'null' ? raw : null
  } catch {
    return null
  }
}

export function writeLastWorkspaceId(workspaceId: string): void {
  if (isTabStateWipeActive()) return
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId)
  } catch {
    // ignore
  }
}

/** The tabs' keys (the one-chat rework retired them). `dial8-tabs-browser*` was the in-app browser's: retired-browser-data.ts sweeps it. */
function isLegacyTabKey(key: string): boolean {
  if (key === 'dial8-tabs' || key === 'dial8-tabs-chat') return true
  return key.startsWith('dial8-tabs:') || key.startsWith('dial8-tabs-chat:') || key.startsWith('dial8-tabs-head:')
}

/**
 * Free what the tabs left in storage, once: every tab blob, per-tab thread
 * (often megabytes each) and head. With no tab key left it only walks key
 * names, so it is cheap to run on every boot. Returns how many keys it removed.
 */
export function sweepLegacyTabKeys(): number {
  try {
    const doomed: string[] = []
    // Collect, then remove: removing while walking localStorage.key(i) shifts the indices.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && isLegacyTabKey(key)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
    return doomed.length
  } catch {
    // Best-effort: never blocks the chat.
    return 0
  }
}

/** Set once sweepClaudeCodeKeys has run on this device. */
export const CLAUDE_CODE_KEYS_SWEPT_KEY = 'dial8:claude-code-keys-swept'

/** Keys the retired local Claude Code pipeline wrote that don't start with `dial8_claude_`. */
const CLAUDE_CODE_KEYS: ReadonlySet<string> = new Set([
  'dial8_chat_use_claude_code',
  'dial8_device_id',
  'dial8_preferred_terminal',
])

/** A key the local Claude Code pipeline (chat, settings, Open in Claude Code) wrote. */
function isClaudeCodeKey(key: string): boolean {
  // `dial8_claude_*` covers the settings, the CLI session ids
  // (`dial8_claude_session:<id>`), the folder history and the system prompt.
  // The in-app browser's own `dial8-device-id` (hyphens) is a different key.
  return key.startsWith('dial8_claude_') || CLAUDE_CODE_KEYS.has(key)
}

/**
 * Remove what the retired local Claude Code pipeline left in storage, once
 * per device (flagged by CLAUDE_CODE_KEYS_SWEPT_KEY): a walk over key names,
 * never their values. Returns how many keys it removed.
 *
 * TODO(remove after 2026-12-01): by then every active device has run it once.
 * Delete this, CLAUDE_CODE_KEYS(_SWEPT_KEY), its call in main-chat-context.tsx
 * and its tests.
 */
export function sweepClaudeCodeKeys(): number {
  try {
    if (localStorage.getItem(CLAUDE_CODE_KEYS_SWEPT_KEY)) return 0
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && isClaudeCodeKey(key)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
    localStorage.setItem(CLAUDE_CODE_KEYS_SWEPT_KEY, '1')
    return doomed.length
  } catch {
    // Best-effort: never blocks the chat.
    return 0
  }
}
