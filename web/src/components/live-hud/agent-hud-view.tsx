'use client'

/**
 * The live agent's HUD: one view for both hosts (one-chat plan, Slice 3/4) —
 * the desktop's always-on-top `agent-hud` window (app/hud/agent, 472×536) and
 * the web's floating panel (./web-hud.tsx). Each host hands it a feed and the
 * actions (./hud-feed.ts); the view never talks to Tauri or to the recording.
 *
 * A glass pop-up chat (Liam, 10-15: "style it like a nicer, full version of
 * those bot chats"): one glass sheet (components/agent-ui GlassBackdrop), a
 * glass pill on top, and the live chat's conversation and composer
 * (components/live-chat). Top to bottom:
 *   - the header pill (live sidekick plan, Phase 2, 10-17: the agent's face
 *     and name are gone): on its left what the host puts there (the desktop
 *     window's screen-share eye, ./hud-share-eye.tsx; nothing on web), then
 *     what the agent is doing and the meeting's time left
 *     (./hud-schedule-bar.tsx), and on its right the recording's controls
 *     (Liam, 10-15: moved from the top bar's Capture pill;
 *     ./hud-recording-controls.tsx): the elapsed time, back to the capture,
 *     pause / resume and stop, each click sent back through the host;
 *     The header's background is the meeting's time (./hud-schedule-bar.tsx
 *     HudScheduleFill): it fills from the left, green to purple to red, as
 *     the scheduled time goes, and is all red past the end; only for a
 *     meeting with a scheduled end;
 *   - who's on the call: a chip per voice heard, its initials and Voice ID's
 *     own control (VoiceIdSpeaker: name an unknown speaker, accept or dismiss
 *     a suggested match, each click sent back through the host), the one who
 *     spoke last highlighted. A class change, no animation. A speaker Voice
 *     ID has linked to a contact opens its card with who they are
 *     (./hud-person-card.tsx);
 *   - the goal line (./hud-goal-line.tsx, live sidekick plan, Phase 5):
 *     the person's goal for the call, edited in place, or a quiet "Set a
 *     goal" while the call is live; only when the host can save it
 *     (`actions.saveGoal`), and then the Briefing line below leaves the
 *     goal to it;
 *   - the Briefing line (./hud-briefing-line.tsx, live sidekick plan,
 *     Phase 4): the person's goal and their prep's top, collapsed to one
 *     line; only when there is a brief;
 *   - the chat with the live agent: its replies and heads-ups (say_to_user,
 *     which used to be the HUD's separate nudge list) as the agent's
 *     messages, collapsed to the last two exchanges, expanded while you type;
 *   - its composer.
 *
 * No animation loop of its own runs while the call goes on: no aura, no page
 * turns (the speaker sheets are gone, 10-15: they cost too much), no
 * streaming terminal. The chat box wears the call's audio-reactive glow
 * (components/live-chat/call-glow.tsx), driven by the host's level source
 * (`audioLevels`) and running only while the call is live, the HUD showing
 * and audio flowing.
 *
 * A feed change re-renders only what it changes: the chat is memoized on
 * stable props (it never re-renders for Voice ID or who spoke last), and each
 * participant's chip is memoized on what it draws, so a change of speaker
 * re-renders the two chips it moves between. A suggestion's countdown runs in
 * its own leaf (useAutoAcceptCountdown), never through the feed, and so do
 * the meeting's time left and its bar (one 30 s step clock).
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { VoiceIdSpeaker } from '@/components/capture/live-capture-header'
import { GlassBackdrop } from '@/components/agent-ui/glass-backdrop'
import { BotFaceChip } from '@/components/bots/bot-face-chip'
import { BOT_GLASS, BOT_GLASS_ENTER, BOT_GLASS_INSET, BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import { HudAudioGlow } from '@/components/live-chat/call-glow'
import { LiveChat } from '@/components/live-chat/live-chat'
import { PromptInput, PromptInputTextarea } from '@/components/ui/prompt-input'
import { getSpeakerDisplayName } from '@/hooks/use-recording'
import type { VoiceIdHudAction, VoiceIdHudState } from '@/lib/live-agent/voice-id-hud'
import type { SpeakerIdentification } from '@/lib/voice-id-service'
import { cn } from '@/lib/utils'
import type { HudRecordingActionType } from '@/lib/live-agent/hud-recording'
import type { AgentHudActions, AgentHudFeed } from './hud-feed'
import type { HudAudioLevels } from './hud-audio-levels'
import { HudRecordingControls } from './hud-recording-controls'
import { HudScheduleFill, HudTimeLeft } from './hud-schedule-bar'
import { HudPersonCard, usePrefetchHudPerson } from './hud-person-card'
import { HudBriefingLine } from './hud-briefing-line'
import { HudGoalLine } from './hud-goal-line'
import { useLiveAgentName } from './use-live-agent-name'

export interface AgentHudViewProps {
  feed: AgentHudFeed
  actions: AgentHudActions
  /** Which host: the desktop's own window, or a panel in the app's page. */
  host: 'window' | 'page'
  /** Bumped by the host to collapse the chat (the web HUD's Escape). */
  collapseRequest?: number
  /** The chat expanded or collapsed. */
  onChatExpandedChange?: (expanded: boolean) => void
  /** On the header's right, after the recording's controls (a host's own buttons). */
  headerActions?: ReactNode
  /** On the header's left (the desktop window's screen-share eye, `data-hud-share-eye`: the header's padding follows it as rendered). None: the header starts with its words. */
  headerStart?: ReactNode
  /** The call's audio level, for the chat box's glow (./hud-audio-levels.ts). Stable; none: no glow. */
  audioLevels?: HudAudioLevels | null
  /**
   * Drawn in the chat's place (the landing page's scripted HUD,
   * components/landing/hud-tips-demo.tsx: no conversation to load or talk
   * in). None: the call's LiveChat.
   */
  chat?: ReactNode
  /** With `chat`: whether a reply is on its way (the header says "Replying…"). */
  busy?: boolean
  className?: string
}

