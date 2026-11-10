'use client'

/**
 * Dictate anywhere's panel (docs/plans/dictate-anywhere.md): a card at the
 * bottom of the screen while someone dictates into another app, on macOS's
 * own frosted glass (the window is the card), two lines tall: the words start on the top line and,
 * once they fill both, the newest line stays in view. It follows the app's
 * light or dark theme live (useHudTheme).
 *
 * The desktop (src-tauri/src/dictate.rs) owns the key: a tap of right ⌥ sends
 * `dictate://toggle { run, action }`. This page runs the same dictation as the
 * chat box (useDictation: local-stt, the start and end sounds, the vocabulary
 * correction, logged as `anywhere`), and hands the words to `dictate_paste`,
 * which pastes them into the app that was in front at the first tap. It says
 * something only when it has to: the words couldn't be pasted (a password
 * field, another app in front: they're on the clipboard), or listening
 * couldn't start. Otherwise the panel goes the moment the words land.
 *
 * Held instead of tapped (docs/plans/talk-anywhere.md), the words go to the
 * agent: once the press becomes a hold (`to_agent`) the card morphs into a
 * circle (the window's frame and corners animate together, desktop
 * dictate_resize_window) and shows no words, only the voice glow on the mic.
 * On release (`send`) they travel to the home thread (talk_send → the main
 * window's TalkAnywhereHost), and the circle (./talk-ring), the same voice
 * glow turned round it, travels round while the agent thinks, rises and
 * falls with its reply, then waits low. In a conversation a new press stays
 * a circle; if it turns out to be a tap (`tapped`) it morphs back into the
 * card for dictation. The circle holds the agent's face (looking at the
 * mouse). Both wear Interactive's liquid-metal ring. When a fix the person
 * made to a paste is learned (@/lib/vocabulary/learn-from-edits), the card
 * shows it a moment: "Learned  Koka Link → KokoLink". Esc's hint
 * (and on the card, the audio icon) shows only while the mouse is over it. Any press on it cuts the reply
 * and listens (a quick tap dictates and pastes again, a hold talks to the
 * agent again, in the same home thread); Esc closes it. The circle never
 * listens, so no noise can interrupt the agent.
 *
 * Every step names its press (`run`), so a late answer about an old press is
 * dropped on both sides.
 */
import { CAPTURE_LEVEL_GAIN, ComposerVoiceGlow } from '@/app/account/(dashboard)/chat/composer-voice-glow'
import { BOT_GLASS_ENTER, BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import { AgentBot, preloadAgentBot, type PointerFeed } from '@/components/bots/agent-bot'
import { MetalRing } from '@/components/read-aloud/listen-metal'
import { useDictation } from '@/hooks/use-dictation'
import { useHudTheme } from '@/lib/hud-theme'
import { playSound } from '@/lib/sounds/engine'
import { tauriBridge, type DictatePasteResult, type TalkAgentState } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import { primeVocabulary } from '@/lib/vocabulary/client'
import { learnFromEdits, type WordEdit } from '@/lib/vocabulary/learn-from-edits'
import { voiceRefusalMessage } from '@/lib/voice/messages'
import { AudioLines } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ReadAlongWord, fitSize } from './read-along'
import { TalkRing, type TalkRingState } from './talk-ring'
import { APP_IN_SYSTEM_SETTINGS } from '@/lib/desktop-app-name'

/** The card's size bounds (desktop dictate.rs PANEL_*): it starts small and grows with the words. */
export const CARD_MIN_W = 112
export const CARD_MAX_W = 390
export const CARD_ONE_LINE_H = 46
export const CARD_TWO_LINES_H = 66
/** The card around its words: padding, border, the "esc" hint (left) and the audio icon (right) with their gaps. */
const CARD_PADDING = 32 + 2
const ICON_AND_GAP = 16 + 12
const ESC_AND_GAP = 22 + 12

/**
 * The card's size for words `textWidth` px wide on one line: as wide as they
 * need (never under the smallest), and two lines at full width once they don't
 * fit on one. Pure.
 */
