'use client'

/**
 * The Interactive toggle (@/lib/read-aloud/listen-mode, which keeps its listen
 * mode name inside): a labelled button, once for the whole app, in the top bar
 * beside the workspace pill (app/account/(dashboard)/top-bar/top-bar.tsx). Liam,
 * 2026-09-27: "it should live in the top header of the page next to the
 * workspace picker, that way we only show it once". On, each email or
 * document the user opens reads itself aloud, and each capture, contact,
 * company, calendar event, project or action gets a spoken brief
 * (./listen-brief); and, on a desktop that can, the mic listens for the
 * user's assistant by name, so they can talk back (./interactive-voice-host).
 * It was "Listen mode" until Liam made it interactive (2026-10-02: one toggle,
 * "Interactive": on reads as before AND listens for the name). Off, what the
 * section player reads is paused. The window Interactive reads pulses
 * (./listen-frame) on and off alike, marking the pages that support it, so
 * the toggle is what says whether it is on.
 *
 * Its icon says what a click does: Play while off, Pause while on (Liam,
 * 2026-09-27: "that way you know you can play and pause"). It sits in a
 * liquid-metal pill (./listen-metal) on and off alike ("it should keep its
 * metal ring even when it's on"), which never unmounts as it toggles. The
 * metal is fetched the first time a toggle shows; while it loads, and
 * wherever it can't draw (no WebGL2, the chunk failed), the button is plain.
 * On, the button's border turns colourful (Liam, 2026-09-29: "when you turn
 * on listen mode let's make the border of the button colorful or something to
 * indicate listen mode is on"): a thin rainbow ring on the button's own edge
 * over a soft glow of the same colours (LISTEN_ON_RING), drawn in CSS so it
 * shows with or without the metal, and fading in and out as it toggles.
 *
 * No item has a Listen or Pause button of its own (./listen-target: each
 * reads while Interactive is on, headless): this toggle is the one control.
 * Beside it, only while it is on and the window the user works in offers what
 * comes next (./listen-frame, useListenNextHere: Mail's next thread), a small
 * round Next button moves on to it (Liam, 2026-10-02: "it would be cool if you
 * can skip to the next thread. And maybe that would be like a control that
 * shows up conditionally on the listen mode toggle at the top"); the next item
 * then reads itself, as anything opened in Interactive does. And, while it is
 * on and the desktop runs Interactive's voice (voice_status `interactive`, a
 * capability, with voice available and its modules ready: `conversation`), a
 * round mic button (InteractiveMicButton): Mic, or MicOff
 * while muted, a click mutes or unmutes (the session stays, so it drops back
 * to reading only), and it shows where the conversation is
 * (@/lib/voice/interactive-store): listening (quiet), heard you (the name),
 * thinking, answering, the follow-up window. Without that desktop support
 * there is no mic button, and Interactive only reads. Both sit just before the
 * toggle, outside the metal pill (which stays the toggle's alone), so the
 * toggle doesn't move as they appear.
 *
 * Rendered only where read-aloud can play (the section player's `supported`:
 * the desktop app, local-tts Ready, no capture or dictation), so a browser
 * never shows it; and only while the window the user works in has something
 * to read, an item open in it that reads or is briefed (./listen-frame,
 * useListenReadableHere), or while Interactive is on, so it can always be
 * turned off. Its own component so that only it re-renders as those change,
 * not the whole top bar.
 */

import { Mic, MicOff, Pause, Play, SkipForward } from 'lucide-react'
import { Suspense, lazy, type CSSProperties } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isDesktopApp } from '@/lib/platform'
import { setListenMode, useListenMode } from '@/lib/read-aloud/listen-mode'
import { useSectionPlayerSupported } from '@/lib/read-aloud/section-player'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { toggleInteractiveMute, useInteractiveVoice, type InteractivePhase } from '@/lib/voice/interactive-store'
import { useVoiceStatus } from '@/lib/voice/status-store'
import { useListenNextHere, useListenReadableHere } from './listen-frame'

/**
 * The colourful border listen mode being on puts on the button: a conic
 * rainbow, hue by hue around the pill, as a ring LISTEN_ON_RING.width wide
 * on the button's edge (the gradient masked to its rim) and, under it, the
 * same gradient blurred just outside the pill, so the button reads as lit.
 * Both fade in over LISTEN_ON_RING.fadeMs (transition-opacity duration-300),
 * and stay mounted at opacity 0 while off, so the button's box never changes.
 */
export const LISTEN_ON_RING = {
  // pink, violet, blue, green, amber, and round to pink (Tailwind's 400s).
  gradient:
    'conic-gradient(from 0deg, rgb(244, 114, 182), rgb(167, 139, 250), rgb(96, 165, 250), rgb(52, 211, 153), rgb(251, 191, 36), rgb(244, 114, 182))',
  width: '1.5px',
  fadeMs: 300,
} as const

/** The gradient painted on the rim only: the content box cut out of the
 *  padding box (mask-composite exclude; WebKit's spelling for the desktop
 *  app's WebView). */
const RING_STYLE: CSSProperties = {
  background: LISTEN_ON_RING.gradient,
  padding: LISTEN_ON_RING.width,
  WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
  WebkitMaskComposite: 'xor',
  mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
  maskComposite: 'exclude',
}
const GLOW_STYLE: CSSProperties = { background: LISTEN_ON_RING.gradient }

/** Stands in when the metal's chunk doesn't come (offline, a deploy in
 *  between): the plain button, until a reload. */
const NoMetal = () => null

const ListenMetal = lazy(() => import('./listen-metal').catch(() => ({ default: NoMetal })))

