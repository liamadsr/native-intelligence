/**
 * The live agent's chat in its HUD (one-chat plan, Slice 3/4): what the HUD
 * needs to talk to the call's live agent itself, and how the desktop's HUD
 * window gets it from the window recording the call.
 *
 * The HUD's chat (components/live-chat) is the capture's own conversation: one
 * `chat_conversations` row per capture (POST /api/account/chat-history/live,
 * which the recording context calls when a live recording starts), pinned to
 * the live agent (its `recipe_id`). The recording context announces that row
 * in its window as LIVE_CAPTURE_CONVERSATION_EVENT (a DOM event).
 *
 * In the main window (the web HUD, components/live-hud/web-hud.tsx) the chat
 * reads that announcement straight from this module's memory. The desktop's
 * HUD is a window of its own, so the recording window's HUD publisher
 * (components/capture/voice-id-hud-publisher.tsx) passes it on:
 *   - LIVE_HUD_CONVERSATION_EVENT (recording window → HUD, Tauri emitTo): the
 *     capture's conversation and agent, whenever they change and again when
 *     the HUD says it's listening (voice-id-hud's READY_EVENT);
 *   - LIVE_HUD_FLUSH_EVENT (HUD → every window) asks the recording window to
 *     push the transcript it holds to the server before a send, so the agent's
 *     turn reads what was just said, and LIVE_HUD_FLUSHED_EVENT (recording
 *     window → HUD) says it's done. The HUD never waits on it past its cap;
 *   - LIVE_HUD_ASK_EVENT (main window → HUD, Tauri emitTo): a spoken ask during
 *     the call (Interactive mode), sent from the HUD's own chat so ONE store
 *     owns the capture's eve session and the HUD shows the ask and its reply
 *     as they stream; LIVE_HUD_ASKED_EVENT (HUD → every window) says it took
 *     it (`accepted`) and then how it went (`done` / `failed`).
 *
 * Client-safe: no server imports. Everything that crosses a window is checked,
 * not trusted.
 */

/** Within a window (DOM): the recording context opened the capture's conversation. */
export const LIVE_CAPTURE_CONVERSATION_EVENT = 'ni:live-capture-conversation'
/** Recording window → the HUD (Tauri, emitTo): a LiveHudConversation. */
export const LIVE_HUD_CONVERSATION_EVENT = 'live-hud:conversation'
/** HUD → every window (Tauri): a LiveHudFlush. */
export const LIVE_HUD_FLUSH_EVENT = 'live-hud:flush'
/** Recording window → the HUD (Tauri, emitTo): `{ id }` of the flush that's done. */
export const LIVE_HUD_FLUSHED_EVENT = 'live-hud:flushed'

/** What the HUD's chat needs to talk to a call's live agent. JSON: it crosses windows. */
export interface LiveHudConversation {
  captureId: string
  /** The capture's own chat conversation (chat_conversations.capture_id). */
  conversationId: string
  /** The live agent the conversation is pinned to (its recipe_id); null = the built-in Assistant. */
  agentId: string | null
  /** The workspace the conversation lives in (the recording window's). */
  workspaceId: string | null
}

/** Main window → the HUD (Tauri, emitTo): a LiveHudAsk. */
export const LIVE_HUD_ASK_EVENT = 'live-hud:ask'
/** HUD → every window (Tauri): a LiveHudAsked, for the ask of that id. */
export const LIVE_HUD_ASKED_EVENT = 'live-hud:asked'

/** A spoken ask for the call's live agent, to send from the HUD's chat. */
export interface LiveHudAsk {
  id: string
  captureId: string
  conversationId: string
  text: string
}

/** How a LiveHudAsk went: taken (`accepted`), then its reply in (`done`) or not sent (`failed`). */
export interface LiveHudAsked {
  id: string
  state: 'accepted' | 'done' | 'failed'
}

/** A request to push the transcript to the server before a send. */
export interface LiveHudFlush {
  captureId: string
  id: string
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const textOrNull = (v: unknown): string | null => (isText(v) ? v : null)

/** `payload` as a conversation, or null if it isn't one. */
export function readLiveHudConversation(payload: unknown): LiveHudConversation | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!isText(p.captureId) || !isText(p.conversationId)) return null
  return {
    captureId: p.captureId,
    conversationId: p.conversationId,
    agentId: textOrNull(p.agentId),
    workspaceId: textOrNull(p.workspaceId),
  }
}

/** `payload` as a flush request, or null if it isn't one. */
export function readLiveHudFlush(payload: unknown): LiveHudFlush | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  return isText(p.captureId) && isText(p.id) ? { captureId: p.captureId, id: p.id } : null
}

/** `payload` as an ask, or null if it isn't one (the text is capped, never trusted). */
export function readLiveHudAsk(payload: unknown): LiveHudAsk | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!isText(p.id) || !isText(p.captureId) || !isText(p.conversationId) || !isText(p.text)) return null
  const text = p.text.trim().slice(0, 2000)
  return text ? { id: p.id, captureId: p.captureId, conversationId: p.conversationId, text } : null
}

/** `payload` as an ask's outcome, or null. */
export function readLiveHudAsked(payload: unknown): LiveHudAsked | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!isText(p.id) || (p.state !== 'accepted' && p.state !== 'done' && p.state !== 'failed')) return null
  return { id: p.id, state: p.state }
}

/** `payload`'s flush id, or null. */
export function readLiveHudFlushed(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  return textOrNull((payload as Record<string, unknown>).id)
}

// ── The recording context's announcements, remembered ──────────────────────

/**
 * The latest conversation announced for each capture in this window (the
 * recording context's LIVE_CAPTURE_CONVERSATION_EVENT: `{ conversationId,
 * captureId, recipeId }`). Remembered from the first import on, so a
 * reader that mounts after the announcement still finds it. The workspace is
 * not in the announcement; readers add the window's.
 */
const announced = new Map<string, Omit<LiveHudConversation, 'workspaceId'>>()
const listeners = new Set<() => void>()
let listening = false

/** The recording context's announcement as a conversation (no workspace), or null. */
export function readLiveCaptureConversation(detail: unknown): Omit<LiveHudConversation, 'workspaceId'> | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  if (!isText(d.captureId) || !isText(d.conversationId)) return null
  return { captureId: d.captureId, conversationId: d.conversationId, agentId: textOrNull(d.recipeId) }
}

function onAnnounced(e: Event) {
  const next = readLiveCaptureConversation((e as CustomEvent).detail)
  if (!next) return
  const prev = announced.get(next.captureId)
  if (prev && prev.conversationId === next.conversationId && prev.agentId === next.agentId) return
  announced.set(next.captureId, next)
  for (const listener of [...listeners]) listener()
}

/** Start remembering (idempotent; a no-op off the browser). Runs on import. */
export function rememberLiveCaptureConversations(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener(LIVE_CAPTURE_CONVERSATION_EVENT, onAnnounced)
}

/** The conversation last announced for `captureId` in this window, or null. */
export function announcedLiveConversation(captureId: string | null): Omit<LiveHudConversation, 'workspaceId'> | null {
  return captureId ? (announced.get(captureId) ?? null) : null
}

/** Called whenever an announcement changes what's remembered. */
export function subscribeLiveCaptureConversations(listener: () => void): () => void {
  rememberLiveCaptureConversations()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tests only: forget every announcement. */
export function __resetLiveCaptureConversationsForTests(): void {
  announced.clear()
}

rememberLiveCaptureConversations()
