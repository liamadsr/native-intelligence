'use client'

/**
 * The landing page's picture of the agent reaching a person away from the
 * app: a text thread on their phone, played out as it would arrive. The
 * agent types, its message lands, the person answers yes, the agent types
 * again and says it is done; later it sends a heads-up. Then the thread
 * rests, clears and plays again.
 *
 * Made up (the page's usual cast), but every beat is how the product works
 * today: the agent texts the person's verified phone when they are away
 * (lib/reach), asks for a plain yes or no before anything leaves the
 * workspace (lib/sms/approvals.ts), does it once they answer, and holds
 * routine messages through quiet hours.
 *
 * DRAWN AS THE PHONE'S OWN MESSAGES APP, because that is where it happens:
 * a contact at the top, grey bubbles for what the agent sends, and a green
 * one for the reply. Green, not blue, on purpose: the agent reaches a person
 * by ordinary text message (SMS), and that is the colour a phone gives a
 * text you send that way.
 *
 * AROUND THE PHONE, WHAT THE TEXT IS ABOUT. A text on its own is small, so
 * the scene shows both ends of it: on the left what came into the workspace
 * and set the agent off, on the right what the workspace did once the person
 * said yes. Each is a pane of clear glass with the workspace's own icon for
 * that area, and arrives on the same beat as the message it belongs to. From
 * `md` up; a phone screen shows the phone alone.
 *
 * It only plays while it is on screen (one timer per beat, none otherwise).
 * The server, and a visitor who asked for reduced motion, get the whole
 * thread, still. Decorative, so it is hidden from assistive technology.
 */