/** The desktop window's HUD, clipped to its sheet's corners (GlassBackdrop's 28px). */
export const HUD_WINDOW_CLIP = '[clip-path:inset(0_round_28px)]'

export function AgentHudView({
  feed,
  actions,
  host,
  collapseRequest,
  onChatExpandedChange,
  headerActions,
  headerStart,
  audioLevels = null,
  chat,
  busy: busyOverride,
  className,
}: AgentHudViewProps) {
  const { voiceId, conversation, lastSpeaker } = feed
  const agentName = useLiveAgentName(conversation?.agentId ?? null)
  const name = agentName ?? 'Live agent'
  const [chatBusy, setBusy] = useState(false)
  const busy = busyOverride ?? chatBusy
  const chatAvatar = useMemo(() => <BotFaceChip face={null} name={name} size={12} />, [name])
  const state = !conversation && !chat ? 'Joining the call…' : busy ? 'Replying…' : 'Listening to the call'
  const onBusyChange = useCallback((b: boolean) => setBusy(b), [])
  const recording = feed.recording
  const recordingCaptureId = recording?.captureId ?? null
  const sendRecordingAction = actions.sendRecordingAction
  const onRecordingAction = useCallback(
    (type: HudRecordingActionType) => {
      if (recordingCaptureId) sendRecordingAction?.({ captureId: recordingCaptureId, type })
    },
    [recordingCaptureId, sendRecordingAction],
  )
  // The glow runs only while the call is live (the recording says so: up, not
  // paused, not finishing up). One element, re-made only when that changes,
  // so the memoized chat never re-renders for it.
  const callLive = !!recording && !recording.paused && !recording.finalizing
  const glow = useMemo(() => <HudAudioGlow levels={audioLevels} live={callLive} />, [audioLevels, callLive])
  const recordingControls = recording && sendRecordingAction ? <HudRecordingControls state={recording} onAction={onRecordingAction} /> : null
  // The goal line, when the host can save a goal: editable while the call is
  // up (recording, not finishing up; paused is still the call). The Briefing
  // line then keeps to the prep.
  const saveGoal = actions.saveGoal
  const brief = feed.brief
  const callUp = !!recording && !recording.finalizing
  const goalLineKey = recordingCaptureId ?? brief?.captureId ?? voiceId?.captureId ?? ''
  const briefingBrief = useMemo(() => (saveGoal && brief?.goal ? { ...brief, goal: null } : brief), [saveGoal, brief])

  return (
    <div
      className={cn(
        'agent-hud relative isolate flex h-full min-h-0 flex-col gap-2 p-2.5 text-foreground',
        // In its own window the sheet is the window's whole shape (the window is
        // see-through, with no native shadow). A shadow inside it, the sheet's own
        // or the composer's, can only paint into the window's corners past the
        // sheet's curve, where the square window edge cuts it: faint square "ears"
        // (Liam, 10-19). So nothing paints past the curve.
        host === 'window' && HUD_WINDOW_CLIP,
        className,
      )}
      data-host={host}
    >
      <GlassBackdrop desktop={host === 'window'} />
      <div
        data-hud-header=""
        className={cn(
          BOT_GLASS,
          BOT_GLASS_ENTER,
          // `relative isolate`: the meeting's time fills its background, under its words (HudScheduleFill).
          'pointer-events-auto relative isolate flex min-h-10 w-full min-w-0 shrink-0 items-center gap-2 rounded-full py-1 pr-1.5 transition-opacity duration-200 ease-out',
          // Tight to the eye only while it shows: the desktop passes it
          // always, but it renders nothing until the desktop answers (and
          // never on a build without the commands), and the words must
          // clear the pill's curve then.
          'pl-3.5 has-[[data-hud-share-eye]]:pl-1',
        )}
      >
        {feed.schedule && <HudScheduleFill schedule={feed.schedule} />}
        {headerStart}
        <span className="flex min-w-0 flex-1 flex-col text-[11px] leading-4">
          <span data-hud-state="" title={state} className="truncate text-[12px] font-medium leading-4">
            {state}
          </span>
          {feed.schedule && <HudTimeLeft schedule={feed.schedule} />}
        </span>
        {recordingControls}
        {headerActions}
      </div>
      <Participants state={voiceId} lastSpeaker={lastSpeaker} send={actions.sendVoiceIdAction} />
      {saveGoal && <HudGoalLine key={`goal:${goalLineKey}`} goal={brief?.goal ?? null} live={callUp} onSave={saveGoal} />}
      {briefingBrief && <HudBriefingLine key={briefingBrief.captureId} brief={briefingBrief} />}
      {chat ? (
        chat
      ) : conversation ? (
        <LiveChat
          key={conversation.conversationId}
          captureId={conversation.captureId}
          conversationId={conversation.conversationId}
          agentId={conversation.agentId}
          workspaceId={conversation.workspaceId}
          beforeSend={actions.beforeSend}
          onExpandedChange={onChatExpandedChange}
          onBusyChange={onBusyChange}
          collapseRequest={collapseRequest}
          nudges={feed.nudges}
          onSayShown={actions.onSayShown}
          agentName={agentName}
          agentAvatar={chatAvatar}
          glow={glow}
        />
      ) : (
        <WaitingChat glow={glow} />
      )}
    </div>
  )
}