export function cardSize(textWidth: number, opts: { icon: boolean; esc: boolean }): { width: number; height: number } {
  const chrome = CARD_PADDING + (opts.icon ? ICON_AND_GAP : 0) + (opts.esc ? ESC_AND_GAP : 0)
  const oneLine = Math.ceil(textWidth) + chrome
  // In steps of 8 px, so it grows in calm strides rather than a twitch per letter.
  if (oneLine <= CARD_MAX_W)
    return {
      width: Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.ceil(oneLine / 8) * 8)),
      height: CARD_ONE_LINE_H,
    }
  return { width: CARD_MAX_W, height: CARD_TWO_LINES_H }
}

/** The conversation's circle (desktop dictate.rs clamps it in). */
export const CIRCLE = 104
/** The agent's face in the circle, px. */
const FACE = 56

/** The face follows the mouse over any app: the desktop sends where it is
 *  (the page can't see it, and the panel never has focus) while a face shows. */
const followPointer: PointerFeed = (onPoint) => {
  void tauriBridge.dictateWatchPointer(true)
  const off = tauriBridge.onDictatePointer(onPoint)
  return () => {
    off()
    void tauriBridge.dictateWatchPointer(false)
  }
}
/** "As round as the box allows": CSS and metal-fx clamp it to half the shorter side. */
const ROUND = 9999

/** The card's corner radius (desktop dictate.rs PANEL_RADIUS). */
const CARD_RADIUS = 18
/**
 * Read-along (spike): the card's one size, never word to word (unlike
 * dictation's, which grows with the words): room for a 16-letter word at the
 * full 17 px (a longer one, rare, shrinks to fit). 280 was more than words need (Liam 10-25).
 */
const READ_W = 200
/** How long the last word stays if no "done" comes (a safety). */
const READ_HOLD_MS = 4000
/**
 * After the last sentence queued is done, how long the card waits for
 * another before it goes: a reading's sentences come one by one, and the
 * card closing and opening again at each pause between them (a long line
 * break) looked broken (Liam 10-25).
 */
const READ_GAP_MS = 1500
/**
 * Only Read anywhere (the hotkey on selected text) shows its words: not the
 * agent's replies, in the chat or in the circle (Liam 10-25). Its sentences'
 * ids (desktop read_selection.rs).
 */
const READ_ANYWHERE_ID = /^read-selection-/
/** The flip in, kept well under a word's time at 2× (~150 ms) so it never lags the voice. */
const READ_FLIP_MS = 70

/** How long "Learned  heard → typed" stays up. */
const LEARNED_MS = 5000

/** How long a note (copied instead, couldn't start) stays up. */
const NOTE_MS = 2200
/** The most of the words kept on the page; the card shows the last two lines of them. */
const SHOWN_CHARS = 400

/** The words (`text`) when the desktop refused the paste (a newer press, or
 *  already pasted): they weren't copied either, so the card shows them. */
const NOT_PASTED_CHARS = 80

export function pasteNote(result: DictatePasteResult, text: string): string | null {
  if (result.pasted) return null
  switch (result.reason) {
    case 'secure_input':
      return 'Password field: copied instead'
    case 'focus_changed':
      return 'Copied. Press ⌘V to paste'
    case 'no_keys':
      return `Copied. Press ⌘V. To have it pasted for you, allow ${APP_IN_SYSTEM_SETTINGS} in Accessibility.`
    default:
      return text.trim() ? `Not pasted: ${tail(text, NOT_PASTED_CHARS)}` : null
  }
}

/** The end of the words, so the newest stay in view. */
export function tail(text: string, max = SHOWN_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `…${t.slice(t.length - max + 1).replace(/^\S*\s/, '')}`
}

export const AGENT_UNREACHABLE = 'Couldn’t reach Native Intelligence. Open the app and try again.'