import {
  Building2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  FileText,
  Mail,
  Mic,
  Plus,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { IN_CSS } from './motion'
import { useInView, useReducedMotion } from './use-in-view'

interface Message {
  from: 'agent' | 'you'
  text: string
  /** Shown above the message, centred, when it starts a new moment. */
  time?: string
}

const THREAD: readonly Message[] = [
  {
    from: 'agent',
    time: '15:50',
    text: 'Lena asked to move Thursday’s call. Offer her Friday at 10:00? Reply yes or no.',
  },
  { from: 'you', text: 'Yes' },
  {
    from: 'agent',
    text: 'Done. The invite is with Lena, and the Northwind deal has the new date.',
  },
  {
    from: 'agent',
    time: '16:40',
    text: 'Your 17:00 with Marcus starts in 20 minutes. I put the prep in the app.',
  },
]

/** What stands beside the phone: which side, how far down, and the message count it arrives with. */
const BESIDE: readonly {
  side: 'left' | 'right'
  top: string
  after: number
  icon: LucideIcon
  title: string
  detail: string
}[] = [
  {
    side: 'left',
    top: '24%',
    after: 0,
    icon: Mail,
    title: 'Lena’s email',
    detail: 'Asked to move Thursday',
  },
  {
    side: 'left',
    top: '46%',
    after: 0,
    icon: Calendar,
    title: 'Your calendar',
    detail: 'Friday 10:00 is free',
  },
  {
    side: 'right',
    top: '50%',
    after: 3,
    icon: Calendar,
    title: 'Invite sent',
    detail: 'Lena · Friday 10:00',
  },
  {
    side: 'right',
    top: '66%',
    after: 3,
    icon: Building2,
    title: 'Northwind deal',
    detail: 'Next call moved to Friday',
  },
  {
    side: 'right',
    top: '82%',
    after: 4,
    icon: FileText,
    title: 'Prep for Marcus',
    detail: 'Ready before your 17:00',
  },
]

// The scene, as (message index, is the agent still typing it) frames with how
// long each holds, in milliseconds. A typing frame shows the three dots where
// the message is about to land.
const FRAMES: readonly { shown: number; typing: boolean; hold: number }[] = [
  { shown: 0, typing: true, hold: 1500 },
  { shown: 1, typing: false, hold: 1900 },
  { shown: 2, typing: false, hold: 900 },
  { shown: 2, typing: true, hold: 1100 },
  { shown: 3, typing: false, hold: 2000 },
  { shown: 3, typing: true, hold: 1100 },
  { shown: 4, typing: false, hold: 4200 },
]

// The phone's own colours, light and dark: this is a picture of the Messages
// app on someone's phone, not a part of the page, so it keeps that app's
// look (grey for what arrives, green for a text you send) in both themes.
const CSS = `
.ni-imsg { --ni-imsg-bg: #ffffff; --ni-imsg-in: #e9e9eb; --ni-imsg-out: #34c759; }
.dark .ni-imsg { --ni-imsg-bg: #000000; --ni-imsg-in: #262629; --ni-imsg-out: #30d158; }
.ni-imsg-bubble { position: relative; }
/* The tail: a rounded tab in the bubble's colour, with a second one in the
   background's colour over it to carve the curve. */
.ni-imsg-bubble::before, .ni-imsg-bubble::after { content: ''; position: absolute; bottom: 0; height: 1.05rem; }
.ni-imsg-in::before { left: -0.42rem; width: 1.2rem; background: var(--ni-imsg-in); border-bottom-right-radius: 1rem 0.85rem; }
.ni-imsg-in::after { left: -1.56rem; width: 1.56rem; background: var(--ni-imsg-bg); border-bottom-right-radius: 0.62rem; }
.ni-imsg-out::before { right: -0.42rem; width: 1.2rem; background: var(--ni-imsg-out); border-bottom-left-radius: 1rem 0.85rem; }
.ni-imsg-out::after { right: -1.56rem; width: 1.56rem; background: var(--ni-imsg-bg); border-bottom-left-radius: 0.62rem; }
@media (prefers-reduced-motion: no-preference) {
  .ni-thread-in { animation: ni-thread-in 0.32s ${IN_CSS} both; }
  .ni-thread-dot { animation: ni-thread-dot 1.1s ease-in-out infinite; }
}
@keyframes ni-thread-in {
  from { opacity: 0; transform: translateY(0.5em) scale(0.97); }
  to { opacity: 1; transform: none; }
}
@keyframes ni-thread-dot {
  0%, 60%, 100% { opacity: 0.35; }
  30% { opacity: 1; }
}
`

const BUBBLE =
  'ni-imsg-bubble max-w-[78%] rounded-[1.15rem] px-3.5 py-[0.45rem] text-left text-[15px]/[1.3rem]'
const AGENT_BUBBLE = `${BUBBLE} ni-imsg-in bg-[var(--ni-imsg-in)] text-black dark:text-white`
const YOUR_BUBBLE = `${BUBBLE} ni-imsg-out bg-[var(--ni-imsg-out)] text-white`

export function AgentTextThread() {
  const [ref, inView] = useInView<HTMLDivElement>()
  const reduced = useReducedMotion()
  // null: nothing is playing, so the whole thread shows (the server's markup,
  // reduced motion, and before the scene first comes into view).
  const [frame, setFrame] = useState<number | null>(null)

  useEffect(() => {
    if (!inView || reduced) {
      setFrame(null)
      return
    }
    let at = 0
    let timer: ReturnType<typeof setTimeout>
    const step = () => {
      setFrame(at)
      timer = setTimeout(() => {
        at = (at + 1) % FRAMES.length
        step()
      }, FRAMES[at].hold)
    }
    step()
    return () => clearTimeout(timer)
  }, [inView, reduced])

  const now =
    frame === null ? { shown: THREAD.length, typing: false } : FRAMES[frame]

  return (
    <div ref={ref} aria-hidden className="relative mx-auto w-full max-w-3xl">
      {/* Beside the phone: what set the agent off, and what the yes set going. */}
      {BESIDE.map((item) => {
        const Icon = item.icon
        const here = now.shown >= item.after
        return (
          <div
            key={item.title}
            className={`border-foreground/10 bg-background/70 absolute z-10 hidden w-[14rem] items-center gap-3 rounded-2xl border px-3.5 py-3 text-left shadow-xl backdrop-blur-md transition-[opacity,translate] duration-500 md:flex ${
              item.side === 'left'
                ? 'right-[calc(50%+9.75rem)]'
                : 'left-[calc(50%+9.75rem)]'
            } ${here ? 'opacity-100' : `opacity-0 ${item.side === 'left' ? 'translate-x-4' : '-translate-x-4'}`}`}
            style={{ top: item.top, transitionTimingFunction: IN_CSS }}
          >
            <span className="border-foreground/15 bg-background flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border">
              <Icon className="text-foreground h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="text-foreground block truncate text-sm font-medium">
                {item.title}
              </span>
              <span className="text-muted-foreground block truncate text-xs">
                {item.detail}
              </span>
            </span>
          </div>
        )
      })}

      {/* The phone: a metal band round a dark bezel round the screen, with its buttons on the sides. */}
      <div className="ni-imsg relative mx-auto w-full max-w-[20.5rem] rounded-[3.4rem] bg-gradient-to-b from-neutral-500 via-neutral-700 to-neutral-600 p-[3px] shadow-2xl shadow-black/40">
        <span className="absolute top-[7.5rem] -left-[3px] h-8 w-[3px] rounded-l-sm bg-neutral-600" />
        <span className="absolute top-[10.5rem] -left-[3px] h-14 w-[3px] rounded-l-sm bg-neutral-600" />
        <span className="absolute top-[14.5rem] -left-[3px] h-14 w-[3px] rounded-l-sm bg-neutral-600" />
        <span className="absolute top-[12rem] -right-[3px] h-20 w-[3px] rounded-r-sm bg-neutral-600" />
        <div className="rounded-[3.25rem] bg-black p-[0.6rem]">
          <style>{CSS}</style>
          <div className="relative overflow-hidden rounded-[2.7rem] bg-[var(--ni-imsg-bg)] text-black dark:text-white">
            {/* The island. */}
            <span className="absolute top-2.5 left-1/2 h-[1.65rem] w-[5.6rem] -translate-x-1/2 rounded-full bg-black" />
            {/* Status bar. */}
            <div className="flex items-center justify-between px-7 pt-3.5 pb-2 text-[14px] font-semibold">
              <span>15:50</span>
              <span className="flex items-center gap-1.5">
                <span className="flex items-end gap-[2px]">
                  {[4, 6, 8, 10].map((h) => (
                    <span
                      key={h}
                      className="w-[3px] rounded-[1px] bg-current"
                      style={{ height: h }}
                    />
                  ))}
                </span>
                <span className="relative h-[11px] w-[22px] rounded-[3.5px] border border-current/50 p-[1.5px]">
                  <span className="block h-full w-[70%] rounded-[1.5px] bg-current" />
                </span>
              </span>
            </div>

            {/* Who it is: a back arrow, and the contact in the middle. */}
            <div className="relative border-b border-black/10 pt-1 pb-2 dark:border-white/10">
              <ChevronLeft
                className="absolute top-3 left-2 h-7 w-7 text-[#007aff] dark:text-[#0a84ff]"
                strokeWidth={2.2}
              />
              <div className="flex flex-col items-center">
                <img
                  src="/brand/ni-app-icon.png"
                  alt=""
                  className="h-11 w-11 rounded-full"
                />
                <p className="mt-1 flex items-center text-[11px] text-black/80 dark:text-white/85">
                  Your agent
                  <ChevronRight className="h-3 w-3 opacity-40" />
                </p>
              </div>
            </div>

            {/* A fixed height, so the page never moves as the thread fills. */}
            <ul className="flex h-[30rem] flex-col justify-end gap-1.5 overflow-hidden px-4 pt-3 pb-2">
              {THREAD.slice(0, now.shown).map((message) => (
                <li
                  key={message.text}
                  className={`ni-thread-in flex flex-col ${message.from === 'you' ? 'items-end' : 'items-start'}`}
                >
                  {message.time && (
                    <span className="mt-1 mb-1.5 w-full text-center text-[11px] text-black/45 dark:text-white/45">
                      <span className="font-semibold">Text Message</span> ·
                      Today {message.time}
                    </span>
                  )}
                  <span
                    className={
                      message.from === 'you' ? YOUR_BUBBLE : AGENT_BUBBLE
                    }
                  >
                    {message.text}
                  </span>
                  {message.from === 'you' && (
                    <span className="mt-0.5 pr-1 text-[10px] font-medium text-black/40 dark:text-white/40">
                      Delivered
                    </span>
                  )}
                </li>
              ))}
              {now.typing && (
                <li
                  key={`typing-${now.shown}`}
                  className="ni-thread-in flex flex-col items-start"
                >
                  <span
                    className={`${AGENT_BUBBLE} flex !h-[2.2rem] w-[4.1rem] items-center justify-center gap-[0.3rem] !rounded-full !p-0`}
                  >
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className="ni-thread-dot block h-[0.55rem] w-[0.55rem] rounded-full bg-black/45 dark:bg-white/55"
                        style={{ animationDelay: `${dot * 0.18}s` }}
                      />
                    ))}
                  </span>
                </li>
              )}
            </ul>

            {/* The box you would type in. */}
            <div className="flex items-center gap-2 px-3 pt-1 pb-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-black/50 dark:bg-white/10 dark:text-white/60">
                <Plus className="h-4 w-4" strokeWidth={2.4} />
              </span>
              <span className="flex h-8 flex-1 items-center justify-between rounded-full border border-black/15 px-3.5 text-[15px] text-black/35 dark:border-white/20 dark:text-white/35">
                Text Message
                <Mic className="h-4 w-4" />
              </span>
            </div>
            {/* The home bar. */}
            <span className="mx-auto mt-1 mb-2 block h-[5px] w-28 rounded-full bg-black/80 dark:bg-white/85" />
          </div>
        </div>
      </div>
    </div>
  )
}