/** Before the call's conversation is known: the room, and a composer that waits. */
function WaitingChat({ glow }: { glow: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-2">
      <PromptInput
        value=""
        disabled
        className={cn(BOT_GLASS, 'relative isolate flex shrink-0 items-end gap-1 rounded-[22px] p-[5px] pl-3.5')}
      >
        {/* The call's glow: on the call already, before its chat is open. */}
        {glow}
        <PromptInputTextarea
          aria-label="Message the live agent"
          placeholder="Waiting for the call…"
          className="min-h-0 min-w-0 flex-1 px-0 py-1.5 text-[13px] leading-5"
          rows={1}
        />
      </PromptInput>
    </div>
  )
}

// ── Who's on the call ───────────────────────────────────────────

/** "Sam Rivera" → "SR", "Speaker 2" → "S2", "You" → "Y". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]][0] ?? ''
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : ''
  return (first + last).toUpperCase()
}

/**
 * A chip per voice heard: initials, then Voice ID's control for that voice.
 * The one who spoke last carries `data-speaking` and a static highlight.
 */
function Participants({
  state,
  lastSpeaker,
  send,
}: {
  state: VoiceIdHudState | null
  lastSpeaker: string | null
  send: (action: VoiceIdHudAction) => void
}) {
  const demotedSelfLabels = useMemo(() => new Set(state?.demotedSelfLabels ?? []), [state?.demotedSelfLabels])
  if (!state || state.detectedSpeakers.length === 0) {
    return (
      <p className={cn('shrink-0 px-2 text-[12px] leading-6', BOT_GLASS_MUTED)} data-participants-empty>
        Listening…
      </p>
    )
  }
  const captureId = state.captureId
  return (
    <div
      role="list"
      aria-label="On the call"
      data-participants
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-0.5 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {state.detectedSpeakers.map((speaker) => {
        const contact = state.speakerContacts[speaker]
        const label =
          contact && !contact.isSuggestion
            ? contact.contactName
            : getSpeakerDisplayName(speaker, state.speakerNames, demotedSelfLabels)
        const speaking = speaker === lastSpeaker
        return (
          <ParticipantChip
            key={speaker}
            sig={chipSignature(state, speaker, label, speaking)}
            captureId={captureId}
            speaker={speaker}
            label={label}
            speaking={speaking}
            state={state}
            demotedSelfLabels={demotedSelfLabels}
            send={send}
          />
        )
      })}
    </div>
  )
}

