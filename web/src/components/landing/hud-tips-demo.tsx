'use client'

/**
 * Landing demo of the live agent's heads-up display, floating over a mocked
 * call window. The HUD is the product's own (AgentHudView,
 * components/live-hud/agent-hud-view.tsx): its glass sheet, the header with
 * the meeting's time filling it and the recording's controls, who's on the
 * call (Voice ID's chips), the goal and Briefing lines, and the live chat's
 * rows and composer (LiveChatRowView and friends from
 * components/live-chat/live-chat.tsx). Only the chat's data is scripted
 * here: there is no conversation to load or talk in, so the HUD is handed
 * the scripted thread in the chat's place. Heads-ups arrive the way the
 * agent's say_to_user ones do, and once a loop the rep types a question and
 * the agent answers. Content is FICTIONAL.
 */
import { useEffect, useMemo, useState } from 'react'
import { Mic, Phone, Video } from 'lucide-react'
import { AgentHudView } from '@/components/live-hud/agent-hud-view'
import type { AgentHudActions, AgentHudFeed } from '@/components/live-hud/hud-feed'
import {
  LIVE_CHAT_COMPOSER_CLASS,
  LIVE_CHAT_TEXTAREA_CLASS,
  LiveChatRowView,
  LiveChatThinkingCard,
  liveChatThreadClass,
} from '@/components/live-chat/live-chat'
import { lastExchanges, type ThreadRow } from '@/components/live-chat/live-chat-model'
import { PromptInput, PromptInputActions, PromptInputTextarea } from '@/components/ui/prompt-input'
import { BubbleSendButton } from '@/components/agent-ui/send-button'
import { BotFaceChip } from '@/components/bots/bot-face-chip'

const AGENT = 'Sales Agent'
const CAPTURE = 'landing-demo'
const YOU = 'local_1'
const DANA = 'remote_1'

type Step =
  | { kind: 'say'; text: string; nudge: 'insight' | 'reminder' | 'suggestion'; speaker: string; hold: number }
  | { kind: 'ask'; text: string; hold: number }
  | { kind: 'reply'; text: string; think: number; hold: number }

const SCRIPT: Step[] = [
  {
    kind: 'say',
    nudge: 'suggestion',
    speaker: DANA,
    text: 'Price came up. Don’t discount yet — lead with ROI: Northwind cut ramp time 40% in their first quarter.',
    hold: 3400,
  },
  {
    kind: 'say',
    nudge: 'insight',
    speaker: DANA,
    text: 'BridgeCRM came up. They have no live coaching and no two-way HubSpot sync — ask what their reps do mid-call.',
    hold: 3000,
  },
  { kind: 'ask', text: 'What did we promise Dana on security?', hold: 300 },
  {
    kind: 'reply',
    think: 1600,
    text: 'The SOC 2 Type II report, last Tuesday. It renewed in January — offer to send it before you hang up.',
    hold: 3600,
  },
  {
    kind: 'say',
    nudge: 'suggestion',
    speaker: DANA,
    text: '“How fast could we get going?” is a buying signal. Quote the two-week rollout and ask for the pilot kickoff.',
    hold: 4200,
  },
]

const TYPE_MS = 34
const FIRST_STEP_MS = 900
const LOOP_REST_MS = 1200

interface DemoState {
  rows: ThreadRow[]
  draft: string
  busy: boolean
  speaker: string
}

const START: DemoState = { rows: [], draft: '', busy: false, speaker: YOU }

/** The scripted call: steps in order, the composer typed into a character at a time. */
function useScriptedCall(): DemoState {
  const [state, setState] = useState<DemoState>(START)
  useEffect(() => {
    let live = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t)
          resolve()
        }, ms)
        timers.add(t)
      })
    const push = (row: ThreadRow) => setState((s) => ({ ...s, rows: [...s.rows, row] }))

    async function run() {
      let loop = 0
      await wait(FIRST_STEP_MS)
      while (live) {
        for (const [i, step] of SCRIPT.entries()) {
          if (!live) return
          const id = `${loop}-${i}`
          if (step.kind === 'say') {
            setState((s) => ({ ...s, speaker: step.speaker }))
            await wait(500)
            push({ kind: 'say', id, text: step.text, nudgeKind: step.nudge })
          } else if (step.kind === 'ask') {
            setState((s) => ({ ...s, speaker: YOU }))
            for (let n = 1; n <= step.text.length && live; n++) {
              setState((s) => ({ ...s, draft: step.text.slice(0, n) }))
              await wait(TYPE_MS)
            }
            await wait(450)
            setState((s) => ({ ...s, draft: '', rows: [...s.rows, { kind: 'user', id, text: step.text }] }))
          } else {
            setState((s) => ({ ...s, busy: true }))
            await wait(step.think)
            setState((s) => ({ ...s, busy: false, rows: [...s.rows, { kind: 'reply', id, text: step.text }] }))
          }
          await wait(step.hold)
        }
        await wait(LOOP_REST_MS)
        loop++
        // A new loop starts the thread over, as the next call would.
        if (live) setState(START)
        await wait(FIRST_STEP_MS)
      }
    }
    void run()
    return () => {
      live = false
      for (const t of timers) clearTimeout(t)
    }
  }, [])
  return state
}

