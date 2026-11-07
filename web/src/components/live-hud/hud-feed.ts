/**
 * What the live agent's HUD shows, and what it does, whichever host it's in
 * (AgentHudView, ./agent-hud-view.tsx):
 *   - the desktop's HUD window (app/hud/agent) feeds it from the recording
 *     window's Tauri events (Voice ID, who spoke last from the transcript's
 *     tail, the agent's nudges, the call's conversation, the meeting's
 *     scheduled time, the person's pre-call brief) and sends Voice ID clicks and flushes back the same way;
 *   - the web's floating HUD (./web-hud.tsx) feeds it from the page itself:
 *     the recording context, through ./in-page-hud-feed.tsx.
 *
 * The feed is plain data, replaced (never mutated) on each change.
 */
import type { VoiceIdHudAction, VoiceIdHudState } from '@/lib/live-agent/voice-id-hud'
import type { TranscriptHudLine } from '@/lib/live-agent/transcript-hud'
import type { LiveHudConversation } from '@/lib/live-agent/live-hud'
import type { HudRecordingAction, HudRecordingState } from '@/lib/live-agent/hud-recording'
import type { HudSchedule } from '@/lib/live-agent/hud-schedule'
import type { HudBrief } from '@/lib/live-agent/hud-brief'
import type { LiveChatSayShown } from '@/components/live-chat/live-chat'

/** One of the agent's say_to_user nudges, as its broadcast carries it (lib/live-agent/nudge-channel). */
export interface AgentHudNudge {
  id: string
  message: string
  kind?: string
  captureId?: string
  ts?: number
}

export interface AgentHudFeed {
  /** Voice ID: the speakers heard and who they are (null until the recording has said). */
  voiceId: VoiceIdHudState | null
  /** Who spoke last (the transcript tail's newest line), for the participants row's highlight. */
  lastSpeaker: string | null
  /** The agent's nudges as they arrived, oldest first (the view drops repeats by id). */
  nudges: readonly AgentHudNudge[]
  /** The call's conversation with its live agent (null until it's open): the chat talks in it. */
  conversation: LiveHudConversation | null
  /** The recording's controls in the header (lib/live-agent/hud-recording.ts): null until it has said, and once it stops. */
  recording: HudRecordingState | null
  /** The meeting's scheduled start and end (lib/live-agent/hud-schedule.ts), for the header's time fill: null without a scheduled end. */
  schedule: HudSchedule | null
  /** The person's pre-call brief (lib/live-agent/hud-brief.ts), for the Briefing line: null when there is none. */
  brief: HudBrief | null
}

export interface AgentHudActions {
  /** A Voice ID click: run by the recording's own handlers. */
  sendVoiceIdAction: (action: VoiceIdHudAction) => void
  /** Before each chat send: push the transcript to the server (capped by the chat). */
  beforeSend?: () => Promise<void>
  /** A click on the header's recording controls: run by the recording's own handlers. */
  sendRecordingAction?: (action: HudRecordingAction) => void
  /**
   * Save the call's goal from the HUD's goal line ('' clears it; lib/live-agent/hud-goal.ts),
   * written by the recording's window. Resolves false when it wasn't saved. None: no goal
   * line, and the Briefing line shows the goal as before.
   */
  saveGoal?: (goal: string) => Promise<boolean>
  /** Each heads-up the chat draws, once (the host's telemetry: ./use-hud-telemetry.ts). Stable. */
  onSayShown?: (say: LiveChatSayShown) => void
}

export const EMPTY_HUD_FEED: AgentHudFeed = {
  voiceId: null,
  lastSpeaker: null,
  nudges: [],
  conversation: null,
  recording: null,
  schedule: null,
  brief: null,
}

/** Who spoke last in a transcript tail (its lines in transcript order): the newest line with words. */
export function lastSpeakerOf(lines: readonly Pick<TranscriptHudLine, 'speaker' | 'text'>[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].text.trim()) return lines[i].speaker
  return null
}

/** Nudges kept in a feed (the list shows the newest; older ones scroll off anyway). */
export const HUD_NUDGES_KEPT = 50

/** `nudges` with `nudge` added, unless it's there already; the oldest let go past HUD_NUDGES_KEPT. */
export function withNudge(nudges: readonly AgentHudNudge[], nudge: AgentHudNudge): readonly AgentHudNudge[] {
  if (!nudge?.message || nudges.some((n) => n.id === nudge.id)) return nudges
  const next = [...nudges, nudge]
  return next.length > HUD_NUDGES_KEPT ? next.slice(next.length - HUD_NUDGES_KEPT) : next
}

/** A small store for a feed (the in-page host's: a leaf writes, the HUD reads). */
export interface HudFeedStore {
  get: () => AgentHudFeed
  set: (next: Partial<AgentHudFeed>) => void
  pushNudge: (nudge: AgentHudNudge) => void
  subscribe: (listener: () => void) => () => void
}

export function createHudFeedStore(initial: AgentHudFeed = EMPTY_HUD_FEED): HudFeedStore {
  let feed = initial
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    get: () => feed,
    set: (next) => {
      let changed = false
      for (const key of Object.keys(next) as Array<keyof AgentHudFeed>) {
        if (next[key] !== feed[key]) changed = true
      }
      if (!changed) return
      feed = { ...feed, ...next }
      emit()
    },
    pushNudge: (nudge) => {
      const nudges = withNudge(feed.nudges, nudge)
      if (nudges === feed.nudges) return
      feed = { ...feed, nudges }
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
