/**
 * The call window, from the web's side: in the desktop app a team call or
 * meeting lives in its own floating window, apart from the app's (Liam,
 * 11-18: the call controls "pop out … the same way the live agent pops up").
 * The desktop's half is src-tauri/src/commands/call_window.rs.
 *
 * A camera or microphone stream cannot be handed from one window to another,
 * so the call is joined in exactly one place:
 *
 *   The app's windows (the dashboards) ask the server to start, join or
 *   answer, as they always did, and hand what it answered (the call, its join
 *   token) to the desktop with openCallWindow. They never connect. They show
 *   the call's state as the call window says it (STATE_EVENT), so team chat's
 *   "Call in progress" and its buttons stay right.
 *
 *   The call window's page (/hud/call) takes the call (takeCallWindowCall),
 *   connects, draws the panel, and says its state to every window on each
 *   change and whenever one asks (ASK_EVENT: a dashboard opened or loaded
 *   again mid-call). Leaving, or the call ending, closes the window; the
 *   desktop tells every window when it is gone, however it went
 *   (CLOSED_EVENT).
 *
 * A desktop build from before the window has none of the commands:
 * openCallWindow answers 'missing', and the call stays inside the app's
 * window, laid out by call-place.ts, as in a browser.
 *
 * Client-safe: the Tauri API is loaded on first use, never on the server.
 */
import { isDesktopApp } from '@/lib/platform'
import type { MeetingGuest } from '@/lib/meeting-links/shape'
import type { CallEnd, TeamCallJoin } from './call-session'
import type { CallPlace } from './client'
import type { TeamCallFeatures, TeamCallNotesView } from './notes'

/** The call window's label (call_window.rs LABEL). */
export const CALL_WINDOW_LABEL = 'call'

/** Desktop to the call window: a call to join, now or instead of the one it is in. */
export const CALL_WINDOW_BEGIN_EVENT = 'call-window://begin'
/** Desktop to every window: the call window is gone. */
export const CALL_WINDOW_CLOSED_EVENT = 'call-window://closed'
/** The call window to every window: the call it is in (null: none any more, and why). */
export const CALL_WINDOW_STATE_EVENT = 'call-window://state'
/** A dashboard to the call window: say your state again. */
export const CALL_WINDOW_ASK_EVENT = 'call-window://ask'
/** A dashboard to the call window: leave the call. */
export const CALL_WINDOW_LEAVE_EVENT = 'call-window://leave'

/** A call as any window may show it: everything but the connection itself. */
export interface TeamCallView {
  callId: string
  channelId: string
  workspaceId: string
  channelKind: 'channel' | 'dm' | 'meeting'
  label: string
  /** The person's member id in the call's workspace. */
  memberId: string
  /** What the server offers this call. */
  features: TeamCallFeatures
  /** Its notes and recording, live. */
  notes: TeamCallNotesView
  /** A meeting's guests waiting or let in, live; empty for any other call. */
  guests: MeetingGuest[]
}

/** What a dashboard hands the call window: the server's answer to its start, join or accept. */
export interface CallWindowBegin {
  call: CallPlace
  join: TeamCallJoin
  label: string
  /** The workspace on screen in the window that asked (the call window's "Ring people" lists its members). */
  workspaceId: string | null
}

export interface CallWindowState {
  call: TeamCallView | null
  /** With `call: null`: why it is over (the app's window says so in a toast). */
  ended?: CallEnd
}