/** What a chip draws, as one comparable string: its own contact and name, who spoke, and the review/self prompts (which can be about it). */
function chipSignature(state: VoiceIdHudState, speaker: string, label: string, speaking: boolean): string {
  const contact: SpeakerIdentification | undefined = state.speakerContacts[speaker]
  return JSON.stringify([
    speaker,
    label,
    speaking,
    contact ?? null,
    state.speakerNames[speaker] ?? null,
    state.demotedSelfLabels.includes(speaker),
    state.postSessionReview ?? null,
    state.selfSuggestion ?? null,
  ])
}

/** One voice's chip: re-renders only when what it draws (its signature) or the host's `send` changes. */
const ParticipantChip = memo(
  function ParticipantChip({
    captureId,
    speaker,
    label,
    speaking,
    state,
    demotedSelfLabels,
    send,
  }: {
    sig: string
    captureId: string
    speaker: string
    label: string
    speaking: boolean
    state: VoiceIdHudState
    demotedSelfLabels: ReadonlySet<string>
    send: (action: VoiceIdHudAction) => void
  }) {
    // Voice ID linked this voice to a contact (never a suggestion): its card
    // says who they are, fetched once this call.
    const contact = state.speakerContacts[speaker]
    const linkedContactId = contact && !contact.isSuggestion && contact.contactId ? contact.contactId : null
    const workspaceId = state.workspaceId
    usePrefetchHudPerson(captureId, workspaceId, linkedContactId)
    return (
      <div
        role="listitem"
        data-participant={speaker}
        data-speaking={speaking ? 'true' : undefined}
        aria-current={speaking ? 'true' : undefined}
        className={cn(
          'flex shrink-0 items-center gap-1 rounded-full py-0.5 pl-0.5 pr-1 transition-colors duration-150',
          speaking ? 'bg-primary/[0.12] ring-1 ring-primary/40' : BOT_GLASS_INSET,
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none transition-colors duration-150',
            speaking ? 'bg-primary text-primary-foreground' : 'bg-black/[0.06] dark:bg-white/[0.1]',
          )}
        >
          {initialsOf(label)}
        </span>
        <VoiceIdSpeaker
          variant="pill"
          speaker={speaker}
          speakerNames={state.speakerNames}
          demotedSelfLabels={demotedSelfLabels}
          speakerContacts={state.speakerContacts}
          postSessionReview={state.postSessionReview}
          selfSuggestion={state.selfSuggestion}
          assignContact={(s, contactId, contactName) => send({ captureId, type: 'assignContact', speaker: s, contactId, contactName })}
          acceptSuggestion={(s) => send({ captureId, type: 'acceptSuggestion', speaker: s })}
          dismissSuggestion={(s) => send({ captureId, type: 'dismissSuggestion', speaker: s })}
          unlinkSpeaker={(s) => send({ captureId, type: 'unlinkSpeaker', speaker: s })}
          confirmPostSessionSpeaker={(s) => send({ captureId, type: 'confirmPostSessionSpeaker', speaker: s })}
          reassignPostSessionSpeaker={(s, contactId, contactName) =>
            send({ captureId, type: 'reassignPostSessionSpeaker', speaker: s, contactId, contactName })
          }
          confirmSelf={(s) => send({ captureId, type: 'confirmSelf', speaker: s })}
          dismissSelf={(s) => send({ captureId, type: 'dismissSelf', speaker: s })}
          identifiedDetails={linkedContactId ? <HudPersonCard captureId={captureId} workspaceId={workspaceId} contactId={linkedContactId} /> : undefined}
        />
      </div>
    )
  },
  (a, b) => a.sig === b.sig && a.send === b.send && a.captureId === b.captureId,
)
