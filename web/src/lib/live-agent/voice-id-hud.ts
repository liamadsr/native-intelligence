/**
 * Voice ID in the live agent's HUD (desktop): what the window recording a live
 * capture and the `agent-hud` window (/hud/agent) say to each other.
 *
 * On desktop, while a live capture records, Voice ID — the speakers heard so
 * far, each a pill you click to link to a contact — shows in the HUD instead of
 * above the chat composer (it comes back to the composer when the capture
 * stops: post-session review and later linking happen on the capture page).
 * The HUD is a separate webview with no recording of its own, so:
 *   - the recording window sends it the whole Voice ID state (STATE_EVENT,
 *     to the HUD) whenever any of it changes, and again when the HUD says it
 *     is up (READY_EVENT, so a HUD that loads late still gets it);
 *   - the HUD sends every click back (ACTION_EVENT, a broadcast — it doesn't
 *     know which window records), and the recording window runs it through
 *     its own Voice ID handlers, exactly as a click on the composer row does.
 * Actions carry the capture id; a window not recording that capture ignores
 * them.
 *
 * Client-safe: no server imports.
 */
import type { VoiceIdProps } from '@/components/capture/live-capture-header'
import type { SpeakerIdentification } from '@/lib/voice-id-service'

/** The HUD window's label (desktop: commands/hud.rs show_agent_hud). */
export const AGENT_HUD_WINDOW = 'agent-hud'
/** Recording window → HUD: a VoiceIdHudState. */
export const VOICE_ID_HUD_STATE_EVENT = 'voice-id-hud:state'
/** HUD → any window: the HUD page is listening; send the state. No payload. */
export const VOICE_ID_HUD_READY_EVENT = 'voice-id-hud:ready'
/** HUD → any window: a VoiceIdHudAction. */
export const VOICE_ID_HUD_ACTION_EVENT = 'voice-id-hud:action'

type PostSessionReview = NonNullable<VoiceIdProps['postSessionReview']>

/** Everything the HUD's Voice ID row draws. JSON: it crosses windows. */
export interface VoiceIdHudState {
  captureId: string
  /** The recording window's workspace: the HUD's contact search runs in it. */
  workspaceId: string | null
  detectedSpeakers: string[]
  /** Unused by the HUD (who spoke last rides the transcript's tail), sent as null. */
  activeSpeaker: string | null
  speakerNames: Record<string, string>
  demotedSelfLabels: string[]
  /** Each counting suggestion with its `autoAcceptCountdown` as sent and its
   *  `autoAcceptAt` (when it runs out): the HUD's chip counts down to it
   *  without a tick store of its own, and nothing is sent per second. */
  speakerContacts: Record<string, SpeakerIdentification>
  postSessionReview: PostSessionReview | null
  selfSuggestion: { speakerId: string; similarity: number } | null
}

type SpeakerActionType =
  | 'acceptSuggestion'
  | 'dismissSuggestion'
  | 'unlinkSpeaker'
  | 'confirmSelf'
  | 'dismissSelf'
  | 'confirmPostSessionSpeaker'
type ContactActionType = 'assignContact' | 'reassignPostSessionSpeaker'

/** A Voice ID click in the HUD, for the recording window to run. */
export type VoiceIdHudAction =
  | { captureId: string; type: SpeakerActionType; speaker: string }
  | { captureId: string; type: ContactActionType; speaker: string; contactId: string; contactName: string }

/** The Voice ID handlers an action runs through (the composer row's own). */
export type VoiceIdHudHandlers = Pick<
  VoiceIdProps,
  | 'assignContact'
  | 'acceptSuggestion'
  | 'dismissSuggestion'
  | 'unlinkSpeaker'
  | 'confirmPostSessionSpeaker'
  | 'reassignPostSessionSpeaker'
  | 'confirmSelf'
  | 'dismissSelf'
>

const SPEAKER_ACTIONS: ReadonlySet<string> = new Set<SpeakerActionType>([
  'acceptSuggestion',
  'dismissSuggestion',
  'unlinkSpeaker',
  'confirmSelf',
  'dismissSelf',
  'confirmPostSessionSpeaker',
])
const CONTACT_ACTIONS: ReadonlySet<string> = new Set<ContactActionType>(['assignContact', 'reassignPostSessionSpeaker'])

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The state to send, from the recording's Voice ID values and its
 *  auto-accept tick store (`getTick`: the live seconds left on a suggestion).
 *  A suggestion counting down also carries `autoAcceptAt`, the moment it runs
 *  out, so the receiving window counts down to it itself: the state is sent
 *  when something changes, never once a second for the countdown. */
export function voiceIdHudState(
  input: Omit<VoiceIdHudState, 'demotedSelfLabels'> & { demotedSelfLabels?: ReadonlySet<string> },
  getTick?: (suggestion: SpeakerIdentification) => number | undefined,
  now: number = Date.now(),
): VoiceIdHudState {
  const speakerContacts: Record<string, SpeakerIdentification> = {}
  for (const [speaker, contact] of Object.entries(input.speakerContacts)) {
    const seconds = contact.isSuggestion ? (getTick?.(contact) ?? contact.autoAcceptCountdown) : undefined
    speakerContacts[speaker] =
      seconds === undefined || seconds === null ? contact : { ...contact, autoAcceptCountdown: seconds, autoAcceptAt: now + seconds * 1000 }
  }
  return {
    ...input,
    demotedSelfLabels: input.demotedSelfLabels ? [...input.demotedSelfLabels] : [],
    speakerContacts,
  }
}

/**
 * Run a HUD action through `handlers` — only when it is well formed and for
 * `captureId` (the capture this window records). It arrives from another
 * window, so its shape is checked, not trusted. True when it ran.
 */
export function runVoiceIdHudAction(
  action: unknown,
  captureId: string | null,
  handlers: VoiceIdHudHandlers,
): boolean {
  if (!captureId || !action || typeof action !== 'object') return false
  const a = action as Record<string, unknown>
  if (a.captureId !== captureId || !isText(a.type) || !isText(a.speaker)) return false
  const speaker = a.speaker
  if (CONTACT_ACTIONS.has(a.type)) {
    if (!isText(a.contactId) || typeof a.contactName !== 'string') return false
    const run = a.type === 'assignContact' ? handlers.assignContact : handlers.reassignPostSessionSpeaker
    if (!run) return false
    run(speaker, a.contactId, a.contactName)
    return true
  }
  if (!SPEAKER_ACTIONS.has(a.type)) return false
  const run = handlers[a.type as SpeakerActionType]
  if (!run) return false
  run(speaker)
  return true
}