/** Where the words go when listening stops. */
type Route = 'paste' | 'agent'
/** The conversation's circle: the agent working, speaking, or waiting for the next hold. */
type CircleState = 'thinking' | 'speaking' | 'waiting'
/** The shape while listening: the card with the words, or the circle (for the agent). */
type Shape = 'card' | 'circle'
/** How long the card and circle take to morph into each other (desktop dictate_helper.m). */
const MORPH_MS = 500

/**
 * The card's corners, as CSS works them out from the window's own height (the
 * page is the window: 100vh is its height): its own (CARD_RADIUS) up to two
 * lines tall, then growing toward the circle's as it gets taller, the glass's
 * rule (dictate_helper.m corner_for). CSS clamps any radius to half the
 * shorter side, as the glass does. Pure CSS, so nothing re-renders while the
 * window springs (a render a frame made the morph glitchy).
 */
const CARD_CORNERS = `max(${CARD_RADIUS}px, calc(${CARD_RADIUS}px + (100vh - ${CARD_TWO_LINES_H}px) * ${((CIRCLE / 2 - CARD_RADIUS) / (CIRCLE - CARD_TWO_LINES_H)).toFixed(4)}))`
/** The metal ring: its outer edge on the glass's own edge, at the glass's own
 *  radius, so the two are one curve at the corners (inset, the glass's faint
 *  rim showed as a second curve beside it, off most on a small pill), and
 *  this wide, its inner edge where it was (Liam 10-25: thicker, the inside
 *  kept). */
const RING_INSET = 0
const RING_WIDTH = 3
/** A touch quieter than Interactive's (Liam 10-25: a quarter less). */
const RING_STRENGTH = 0.75

/** The circle's glow opens like a flower (growing and turning a little, in
 *  one smooth motion: the window carries the spring, and a second wobble out
 *  of step with it looked glitchy; no blur, which flickers over the glow's
 *  canvas in WebKit) as the window opens into the circle; the card's words
 *  come back in when it closes into the card. Still under reduced motion. */
const MORPH_KEYFRAMES = `
@keyframes dictate-bloom {
  from { opacity: 0; transform: scale(0.6) rotate(-16deg) }
  45% { opacity: 1 }
  to { opacity: 1; transform: none }
}
@keyframes dictate-flip {
  from { opacity: 0.35; transform: perspective(160px) rotateX(-55deg) }
  to { opacity: 1; transform: none }
}
@keyframes dictate-unfold {
  from { opacity: 0; transform: scale(0.96) }
  to { opacity: 1; transform: none }
}
@media (prefers-reduced-motion: reduce) {
  [data-dictate-morph] { animation: none !important }
}
`