/** A call just handed to the call window, before the window has said anything about it. */
export function viewOfBegin(begin: Pick<CallWindowBegin, 'call' | 'label'>): TeamCallView {
  const { call } = begin
  return {
    callId: call.id,
    channelId: call.channelId,
    workspaceId: call.workspaceId,
    channelKind: call.channelKind,
    label: begin.label,
    memberId: call.memberId,
    features: call.features,
    notes: call.notes,
    guests: [],
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** A call to join, as the desktop hands it over: checked, since it crossed two processes. */
export function parseCallWindowBegin(raw: unknown): { begin: CallWindowBegin; fresh: boolean } | null {
  if (!isRecord(raw) || !isRecord(raw.call)) return null
  const { call, join, label, workspaceId } = raw.call as Record<string, unknown>
  if (!isRecord(call) || !isRecord(join) || !isText(label)) return null
  if (!isText(call.id) || !isText(call.channelId) || !isText(call.workspaceId) || !isText(call.memberId)) return null
  if (call.channelKind !== 'channel' && call.channelKind !== 'dm' && call.channelKind !== 'meeting') return null
  if (!isRecord(call.features) || !isRecord(call.notes)) return null
  if (!isText(join.url) || !isText(join.token) || !isText(join.room) || join.callId !== call.id) return null
  return {
    begin: { call: call as unknown as CallPlace, join: join as unknown as TeamCallJoin, label, workspaceId: isText(workspaceId) ? workspaceId : null },
    fresh: raw.fresh === true,
  }
}

/** The call window's state, as a dashboard hears it. */
export function parseCallWindowState(raw: unknown): CallWindowState | null {
  if (!isRecord(raw)) return null
  if (raw.call === null) return { call: null, ended: isText(raw.ended) ? (raw.ended as CallEnd) : undefined }
  const call = raw.call
  if (!isRecord(call) || !isText(call.callId) || !isText(call.channelId) || !isText(call.workspaceId) || !isText(call.label)) return null
  if (!isRecord(call.features) || !isRecord(call.notes)) return null
  return { call: { ...(call as unknown as TeamCallView), guests: Array.isArray(call.guests) ? (call.guests as MeetingGuest[]) : [] } }
}

let coreApi: Promise<typeof import('@tauri-apps/api/core')> | null = null
let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null
const core = () => (coreApi ??= import('@tauri-apps/api/core'))
const events = () => (eventApi ??= import('@tauri-apps/api/event'))

/** A desktop build without the command (tauri-bridge.ts isMissingCommand: "not found", or "not allowed" by its ACL). */
function isMissingCommand(cmd: string, err: unknown): boolean {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return text.includes(cmd) && /\bnot (found|allowed)\b/i.test(text)
}

/**
 * Hand a call to the call window, opening it if there is none. 'missing': not
 * the desktop app, or a build from before the window (the call stays in this
 * window). 'failed': the window couldn't be made.
 */
export async function openCallWindow(begin: CallWindowBegin): Promise<'opened' | 'missing' | 'failed'> {
  if (!isDesktopApp()) return 'missing'
  try {
    await (await core()).invoke('open_call_window', { call: begin })
    return 'opened'
  } catch (e) {
    return isMissingCommand('open_call_window', e) ? 'missing' : 'failed'
  }
}

/** The call window's page is up: the call it is for. Null: none (the window has nothing to do). */
export async function takeCallWindowCall(): Promise<{ begin: CallWindowBegin; fresh: boolean } | null> {
  try {
    return parseCallWindowBegin(await (await core()).invoke('call_window_ready'))
  } catch {
    return null
  }
}

/** Bring the call window forward. False: there is none. */
export async function showCallWindow(): Promise<boolean> {
  try {
    return (await (await core()).invoke<boolean>('show_call_window')) === true
  } catch {
    return false
  }
}

export async function closeCallWindow(): Promise<void> {
  try {
    await (await core()).invoke('close_call_window')
  } catch {
    /* not the desktop app, or the window is already gone */
  }
}

/** Say something to every window (the call window's state, a dashboard's ask). Never throws. */
export async function tellWindows(event: string, payload?: unknown): Promise<void> {
  try {
    await (await events()).emit(event, payload)
  } catch {
    /* not the desktop app */
  }
}

/** Say something to the call window only. Never throws. */
export async function tellCallWindow(event: string, payload?: unknown): Promise<void> {
  try {
    await (await events()).emitTo(CALL_WINDOW_LABEL, event, payload)
  } catch {
    /* not the desktop app */
  }
}

/**
 * Listen for one of the events above. Answers its stop, safe to call before
 * the listener is up. `onUp` runs once it is (or can't be): what must not be
 * asked for before this page can hear the answer.
 */
export function onCallWindowEvent(event: string, handler: (payload: unknown) => void, onUp?: () => void): () => void {
  let stopped = false
  let stop: (() => void) | null = null
  void events()
    .then(({ listen }) => listen(event, (e) => handler(e.payload)))
    .then((unlisten) => {
      if (stopped) unlisten()
      else stop = unlisten
    })
    .catch(() => undefined)
    .then(() => {
      if (!stopped) onUp?.()
    })
  return () => {
    stopped = true
    stop?.()
  }
}