const NOOP_ACTIONS: AgentHudActions = { sendVoiceIdAction: () => {}, sendRecordingAction: () => {} }

function identified(name: string) {
  return { contactId: '', contactName: name, confidence: 0.96, isAutoMatched: true, isSuggestion: false }
}

/** The scripted thread in the chat's place: the live chat's collapsed thread and its composer. */
function ScriptedChat({ rows, draft, busy }: Pick<DemoState, 'rows' | 'draft' | 'busy'>) {
  const avatar = useMemo(() => <BotFaceChip face={null} name={AGENT} size={12} />, [])
  const visible = useMemo(() => lastExchanges(rows), [rows])
  const lastRow = rows.at(-1)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-live-chat data-expanded="false">
      <div className={liveChatThreadClass(false)} aria-label={`Chat with ${AGENT}`}>
        {visible.map((row) => (
          <div key={row.id} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
            <LiveChatRowView row={row} name={AGENT} avatar={avatar} thinking={false} />
          </div>
        ))}
        {busy && lastRow?.kind === 'user' && <LiveChatThinkingCard name={AGENT} avatar={avatar} />}
      </div>
      <PromptInput value={draft} onValueChange={() => {}} className={LIVE_CHAT_COMPOSER_CLASS}>
        <PromptInputTextarea
          aria-label={`Message ${AGENT}`}
          placeholder={`Message ${AGENT}…`}
          className={LIVE_CHAT_TEXTAREA_CLASS}
          rows={1}
          readOnly
          tabIndex={-1}
        />
        <PromptInputActions className="shrink-0 gap-1">{draft.trim() && <BubbleSendButton tabIndex={-1} />}</PromptInputActions>
      </PromptInput>
    </div>
  )
}

export function HudTipsDemo() {
  const { rows, draft, busy, speaker } = useScriptedCall()
  // The call's clock: 18 minutes in, 12 to go. Fixed at mount, so the
  // header's time fill and the recording's timer run from there.
  const [clock] = useState(() => Date.now())
  const feed = useMemo<AgentHudFeed>(
    () => ({
      voiceId: {
        captureId: CAPTURE,
        workspaceId: null,
        detectedSpeakers: [YOU, DANA],
        activeSpeaker: speaker,
        speakerNames: { [YOU]: 'Alex Rivera', [DANA]: 'Dana Whitfield' },
        demotedSelfLabels: [],
        speakerContacts: { [YOU]: identified('Alex Rivera'), [DANA]: identified('Dana Whitfield') },
        postSessionReview: null,
        selfSuggestion: null,
      },
      lastSpeaker: speaker,
      nudges: [],
      conversation: null,
      recording: { captureId: CAPTURE, paused: false, finalizing: false, transcription: 'connected', elapsedSec: 18 * 60 + 4, at: clock },
      schedule: { captureId: CAPTURE, start: clock - 18 * 60_000, end: clock + 12 * 60_000 },
      brief: {
        captureId: CAPTURE,
        goal: 'Book the pilot kickoff',
        prepTitle: 'Acme Corp · Evaluation',
        prepTop: '40 seats. Comparing us with BridgeCRM. Legal needs SOC 2 before signing.',
      },
    }),
    [speaker, clock],
  )

  return (
    // From sm: up a fixed stage: the call at its top left, the HUD over its lower right.
    <div className="relative mx-auto w-full max-w-lg sm:h-[500px]">
      {/* Mocked call window the HUD floats over: calls are dark in either theme. */}
      <div className="rounded-2xl bg-zinc-950 p-2 shadow-2xl ring-1 ring-border/50 sm:w-[80%]">
        <div className="grid grid-cols-2 gap-2">
          {[
            { src: '/linked-avatars/manager.jpg', name: 'Dana Whitfield', id: DANA },
            { src: '/linked-avatars/customer.jpg', name: 'Alex Rivera', id: YOU },
          ].map((tile) => (
            <div
              key={tile.name}
              className={
                'relative aspect-[4/3] overflow-hidden rounded-xl ring-2 transition-[box-shadow] duration-300 ' +
                (speaker === tile.id ? 'ring-emerald-400/80' : 'ring-transparent')
              }
            >
              <img src={tile.src} alt="" className="absolute inset-0 h-full w-full object-cover" />
              <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                {tile.name}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center gap-2 py-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800">
            <Mic className="h-3.5 w-3.5 text-zinc-300" />
          </span>
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800">
            <Video className="h-3.5 w-3.5 text-zinc-300" />
          </span>
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-red-600">
            <Phone className="h-3.5 w-3.5 rotate-[135deg] text-white" />
          </span>
        </div>
      </div>

      {/* The HUD. On mobile it sits in flow under the call (overlapping its
          foot); from sm: up it floats off the window's lower right, as the
          desktop's always-on-top window does over a call. */}
      <div className="pointer-events-none relative z-10 -mt-6 ml-auto h-[410px] w-[372px] max-w-full select-none sm:absolute sm:bottom-0 sm:right-0 sm:mt-0">
        <AgentHudView feed={feed} actions={NOOP_ACTIONS} host="page" busy={busy} chat={<ScriptedChat rows={rows} draft={draft} busy={busy} />} />
      </div>
    </div>
  )
}