export function DictatePanel() {
  useHudTheme()
  const runRef = useRef(0)
  const routeRef = useRef<Route>('paste')
  const pasteRef = useRef<Promise<string | null> | null>(null)
  /** The words were sent to the agent this time (vs nothing said). */
  const sentRef = useRef(false)
  /** The run whose words the agent is answering: its states are the ones that count. */
  const sentRunRef = useRef(0)
  /** A conversation is open: the circle came up and Esc hasn't closed it. */
  const conversationRef = useRef(false)
  /**
   * The sounds follow what the press turned out to be, not the mic opening
   * (Liam, 10-25: a hold played dictation's click and then Live mode's chime):
   * dictation's start click once it's a tap, Live mode's chime once it's a
   * hold, and Live mode's end sound when the agent goes (Esc, or a hold that
   * comes to nothing), not dictation's. useDictation's own clicks are off.
   */
  const tappedRef = useRef(false)
  /** Dictation's start click played for this press (so its end click plays too). */
  const clickedRef = useRef(false)
  /** Live mode's chime played, its end sound not yet. */
  const liveRef = useRef(false)
  const startClick = useCallback(() => {
    if (clickedRef.current) return
    clickedRef.current = true
    playSound('stt-dictate-start')
  }, [])
  const liveOver = useCallback(() => {
    if (!liveRef.current) return
    liveRef.current = false
    playSound('voice-chat-end')
  }, [])
  const [shape, setShape] = useState<Shape>('card')
  const [circle, setCircle] = useState<CircleState | null>(null)
  const [hover, setHover] = useState(false)
  /**
   * The press is known (a tap, a hold), or a conversation's circle is up:
   * there's something to show. Until then it listens unseen (the desktop
   * shows the window only then, Liam 10-25), so a hold opens straight into
   * the circle, with no card first.
   */
  const [revealed, setRevealed] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /** A word just learned from the person's own fix, shown a moment. */
  const [learned, setLearned] = useState<WordEdit | null>(null)
  const learnedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Learned while the panel was busy: shown once it's free. */
  const learnedQueue = useRef<WordEdit[]>([])
  /** Bumped when the queue has something new to show. */
  const [learnedTick, setLearnedTick] = useState(0)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Read-along (spike): the word being said, a moment before it's heard (tts://word). */
  const [readWord, setReadWord] = useState<{ index: number; word: string } | null>(null)
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const clear = () => {
      if (readTimer.current) clearTimeout(readTimer.current)
      readTimer.current = null
      setReadWord(null)
    }
    // The sentences queued and not yet over: the card stays while there are
    // any, and a moment after (READ_GAP_MS) for the next to come.
    const pending = new Set<string>()
    const offWord = tauriBridge.onTtsWord((p) => {
      if (!READ_ANYWHERE_ID.test(p.id)) return
      if (readTimer.current) clearTimeout(readTimer.current)
      setReadWord({ index: p.index, word: p.word })
      // The safety: only once nothing more is on its way.
      readTimer.current = setTimeout(() => {
        if (pending.size === 0) clear()
      }, READ_HOLD_MS)
    })
    const offState = tauriBridge.onTtsState((p) => {
      if (!READ_ANYWHERE_ID.test(p.id)) return
      if (p.state === 'queued' || p.state === 'speaking') {
        pending.add(p.id)
        return
      }
      pending.delete(p.id)
      if (p.state !== 'done') {
        // Stopped: gone at once.
        pending.clear()
        clear()
        return
      }
      if (pending.size === 0) {
        if (readTimer.current) clearTimeout(readTimer.current)
        readTimer.current = setTimeout(clear, READ_GAP_MS)
      }
    })
    return () => {
      offWord()
      offState()
      if (readTimer.current) clearTimeout(readTimer.current)
    }
  }, [])

  /** It's over: show `message` a moment if there is one, then tell the desktop. */
  const finish = useCallback((run: number, message: string | null) => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    liveOver()
    conversationRef.current = false
    setCircle(null)
    setNote(message)
    noteTimer.current = setTimeout(
      () => {
        setNote(null)
        void tauriBridge.dictatePhase(run, 'idle')
      },
      message ? NOTE_MS : 0,
    )
  }, [liveOver])

  const dictation = useDictation({
    enabled: true,
    surface: 'anywhere',
    cues: false,
    onCommit: (text) => {
      const run = runRef.current
      if (routeRef.current === 'agent') {
        sentRef.current = true
        sentRunRef.current = run
        conversationRef.current = true
        setCircle('thinking')
        void tauriBridge.talkSend(run, text)
        return
      }
      pasteRef.current = tauriBridge.dictatePaste(run, text).then((result) => pasteNote(result, text))
    },
    onRefused: (info) => {
      finish(runRef.current, voiceRefusalMessage(info.code, info.detail))
    },
    onFinish: ({ cancelled }) => {
      const run = runRef.current
      if (routeRef.current === 'agent' && !cancelled) {
        if (sentRef.current) return // the circle carries on
        // Nothing said: back to the waiting circle, or done if there's no conversation.
        if (conversationRef.current) setCircle('waiting')
        else finish(run, null)
        return
      }
      if (cancelled) return // Esc or a cancel: the desktop has already hidden the panel
      // Dictation's end click, as it plays in the chat box: the mic is let go by now.
      if (clickedRef.current) playSound('stt-dictate-end')
      const pasted = pasteRef.current
      pasteRef.current = null
      if (pasted) void pasted.then((message) => finish(run, message))
      else finish(run, null)
    },
  })
  const dictationRef = useRef(dictation)
  dictationRef.current = dictation

  const start = useCallback((run: number, agent: boolean, shown = false) => {
    runRef.current = run
    routeRef.current = agent ? 'agent' : 'paste'
    sentRef.current = false
    tappedRef.current = false
    clickedRef.current = false
    // The last reply was cut by this press: its late states no longer count.
    sentRunRef.current = 0
    if (noteTimer.current) clearTimeout(noteTimer.current)
    setNote(null)
    setCircle(null)
    setHover(false)
    // A press takes the panel from a "learned" note (the desktop hid it).
    if (learnedTimer.current) clearTimeout(learnedTimer.current)
    setLearned(null)
    // In a conversation a press stays the circle until it's known to be a tap.
    setShape(agent || conversationRef.current ? 'circle' : 'card')
    setRevealed(shown || agent || conversationRef.current)
    if (dictationRef.current.phase === 'idle') dictationRef.current.toggle()
  }, [])

  useEffect(() => {
    // Load the vocabulary now, so the first words are corrected too.
    void primeVocabulary()
    // The agent's face, ready before a hold first morphs into the circle: fetched then, it stalled the morph.
    preloadAgentBot()
    const offToggle = tauriBridge.onDictateToggle(({ run, action }) => {
      if (action === 'start' || action === 'start_agent') return start(run, action === 'start_agent')
      if (action === 'close') {
        liveOver()
        conversationRef.current = false
        sentRunRef.current = 0
        if (dictationRef.current.phase !== 'idle') dictationRef.current.cancel()
        setCircle(null)
        setHover(false)
        setRevealed(false)
        return
      }
      if (run !== runRef.current) return
      if (action === 'to_agent') {
        routeRef.current = 'agent'
        setShape('circle')
        setRevealed(true)
        // Live mode's chime, as turning it on in the app plays it: once, as a
        // conversation opens (a later hold in it carries on, no chime). It
        // stays quiet with Sound effects off.
        if (!liveRef.current) {
          liveRef.current = true
          playSound('voice-chat-start')
        }
      } else if (action === 'tapped') {
        setShape('card')
        setRevealed(true)
        // Back to dictation: the conversation is left quietly (one sound, the click).
        liveRef.current = false
        tappedRef.current = true
        if (dictationRef.current.phase === 'listening') startClick()
      } else if (action === 'stop') {
        routeRef.current = 'paste'
        dictationRef.current.stop()
      } else if (action === 'send') {
        routeRef.current = 'agent'
        dictationRef.current.stop()
      } else {
        liveOver()
        conversationRef.current = false
        setCircle(null)
        dictationRef.current.cancel()
      }
    })
    const offAgent = tauriBridge.onDictateAgent(({ run, state }) => {
      if (run !== sentRunRef.current) return
      if (state === 'failed') return finish(run, AGENT_UNREACHABLE)
      const next: Record<Exclude<TalkAgentState, 'failed'>, CircleState> = {
        thinking: 'thinking',
        speaking: 'speaking',
        done: 'waiting',
      }
      // A hold already took over: the circle comes back when that's sent.
      if (dictationRef.current.phase !== 'idle') return
      setCircle(next[state])
    })
    // Built by the press that's waiting for it: the start event may have come first.
    void tauriBridge.dictateState().then((st) => {
      // (Whether the press was already known when the page came up isn't: shown.)
      if (st.armed && st.run !== runRef.current) start(st.run, st.agent, true)
    })
    const offHover = tauriBridge.onDictateHover(setHover)
    // The person's fixes to a paste: learned the second time, then shown.
    const offEdit = tauriBridge.onDictateEdit((edits) => {
      void learnFromEdits(edits).then((got) => {
        if (!got.length) return
        learnedQueue.current.push(...got)
        setLearnedTick((n) => n + 1)
      })
    })
    return () => {
      offEdit()
      offToggle()
      offAgent()
      offHover()
    }
  }, [start, finish, liveOver, startClick])

  useEffect(() => {
    if (dictation.phase === 'listening') {
      void tauriBridge.dictatePhase(runRef.current, 'listening')
      // A tap that came before the mic was open: its click now.
      if (tappedRef.current) startClick()
    }
  }, [dictation.phase, startClick])

  const final = dictation.transcript?.final.trim() ?? ''
  const interim = dictation.transcript?.interim.trim() ?? ''
  const hasWords = !!(final || interim)
  const listening = dictation.phase === 'listening' || dictation.phase === 'starting'
  // Only the end of a long dictation stays on the page.
  const shownFinal = tail(final, SHOWN_CHARS)
  const shownInterim = tail(interim, SHOWN_CHARS)

  // The words start on the top line and run down to the second; once they fill
  // both, the newest line stays in view and older ones go up out of sight.
  const linesRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = linesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [shownFinal, shownInterim, note, dictation.phase])

  // The listening circle (a hold, or any press in a conversation) and the
  // conversation's own circle look alike: the glow, no words.
  const listeningCircle = shape === 'circle' && (listening || dictation.phase === 'stopping')
  const round = circle !== null || listeningCircle
  // Round, "as round as it gets": CSS (and metal-fx) clamp a radius to half
  // the shorter side of the box's real size, so the circle's edge, its clip
  // and its metal stay exactly the glass's (dictate_helper.m corner_for: half
  // the shorter side) at every step of the wobble, with no lag behind the
  // window. The card's grow with its height (CARD_CORNERS).
  const radius = round ? `${ROUND}px` : CARD_CORNERS
  const ringState: TalkRingState = circle ?? (dictation.phase === 'stopping' ? 'thinking' : 'listening')

  // The card starts small (no words yet: the glow shows it hears you) and grows
  // with the words, up to two full-width lines; the circle is a fixed size.
  // Measured here, the window follows (dictate_panel_size).
  const measureRef = useRef<HTMLSpanElement>(null)
  const sizeRef = useRef('')
  // No words, no text: a tap and a dismiss used to flash "…" while it stopped (Liam, 10-25); the glow says it.
  const learnedText = learned ? `Learned  ${learned.heard}  →  ${learned.typed}` : null
  const shownText = note ?? learnedText ?? (hasWords ? [shownFinal, shownInterim].filter(Boolean).join(' ') : '')
  // Only while the mouse is over the card: at rest it's the words and the glow.
  const showIcon = !note && !learned && hover
  const showEsc = !note && !learned && hover && dictation.phase === 'listening'
  const [twoLines, setTwoLines] = useState(false)
  // A word learned: shown when nothing else is up, one at a time.
  // Read-along on the card: only while nothing else is up (in the circle it takes the face's place).
  const reading = readWord !== null && !round && dictation.phase === 'idle' && !note && !learned
  const readFlashing = useRef(false)
  useEffect(() => {
    if (reading && !readFlashing.current) {
      readFlashing.current = true
      // Shown first, then sized: showing it starts it at the card's smallest,
      // and the width asked for before that was lost (words cut off, Liam 10-25).
      void tauriBridge.dictateFlash(true).then(() => {
        sizeRef.current = `${READ_W}x${CARD_ONE_LINE_H}r${CARD_RADIUS}`
        void tauriBridge.dictatePanelSize(READ_W, CARD_ONE_LINE_H, CARD_RADIUS)
      })
    } else if (!reading && readFlashing.current) {
      readFlashing.current = false
      void tauriBridge.dictateFlash(false)
    }
  }, [reading])
  const busy = dictation.phase !== 'idle' || circle !== null || note !== null || reading
  useEffect(() => {
    if (busy || learned || !learnedQueue.current.length) return
    const next = learnedQueue.current.shift()!
    setLearned(next)
    void tauriBridge.dictateFlash(true)
    learnedTimer.current = setTimeout(() => {
      setLearned(null)
      void tauriBridge.dictateFlash(false)
      setLearnedTick((n) => n + 1) // the next, if more were learned
    }, LEARNED_MS)
  }, [busy, learned, learnedTick])
  useEffect(() => () => {
    if (learnedTimer.current) clearTimeout(learnedTimer.current)
  }, [])
  useLayoutEffect(() => {
    if (dictation.phase === 'idle' && !note && !circle && !learned && !reading) {
      sizeRef.current = '' // the desktop shows the next one small again
      setTwoLines(false)
      return
    }
    // Unseen till the press is known: nothing to size (a card's size asked for
    // then would reach the window after the circle's).
    if (!revealed && !circle && !note && !learned && !reading) return
    const size = round
      ? { width: CIRCLE, height: CIRCLE, radius: CIRCLE / 2 }
      : reading
        ? { width: READ_W, height: CARD_ONE_LINE_H, radius: CARD_RADIUS }
        : {
          ...cardSize(measureRef.current?.scrollWidth ?? 0, {
            icon: showIcon,
            esc: showEsc,
          }),
          radius: CARD_RADIUS,
        }
    setTwoLines(!round && size.height === CARD_TWO_LINES_H)
    const key = `${size.width}x${size.height}r${size.radius}`
    if (key === sizeRef.current) return
    sizeRef.current = key
    void tauriBridge.dictatePanelSize(size.width, size.height, size.radius)
  }, [shownText, showIcon, showEsc, note, dictation.phase, circle, round, revealed, learned, reading])

  // The voice glow (the one voice mode lights the chat box with): on the mic
  // while listening, the travelling beam while the words are finished or the
  // agent thinks, and a swell while its reply is read aloud.
  const micLevel = useCallback(() => Math.min(1, dictationRef.current.level() * CAPTURE_LEVEL_GAIN), [])
  // No level from the reply's audio yet: a swell with a voice's uneven rhythm.
  const speakingLevel = useCallback(() => {
    const t = Date.now()
    return 0.55 + 0.3 * Math.sin(t / 170) * Math.sin(t / 530 + 1) + 0.15 * Math.sin(t / 83)
  }, [])

  if (!revealed && !circle && !note && !learned && !reading) return null
  if (!round && !note && !learned && !reading && !hasWords && !listening && dictation.phase !== 'stopping') return null

  return (
    <div className="h-full w-full">
      {/* The window is the shape: macOS's frosted glass sits behind this page
          (desktop dictate.rs build_panel), so this is only a light tint over
          it, its corners morphing with the glass's (card ↔ circle). */}
      <div
        data-testid={round ? 'dictate-circle' : 'dictate-pill'}
        data-state={round ? ringState : undefined}
        className={cn(
          BOT_GLASS_ENTER,
          'text-foreground relative flex h-full w-full ease-out',
          round ? 'items-center justify-center bg-white/25 dark:bg-black/10' : 'items-start gap-3 bg-white/25 px-4 py-3 dark:bg-black/10',
        )}
        style={{
          borderRadius: radius,
          transition: 'opacity 200ms ease-out',
        }}
      >
        {/* Interactive's liquid metal round the edge (its centre clear, the glass
            showing through), morphing with the shape. Clipped to the shape's
            own corners: its halo and top catch-light reach past a box's edge
            (on a page, a glow round a button), and in this window, a
            rectangle, they stuck out past the rounded glass at the corners. */}
        <div
          aria-hidden
          data-testid="dictate-metal"
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{
            borderRadius: radius,
            clipPath: `inset(0 round ${radius})`,
          }}
        >
          {/* One per shape: metal-fx keeps the radius it mounted with when its
              box resizes (2.0.11), so the card's ring morphed into a circle
              stayed a rounded square. A fresh ring for the circle is round. */}
          <div
            key={round ? 'circle' : 'card'}
            data-dictate-morph
            className="absolute"
            // At once, no fade: the card's ring goes as the circle's comes, and a
            // fade-in left the edge bare a moment (the border blinked).
            style={{ inset: RING_INSET }}
          >
            {/* A fixed radius for its shape: metal-fx fits it to its own
                measured size at each resize (min of it and half the shorter
                side) but can't follow a radius that changes each frame. */}
            <MetalRing radius={round ? ROUND : CARD_RADIUS - RING_INSET} ring={RING_WIDTH} strength={RING_STRENGTH} />
          </div>
        </div>
        <style>{MORPH_KEYFRAMES}</style>
        {round ? (
          // The glow and the hint bloom in as the window opens into the circle.
          <div
            data-dictate-morph
            className="absolute inset-0 flex items-center justify-center"
            style={{ animation: `dictate-bloom ${MORPH_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both` }}
          >
            <TalkRing state={ringState} level={ringState === 'speaking' ? speakingLevel : micLevel} />
            {/* The agent's own face, as in the app, so you know who you're
                talking to: hopping while it works, and looking at the mouse
                wherever it is on the screen. */}
            <AgentBot
              state={ringState === 'thinking' ? 'working' : 'default'}
              active
              watched
              size={FACE}
              pointer={followPointer}
              className="relative"
            />
            {/* Only on hover: how to make it go. */}
            <span
              data-testid="dictate-esc-hint"
              className={cn(
                'absolute bottom-2.5 left-1/2 -translate-x-1/2 text-[10px] font-medium tracking-wide transition-opacity duration-200 ease-out',
                BOT_GLASS_MUTED,
                hover ? 'opacity-100' : 'opacity-0',
              )}
            >
              esc
            </span>
          </div>
        ) : (
          <>
            <ComposerVoiceGlow
              active={dictation.phase === 'listening' || dictation.phase === 'stopping'}
              level={micLevel}
              processing={dictation.phase === 'stopping'}
              radiusClassName="rounded-[18px]"
            />
            {showEsc && <span className={cn('relative mt-0.5 shrink-0 text-[11px]', BOT_GLASS_MUTED)}>esc</span>}
            {/* The words on one line, out of sight: their width sizes the card. */}
            <span ref={measureRef} aria-hidden className="pointer-events-none invisible fixed top-0 left-0 text-[13px] leading-5 whitespace-nowrap">
              {shownText}
            </span>
            <div
              ref={linesRef}
              data-testid="dictate-lines"
              data-dictate-morph
              style={{ animation: `dictate-unfold ${MORPH_MS / 3}ms ease-out both` }}
              className={cn(
                'relative max-h-10 min-w-0 flex-1 overflow-hidden text-[13px] leading-5',
                // One line until the words need two: no wrapping (and no jump) while the card animates wider.
                twoLines ? 'break-words' : 'whitespace-nowrap',
              )}
            >
              {note ? (
                <span>{note}</span>
              ) : reading && readWord ? (
                <ReadAlongWord
                  key={readWord.index}
                  word={readWord.word}
                  className="leading-5"
                  style={{ fontSize: fitSize(readWord.word, READ_W - 34, 17), animation: `dictate-flip ${READ_FLIP_MS}ms ease-out both` }}
                />
              ) : learned ? (
                // As measured (learnedText): the same characters, so the card fits it.
                <span data-testid="dictate-learned">
                  <span className={BOT_GLASS_MUTED}>Learned</span>
                  {'  '}
                  <span className={BOT_GLASS_MUTED}>{learned.heard}</span>
                  {'  →  '}
                  <span>{learned.typed}</span>
                </span>
              ) : hasWords ? (
                <>
                  {shownFinal && <span>{shownFinal}</span>}
                  {shownFinal && shownInterim && ' '}
                  {shownInterim && <span className={BOT_GLASS_MUTED}>{shownInterim}</span>}
                </>
              ) : null}
            </div>
            {/* Live mode's audio icon. */}
            {showIcon && !reading && <AudioLines aria-hidden className={cn('relative mt-0.5 h-4 w-4 shrink-0', BOT_GLASS_MUTED)} />}
          </>
        )}
      </div>
    </div>
  )
}