export function ListenModeToggle({ className }: { className?: string }) {
  const supported = useSectionPlayerSupported()
  const on = useListenMode()
  const readableHere = useListenReadableHere()
  const next = useListenNextHere()
  const voice = useVoiceStatus()
  // The desktop runs Interactive's voice (`interactive`, a capability) and its
  // pieces are ready (`conversation`: local-stt, local-tts): the mic button
  // shows while it is on. Otherwise Interactive only reads.
  const canTalk = isDesktopApp() && voice.available && voice.interactive === true && voice.conversation
  if (!supported || (!on && !readableHere)) return null

  return (
    // The toggle's own box holds the metal, over its box and under the button,
    // so the pill is the toggle's alone. The button stays the same element as
    // listen mode turns on and off, and as the Next button comes and goes
    // before it, so it keeps focus.
    <span className={cn('relative inline-flex shrink-0 items-center gap-1.5', className)}>
      {/* Before the toggle, not after: the top bar's cluster is right-aligned,
          so the toggle the user just pressed stays under the pointer as Next
          comes and goes. */}
      {on && next && <ListenNextButton label={next.label} go={next.go} />}
      {on && canTalk && <InteractiveMicButton />}
      <span className="relative inline-flex shrink-0">
        {/* Nothing while its chunk loads: the plain button shows meanwhile. */}
        <Suspense fallback={null}>
          <ListenMetal />
        </Suspense>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setListenMode(!on)}
                aria-label="Interactive"
                aria-pressed={on}
                data-listen-mode={on ? 'on' : 'off'}
                // No fill of its own, on or off: the metal's surface is its face.
                className="relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-foreground transition-colors hover:text-foreground/80"
              >
                {/* On: the colourful border (LISTEN_ON_RING), under the label.
                    Its glow lies just outside the pill, the ring on its rim;
                    neither takes a click. */}
                <span
                  aria-hidden
                  data-listen-ring={on ? 'on' : 'off'}
                  className={cn(
                    'pointer-events-none absolute inset-0 rounded-full transition-opacity duration-300',
                    on ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  <span className="absolute -inset-0.5 rounded-full opacity-60 blur-[3px]" style={GLOW_STYLE} />
                  <span className="absolute inset-0 rounded-full" style={RING_STYLE} />
                </span>
                {on ? <Pause className="relative h-3.5 w-3.5 fill-current" /> : <Play className="relative h-3.5 w-3.5 fill-current" />}
                <span className="relative">Interactive</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {on
                ? `Interactive: what you open is read or briefed aloud${canTalk ? ', and you can talk back by name' : ''}. Click to pause.`
                : `Interactive: hear about each meeting, person, task or email as you open it${canTalk ? ', and talk back by name' : ''}`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    </span>
  )
}

/** Moves on to what the window in front offers next (Mail's next thread),
 *  which then reads itself. One of the bar's round pills (BAR_PILL). */
function ListenNextButton({ label, go }: { label: string; go: () => void }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            // The top bar is the window's drag strip: a press here is a click.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => go()}
            aria-label={label}
            data-listen-next=""
            className={BAR_PILL}
          >
            <SkipForward className="h-3.5 w-3.5 fill-current" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** What the mic button says, by phase (its tooltip; the live region says the
 *  phase's short form). */
export const INTERACTIVE_PHASE_LABEL: Record<InteractivePhase, string> = {
  off: 'Starting the microphone…',
  listening: 'Listening for your assistant’s name',
  heard: 'Heard you',
  thinking: 'Thinking…',
  answering: 'Answering',
  'follow-up': 'Go ahead, no name needed',
}

/**
 * The top bar's round pill, so these buttons sit with their neighbours (Liam,
 * 2026-10-02: "the same height as the workspace switcher… match the other
 * ones around them"): the History · Create pill's surface (white / black, a
 * hairline border, a soft shadow) at the bar's 36px, the workspace pill's
 * height and the Interactive toggle's.
 */
const BAR_PILL =
  'relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-white text-sidebar-foreground/70 shadow-sm transition-colors hover:bg-muted hover:text-sidebar-foreground dark:bg-black dark:shadow-none'

/** Per phase: how the mic's pill shows it, on its own border and fill. Quiet
 *  (the plain pill) while listening. */
const PHASE_STYLE: Record<InteractivePhase, string> = {
  off: 'text-sidebar-foreground/40',
  listening: '',
  heard: 'border-emerald-500/70 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 hover:text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400 dark:hover:bg-emerald-900',
  thinking: 'text-sidebar-foreground animate-pulse motion-reduce:animate-none',
  answering: 'border-sky-500/70 bg-sky-50 text-sky-600 hover:bg-sky-100 hover:text-sky-700 dark:bg-sky-950 dark:text-sky-400 dark:hover:bg-sky-900',
  'follow-up': 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
}

/**
 * Interactive's mic (see the header): mutes and unmutes, and shows where the
 * conversation is. One of the bar's round pills (BAR_PILL). Muted, it says so
 * whatever the phase: nothing is heard.
 */
function InteractiveMicButton() {
  const { phase, muted } = useInteractiveVoice()
  const { name } = useAssistantName()
  const label = muted ? 'Unmute microphone' : 'Mute microphone'
  const status = muted
    ? 'Muted: Interactive only reads'
    : phase === 'listening'
      ? `Listening for “${name}”`
      : INTERACTIVE_PHASE_LABEL[phase]
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            // The top bar is the window's drag strip: a press here is a click.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => toggleInteractiveMute()}
            aria-label={label}
            aria-pressed={muted}
            data-interactive-mic=""
            data-interactive-phase={muted ? 'muted' : phase}
            className={cn(BAR_PILL, muted ? 'text-sidebar-foreground/50' : PHASE_STYLE[phase])}
          >
            {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            <span className="sr-only" aria-live="polite">
              {status}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {muted ? `${status}. Click to unmute.` : `${status}. Click to mute.`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
