'use client'

/**
 * The agent's day: all twenty-four hours of it, on one dial.
 *
 * The page's background is the live sky (components/sky/marketing-sky.tsx),
 * so the picture is the sky's own clock. The dial is a whole day: noon at the
 * top, midnight at the bottom, and a hairline out to either side for the horizon,
 * sunrise on the left and sunset on the right, lit as the sun comes and goes. A marker goes all the way
 * round it, the sun above the horizon and a crescent moon below, stopping at each
 * thing the day brings: an email, a call, a thread, a doc, and then, after
 * everyone has gone home, the things the agent does on its own. At each stop
 * the same short scene plays: the event lights up, a line runs from it to the
 * middle, and a card opens there with what the workspace did about it, one
 * line at a time. The point of the full circle is the lower half: the agent
 * does not stop at sunset.
 *
 * STAGED LIKE AN EXPLAINER, NOT LEFT RUNNING LIKE A SCREENSAVER. One thing
 * happens at a time. The marker eases out of one stop and into the next, then
 * holds while the scene plays; nothing moves at a constant speed, and nothing
 * moves while something else is being read. Each stop is a small story: the
 * event dips as the marker arrives (anticipation), lights and settles (the
 * action), then the line, the card and its lines follow in turn (the
 * resolution), and the scene rests before the marker moves on. There is
 * always a main action, something supporting it (the ring going out, the
 * line drawing) and something quietly alive behind (the marker's slow pulse).
 *
 * DRAWN LIKE AN INSTRUMENT, NOT LIT LIKE A POSTER. Hairlines, hour ticks,
 * small type, solid shapes, the page's own ink (the theme's foreground). No
 * glow, no blur, no glass, no colour of its own.
 *
 * EVERY EVENT HAPPENS INSIDE THE WORKSPACE, and wears the workspace's own
 * icon for that area: its mail, its meetings, its chat, its calendar, its
 * docs, its CRM. No other product's logo appears, because the page's claim is
 * that this is the one app, not a layer over others. Each outcome is
 * something the product does today; the people and companies are made up,
 * the page's usual cast.
 *
 * HOW IT MOVES. Everything is one CSS loop of LOOP seconds, built from one
 * timeline (TIMELINE below): the keyframes for the marker, the arc behind it
 * and each event are generated from it, so they cannot disagree. The only
 * script is a timer, five times a second, that reads the marker's own
 * animation clock to write the time and pick the card: it never drives the
 * motion, so the two cannot drift apart. No scroll listeners. A visitor who
 * asked for reduced motion gets the finished day, still: every event and
 * outcome shown, the marker in mid afternoon, no clock and no card.
 * Decorative, so it is hidden from assistive technology.
 */
import { useEffect, useRef, useState } from 'react'
import { AudioLines, Building2, Calendar, FileText, GitPullRequest, Inbox, Mail, MessageSquareText, MessagesSquare, MoonStar, Sunrise, Sunset } from 'lucide-react'

// The drawing's own units (the SVG's viewBox); everything else is a share of them.
const W = 880
const H = 700
const CX = 440
const CY = 350
const R = 258

/** How far past the drawing's edge the horizon runs on each side. */
const HORIZON_REACH = 60

/** The day starts and ends on the left of the horizon, at sunrise. */
const SUNRISE = 6
const SUNSET = 18

/** Seconds for one day, start to start. */
const LOOP = 40

// The loop, in percent. The scene sets itself (INTRO), the marker makes one
// eased MOVE to each event and HOLDs there while that event's scene plays,
// makes one more move home to sunrise, and the rest of the loop (from OUT)
// clears the stage.
const INTRO = 3.5
const MOVE = 2.3
const HOLD = 5.4
const OUT = 94

/**
 * Where an hour falls on a circle of radius `r`: noon at the top, midnight at
 * the bottom, going round clockwise. Hours past 24 are the next morning.
 */
function at(hour: number, r: number = R): { x: number; y: number } {
  const angle = ((hour - 12) * 15 * Math.PI) / 180
  return { x: CX + r * Math.sin(angle), y: CY - r * Math.cos(angle) }
}

/** A point as CSS `left` / `top`, rounded so the server's and the browser's markup agree. */
function place(point: { x: number; y: number }): React.CSSProperties {
  return { left: `${((point.x / W) * 100).toFixed(3)}%`, top: `${((point.y / H) * 100).toFixed(3)}%` }
}

const ICON = 'h-4 w-4 text-foreground'

interface DayEvent {
  /** Hours since midnight on the day the dial starts; past 24 for the small hours of the next morning. */
  hour: number
  time: string
  label: string
  did: string
  /** The result itself, as the card in the middle shows it: one to three short lines. */
  result: readonly string[]
  icon: React.ReactNode
}

// The day, then the night. What happened, what the workspace did about it,
// and the result.
const EVENTS: readonly DayEvent[] = [
  {
    hour: 7 + 50 / 60,
    time: '07:50',
    label: 'Lena’s email',
    did: 'Reply drafted',
    result: ['“Hi Lena, March 18 works for us. We’ll send the revised invoice before Friday.”'],
    icon: <Mail className={ICON} />,
  },
  {
    hour: 9.5,
    time: '09:30',
    label: 'Weekly planning',
    did: 'Notes and tasks written',
    result: ['Confirm the March 4 shipment', 'Move the launch to March 20', 'Update the dates in Onboarding v3'],
    icon: <AudioLines className={ICON} />,
  },
  {
    hour: 11 + 10 / 60,
    time: '11:10',
    label: '#product thread',
    did: 'Task created',
    result: ['Write the help article for the new onboarding', 'Sarah · due Tuesday'],
    icon: <MessagesSquare className={ICON} />,
  },
  {
    hour: 13,
    time: '13:00',
    label: 'Northwind call',
    did: 'Prep ready',
    result: ['Delivery moved to March 18', 'Lena is waiting on the revised invoice'],
    icon: <Calendar className={ICON} />,
  },
  {
    hour: 14 + 40 / 60,
    time: '14:40',
    label: 'Onboarding v3',
    did: 'Doc brought up to date',
    result: ['Launch date: March 10 → March 20', 'From this morning’s planning call'],
    icon: <FileText className={ICON} />,
  },
  {
    hour: 15 + 50 / 60,
    time: '15:50',
    label: 'It texted you',
    did: 'You replied yes',
    result: ['“Lena asked to move Thursday’s call. Offer Friday at 10:00?”', 'You: Yes · invite sent'],
    icon: <MessageSquareText className={ICON} />,
  },
  {
    // Clear of 18:00, where the sunset's own icon sits.
    hour: 16 + 55 / 60,
    time: '16:55',
    label: 'Northwind deal',
    did: 'Stage updated',
    result: ['Proposal → Negotiation', 'From Lena’s reply this afternoon'],
    icon: <Building2 className={ICON} />,
  },
  // After sunset. Routine things wait for the morning (the agent's quiet
  // hours are 21:00 to 08:00), and the work it was handed carries on.
  {
    hour: 21 + 30 / 60,
    time: '21:30',
    label: 'Late email',
    did: 'Held until morning',
    result: ['Routine, so it didn’t text you', 'It will be waiting when you start'],
    icon: <MoonStar className={ICON} />,
  },
  {
    hour: 23 + 40 / 60,
    time: '23:40',
    label: 'Tomorrow’s first call',
    did: 'Prep written',
    result: ['Who is coming, and what was promised', 'Ready before you sit down'],
    icon: <Calendar className={ICON} />,
  },
  {
    hour: 26 + 40 / 60,
    time: '02:40',
    label: 'Export fix',
    did: 'Pull request opened',
    result: ['The task Marcus handed over at six', 'Reviewed, and ready for him in the morning'],
    icon: <GitPullRequest className={ICON} />,
  },
  {
    // Clear of 06:00, where the sunrise's own icon sits.
    hour: 28 + 50 / 60,
    time: '04:50',
    label: 'Morning tidy',
    did: 'Inbox cleared',
    result: ['Receipts and newsletters archived', 'Every one can be undone'],
    icon: <Inbox className={ICON} />,
  },
]

/** The middle of the dial: where the card sits and the lines from the events end. */
const CENTRE = { x: CX, y: CY }

const HOURS = Array.from({ length: 24 }, (_, i) => i)
/** The hours written on the dial, just inside it. */
const NAMED_HOURS = [0, 3, 6, 9, 12, 15, 18, 21]

/** The angle of an hour from the top of the dial, in radians. */
const angleOf = (hour: number) => ((hour - 12) * 15 * Math.PI) / 180

/** Which way a label leans from its point, so it never crosses the dial: away from the middle. */
function labelLean(hour: number): string {
  return Math.sin(angleOf(hour)) < 0 ? '-translate-x-full -translate-y-1/2 text-right' : '-translate-y-1/2 text-left'
}

/** How far out a label stands. Near the top and bottom it sits above or below its icon, so it needs more room. */
function labelReach(hour: number): number {
  return R + (Math.abs(Math.sin(angleOf(hour))) < 0.45 ? 46 : 32)
}

/** When the marker leaves for, arrives at and leaves each event, in percent of the loop. */
const TIMELINE = EVENTS.map((event, i) => {
  const start = INTRO + i * (MOVE + HOLD)
  return { hour: event.hour, start, arrive: start + MOVE, leave: start + MOVE + HOLD }
})
const LAST_LEAVE = TIMELINE[TIMELINE.length - 1].leave
/** When the marker is home again, at the next sunrise. */
const HOME_AT = LAST_LEAVE + MOVE
const NEXT_SUNRISE = SUNRISE + 24

/** How a move eases: slow out of one stop, slow into the next (close to the CSS curve the marker uses). */
function ease(t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * The hour on the clock (0 to 24), `progress` (0 to 1) of the way through the
 * loop: it moves with the marker between stops and stands still at each one,
 * through the day and on through the night to the next sunrise.
 */
export function hourAt(progress: number): number {
  const p = Math.min(1, Math.max(0, progress)) * 100
  let hour = NEXT_SUNRISE
  if (p <= INTRO) hour = SUNRISE
  else if (p < HOME_AT) {
    let from = SUNRISE
    hour = from
    let placed = false
    for (const stop of TIMELINE) {
      if (p < stop.arrive) {
        hour = from + (stop.hour - from) * ease((p - stop.start) / MOVE)
        placed = true
        break
      }
      if (p <= stop.leave) {
        hour = stop.hour
        placed = true
        break
      }
      from = stop.hour
    }
    if (!placed) hour = from + (NEXT_SUNRISE - from) * ease((p - LAST_LEAVE) / MOVE)
  }
  return hour % 24
}

/** The event the marker last arrived at, at `progress`; -1 before the first and while the stage clears. */
export function latestEvent(progress: number): number {
  const p = Math.min(1, Math.max(0, progress)) * 100
  if (p >= OUT) return -1
  let latest = -1
  for (const [i, stop] of TIMELINE.entries()) if (stop.arrive <= p) latest = i
  return latest
}

/** How many of the day's stops come after sunset. Exported for the test. */
export const NIGHT_STOPS = EVENTS.filter((event) => event.hour > SUNSET).length
export const STOPS = EVENTS.length

const pct = (n: number) => `${n.toFixed(2)}%`
/** The marker's turn about the middle of the dial when it stands at `hour`. */
const turn = (hour: number) => `${((hour - 12) * 15).toFixed(2)}deg`
/** How much of the dial is still ahead of the marker at `hour` (1 at sunrise, 0 at the next one). */
const ahead = (hour: number) => (1 - (hour - SUNRISE) / 24).toFixed(4)

// ONE MOTION PERSONALITY, used everywhere: unhurried and exact. Three curves
// and no others. A thing already on screen moves on MOVE_CURVE (slow out,
// slow in). A thing arriving decelerates on IN_CURVE (fast start, soft
// landing). A thing leaving accelerates on OUT_CURVE, and leaves quicker than
// it came. Entrances settle with a few percent of overshoot at most; nothing
// bounces.
const MOVE_CURVE = 'cubic-bezier(0.4, 0, 0.2, 1)'
const IN_CURVE = 'cubic-bezier(0.05, 0.7, 0.1, 1)'
const OUT_CURVE = 'cubic-bezier(0.3, 0, 1, 1)'
const EASE = `animation-timing-function: ${MOVE_CURVE};`
const EASE_IN = `animation-timing-function: ${IN_CURVE};`
const EASE_OUT = `animation-timing-function: ${OUT_CURVE};`
const OUT_AT = pct(OUT)

// The marker and the arc behind it stop at the same places at the same times.
const MARKER_STOPS = TIMELINE.map(
  (stop) => `  ${pct(stop.arrive - 0.5)} { opacity: 1; }
  ${pct(stop.arrive)} { transform: rotate(${turn(stop.hour)}); opacity: 0; }
  ${pct(stop.leave - 0.5)} { transform: rotate(${turn(stop.hour)}); opacity: 0; }
  ${pct(stop.leave)} { transform: rotate(${turn(stop.hour)}); opacity: 1; ${EASE} }`
).join('\n')
// The moon is carried round by the marker, so it is turned back by as much to
// keep its horns the same way up.
const UPRIGHT_STOPS = TIMELINE.map(
  (stop) => `  ${pct(stop.arrive)} { transform: rotate(${turn(-stop.hour + 24)}); }
  ${pct(stop.leave)} { transform: rotate(${turn(-stop.hour + 24)}); ${EASE} }`
).join('\n')
const DONE_STOPS = TIMELINE.map(
  (stop) => `  ${pct(stop.arrive)} { stroke-dashoffset: ${ahead(stop.hour)}; opacity: 1; }
  ${pct(stop.leave)} { stroke-dashoffset: ${ahead(stop.hour)}; opacity: 1; ${EASE} }`
).join('\n')

// The marker is the sun until it sets and the moon after: a solid disc by
// day, a crescent by night. It changes partway through the move that crosses
// the horizon, the first one that ends after sunset.
//
// IT NEVER SITS ON TOP OF AN ICON. As it arrives at an event it lets go of
// its own shape and fills the event's whole disc instead (ni-day-fill-N,
// which turns the disc to solid ink and its icon to the page's colour); as it
// leaves, the disc empties and the marker takes its shape back.
const SETS = TIMELINE.find((stop) => stop.hour > SUNSET) ?? TIMELINE[TIMELINE.length - 1]
const SETS_AT = SETS.start + MOVE * 0.36
/** When the marker crosses the horizon on the right: about a third of the way into that move. */
const SUNSET_AT = SETS.start + MOVE * 0.31

// One loop, in CSS. Without motion (the rules outside the media query) the
// day is simply finished: everything shown, the marker in mid afternoon.
const CSS = `
.ni-day-marker { transform: rotate(52deg); }
.ni-day-done { stroke-dashoffset: 0.6; }
.ni-day-link, .ni-day-pulse { opacity: 0; }
.ni-day-fill { transform: scale(0); }
.ni-day-moon { opacity: 0; }
.ni-day-light { opacity: 0; }
.ni-day-glyph { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .ni-day-marker { animation: ni-day-marker ${LOOP}s linear infinite; }
  .ni-day-done { animation: ni-day-done ${LOOP}s linear infinite; }
  .ni-day-dial { animation: ni-day-dial ${LOOP}s linear infinite; }
  .ni-day-horizon { animation: ni-day-horizon ${LOOP}s linear infinite; }
  .ni-day-rise { animation: ni-day-rise ${LOOP}s linear infinite; }
  .ni-day-set { animation: ni-day-set ${LOOP}s linear infinite; }
  .ni-day-fill-rise { animation: ni-day-fill-rise ${LOOP}s linear infinite; }
  .ni-day-fill-set { animation: ni-day-fill-set ${LOOP}s linear infinite; }
  .ni-day-ticks { animation: ni-day-ticks ${LOOP}s linear infinite; }
  .ni-day-core { animation: ni-day-core ${LOOP}s linear infinite; }
  .ni-day-moon { animation: ni-day-moon ${LOOP}s linear infinite; }
  .ni-day-upright { animation: ni-day-upright ${LOOP}s linear infinite; }
  .ni-day-ping { animation: ni-day-ping 3s ease-out infinite; }
  .ni-day-swap { animation: ni-day-swap 0.35s ${IN_CURVE} both; }
  .ni-day-card { animation: ni-day-card 0.35s ${IN_CURVE} 0.3s both; }
  .ni-day-line { animation: ni-day-line 0.3s ${IN_CURVE} both; }
  .ni-day-check { animation: ni-day-check 0.3s ${MOVE_CURVE} 0.8s both; }
${EVENTS.map(
  (_, i) => `  .ni-day-chip-${i} { animation: ni-day-chip-${i} ${LOOP}s linear infinite; }
  .ni-day-label-${i} { animation: ni-day-label-${i} ${LOOP}s linear infinite; }
  .ni-day-did-${i} { animation: ni-day-did-${i} ${LOOP}s linear infinite; }
  .ni-day-link-${i} { animation: ni-day-link-${i} ${LOOP}s linear infinite; }
  .ni-day-pulse-${i} { animation: ni-day-pulse-${i} ${LOOP}s linear infinite; }
  .ni-day-fill-${i} { animation: ni-day-fill-${i} ${LOOP}s linear infinite; }
  .ni-day-glyph-${i} { animation: ni-day-glyph-${i} ${LOOP}s linear infinite; }`
).join('\n')}
}
@keyframes ni-day-marker {
  0% { transform: rotate(-90deg) scale(0.4); opacity: 0; }
  ${pct(INTRO * 0.6)} { transform: rotate(-90deg) scale(0.4); opacity: 0; ${EASE_IN} }
  ${pct(INTRO)} { transform: rotate(-90deg); opacity: 0; ${EASE} }
  ${pct(INTRO + 0.5)} { opacity: 1; }
${MARKER_STOPS}
  ${pct(HOME_AT - 0.5)} { opacity: 1; }
  ${pct(HOME_AT)} { transform: rotate(270deg); opacity: 0; }
  ${OUT_AT} { transform: rotate(270deg); opacity: 0; ${EASE_OUT} }
  ${pct(OUT + 2)} { transform: rotate(270deg) scale(0.4); opacity: 0; }
  100% { transform: rotate(270deg) scale(0.4); opacity: 0; }
}
@keyframes ni-day-done {
  0%, ${pct(INTRO)} { stroke-dashoffset: 1; opacity: 1; ${EASE} }
${DONE_STOPS}
  ${pct(HOME_AT)} { stroke-dashoffset: 0; opacity: 1; }
  ${OUT_AT} { stroke-dashoffset: 0; opacity: 1; }
  ${pct(OUT + 3)} { stroke-dashoffset: 0; opacity: 0; }
  100% { stroke-dashoffset: 1; opacity: 0; }
}
@keyframes ni-day-dial {
  0% { stroke-dashoffset: 1; ${EASE} }
  ${pct(INTRO * 0.85)} { stroke-dashoffset: 0; }
  ${pct(OUT + 2)} { stroke-dashoffset: 0; ${EASE} }
  99%, 100% { stroke-dashoffset: -1; }
}
@keyframes ni-day-horizon {
  0%, ${pct(INTRO * 0.5)} { stroke-dashoffset: 1; ${EASE_IN} }
  ${pct(INTRO * 1.1)} { stroke-dashoffset: 0; }
  ${pct(OUT + 1)} { stroke-dashoffset: 0; ${EASE_OUT} }
  ${pct(OUT + 3)}, 100% { stroke-dashoffset: 1; }
}
@keyframes ni-day-rise {
  0%, ${pct(INTRO * 0.3)} { stroke-dashoffset: 0.4; opacity: 1; ${EASE} }
  ${pct(INTRO)} { stroke-dashoffset: -1; opacity: 1; }
  ${pct(INTRO + 0.1)}, 100% { stroke-dashoffset: -1; opacity: 0; }
}
@keyframes ni-day-set {
  0%, ${pct(SUNSET_AT)} { stroke-dashoffset: 0.4; opacity: 0; }
  ${pct(SUNSET_AT + 0.05)} { stroke-dashoffset: 0.4; opacity: 1; ${EASE} }
  ${pct(SUNSET_AT + 3)} { stroke-dashoffset: -1; opacity: 1; }
  ${pct(SUNSET_AT + 3.1)}, 100% { stroke-dashoffset: -1; opacity: 0; }
}
@keyframes ni-day-fill-rise {
  0%, ${pct(INTRO * 0.7)} { transform: scale(0); ${EASE_IN} }
  ${pct(INTRO)} { transform: scale(1); ${EASE_OUT} }
  ${pct(INTRO + 0.6)} { transform: scale(0); }
  ${pct(HOME_AT - 0.5)} { transform: scale(0); ${EASE_IN} }
  ${pct(HOME_AT + 0.4)} { transform: scale(1); }
  ${OUT_AT} { transform: scale(1); ${EASE_OUT} }
  ${pct(OUT + 1.5)}, 100% { transform: scale(0); }
}
@keyframes ni-day-fill-set {
  0%, ${pct(SUNSET_AT - 0.5)} { transform: scale(0); ${EASE_IN} }
  ${pct(SUNSET_AT)} { transform: scale(1); }
  ${pct(SUNSET_AT + 0.3)} { transform: scale(1); ${EASE_OUT} }
  ${pct(SUNSET_AT + 1)}, 100% { transform: scale(0); }
}
@keyframes ni-day-ticks {
  0%, ${pct(INTRO * 0.4)} { opacity: 0; }
  ${pct(INTRO)} { opacity: 1; }
  ${pct(OUT + 2)} { opacity: 1; }
  ${pct(OUT + 4)}, 100% { opacity: 0; }
}
@keyframes ni-day-core {
  0%, ${pct(SETS_AT)} { opacity: 1; transform: scale(1); ${EASE} }
  ${pct(SETS_AT + 1)} { opacity: 0; transform: scale(0.4); }
  ${OUT_AT}, 100% { opacity: 0; transform: scale(0.4); }
}
@keyframes ni-day-moon {
  0%, ${pct(SETS_AT + 0.4)} { opacity: 0; ${EASE_IN} }
  ${pct(SETS_AT + 1.4)} { opacity: 1; }
  100% { opacity: 1; }
}
@keyframes ni-day-upright {
  0%, ${pct(INTRO)} { transform: rotate(90deg); ${EASE} }
${UPRIGHT_STOPS}
  ${pct(HOME_AT)}, 100% { transform: rotate(-270deg); }
}
@keyframes ni-day-ping {
  0% { transform: scale(1); opacity: 0.4; }
  100% { transform: scale(2.4); opacity: 0; }
}
@keyframes ni-day-swap {
  from { opacity: 0; transform: translateY(0.4em); }
  to { opacity: 1; transform: none; }
}
@keyframes ni-day-card {
  from { opacity: 0; transform: translateY(0.6em) scale(0.97); }
  to { opacity: 1; transform: none; }
}
@keyframes ni-day-line {
  from { opacity: 0; transform: translateX(-0.5em); }
  to { opacity: 1; transform: none; }
}
@keyframes ni-day-check {
  from { stroke-dashoffset: 1; }
  to { stroke-dashoffset: 0; }
}
${TIMELINE.map((stop, i) => {
  const a = stop.arrive
  const enter = pct(INTRO * 0.5 + i * 0.22)
  const set = pct(INTRO + i * 0.22)
  return `@keyframes ni-day-chip-${i} {
  0%, ${enter} { opacity: 0; transform: scale(0.7); ${EASE_IN} }
  ${set} { opacity: 1; transform: scale(1); }
  ${pct(a - 0.4)} { opacity: 1; transform: scale(1); ${EASE} }
  ${pct(a)} { opacity: 1; transform: scale(0.94); ${EASE_IN} }
  ${pct(a + 1)} { opacity: 1; transform: scale(1.12); ${EASE} }
  ${pct(a + 2)} { opacity: 1; transform: scale(1); }
  ${OUT_AT} { opacity: 1; transform: scale(1); ${EASE_OUT} }
  ${pct(OUT + 2 + i * 0.2)}, 100% { opacity: 0; transform: scale(0.7); }
}
@keyframes ni-day-glyph-${i} {
  0%, ${pct(a - 0.4)} { opacity: 0.35; ${EASE_IN} }
  ${pct(a + 1)} { opacity: 1; }
  100% { opacity: 1; }
}
@keyframes ni-day-label-${i} {
  0%, ${set} { opacity: 0; transform: translateY(0.3em); ${EASE_IN} }
  ${pct(INTRO + 1.2 + i * 0.22)} { opacity: 0.35; transform: none; }
  ${pct(a + 0.4)} { opacity: 0.35; transform: none; ${EASE_IN} }
  ${pct(a + 1.5)} { opacity: 1; transform: none; }
  ${OUT_AT} { opacity: 1; transform: none; ${EASE_OUT} }
  ${pct(OUT + 2)}, 100% { opacity: 0; transform: translateY(-0.2em); }
}
@keyframes ni-day-did-${i} {
  0%, ${pct(a + 1.6)} { opacity: 0; transform: translateY(0.35em); ${EASE_IN} }
  ${pct(a + 2.6)} { opacity: 1; transform: none; }
  ${OUT_AT} { opacity: 1; transform: none; ${EASE_OUT} }
  ${pct(OUT + 2)}, 100% { opacity: 0; transform: translateY(-0.2em); }
}
@keyframes ni-day-link-${i} {
  0%, ${pct(a + 0.5)} { stroke-dashoffset: 1; opacity: 0; }
  ${pct(a + 0.6)} { stroke-dashoffset: 1; opacity: 0.75; ${EASE} }
  ${pct(a + 1.8)} { stroke-dashoffset: 0; opacity: 0.75; }
  ${pct(stop.leave - 0.8)} { stroke-dashoffset: 0; opacity: 0.75; ${EASE_OUT} }
  ${pct(stop.leave)} { stroke-dashoffset: -1; opacity: 0; }
  100% { stroke-dashoffset: -1; opacity: 0; }
}
@keyframes ni-day-fill-${i} {
  0%, ${pct(a - 0.5)} { transform: scale(0); ${EASE_IN} }
  ${pct(a + 0.5)} { transform: scale(1); }
  ${pct(stop.leave - 0.6)} { transform: scale(1); ${EASE_OUT} }
  ${pct(stop.leave)}, 100% { transform: scale(0); }
}
@keyframes ni-day-pulse-${i} {
  0%, ${pct(a + 0.25)} { transform: scale(1); opacity: 0; }
  ${pct(a + 0.4)} { transform: scale(1); opacity: 0.5; ${EASE_IN} }
  ${pct(a + 2.6)} { transform: scale(2.6); opacity: 0; }
  100% { transform: scale(2.6); opacity: 0; }
}`
}).join('\n')}
`

// The whole dial as one stroke, starting at sunrise on the left and going
// round clockwise: over noon to sunset, under through midnight, and home.
const DIAL = `M ${CX - R} ${CY} A ${R} ${R} 0 1 1 ${CX + R} ${CY} A ${R} ${R} 0 1 1 ${CX - R} ${CY}`

export function HeroDay() {
  const markerRef = useRef<HTMLDivElement>(null)
  const clockRef = useRef<HTMLSpanElement>(null)
  // The latest event the marker has reached; null while nothing is playing
  // (the server's markup, and a visitor who asked for reduced motion).
  const [latest, setLatest] = useState<number | null>(null)

  useEffect(() => {
    const animation = markerRef.current?.getAnimations?.()[0]
    if (!animation) return
    const read = () => {
      const elapsed = Number(animation.currentTime ?? 0)
      const progress = (elapsed % (LOOP * 1000)) / (LOOP * 1000)
      const minutes = Math.floor(hourAt(progress) * 60)
      if (clockRef.current) {
        clockRef.current.textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
      }
      setLatest(latestEvent(progress))
    }
    read()
    const timer = setInterval(read, 200)
    return () => clearInterval(timer)
  }, [])

  const card = latest === null || latest < 0 ? null : EVENTS[latest]

  return (
    <div className="pointer-events-none relative mx-auto w-full max-w-[880px] text-foreground" style={{ aspectRatio: `${W} / ${H}` }} aria-hidden>
      <style>{CSS}</style>

      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full overflow-visible" fill="none">
        {/* The horizon: day above it, night below. The same hairline as the
            dial, and part of the same drawing: each side grows out of the dial
            once the dial is drawn, and goes back into it when the stage
            clears. It stops at the dial, so nothing runs through the middle. */}
        <line x1={CX - R} y1={CY} x2={-HORIZON_REACH} y2={CY} pathLength={1} strokeDasharray="1 1" stroke="currentColor" strokeOpacity={0.2} vectorEffect="non-scaling-stroke" className="ni-day-horizon" />
        <line x1={CX + R} y1={CY} x2={W + HORIZON_REACH} y2={CY} pathLength={1} strokeDasharray="1 1" stroke="currentColor" strokeOpacity={0.2} vectorEffect="non-scaling-stroke" className="ni-day-horizon" />
        {/* The light on the horizon, in the weight of the day's own arc: it
            comes in along the left side to the dial as the sun rises there,
            and goes out along the right side as it sets. */}
        <line x1={-HORIZON_REACH} y1={CY} x2={CX - R} y2={CY} pathLength={1} strokeDasharray="0.4 2" stroke="currentColor" strokeOpacity={0.8} strokeWidth={1.25} vectorEffect="non-scaling-stroke" className="ni-day-light ni-day-rise" />
        <line x1={CX + R} y1={CY} x2={W + HORIZON_REACH} y2={CY} pathLength={1} strokeDasharray="0.4 2" stroke="currentColor" strokeOpacity={0.8} strokeWidth={1.25} vectorEffect="non-scaling-stroke" className="ni-day-light ni-day-set" />

        {/* The dial: it draws itself as the scene sets, and over it runs the part of the day behind the marker. */}
        <path d={DIAL} pathLength={1} strokeDasharray="1 1" stroke="currentColor" strokeOpacity={0.2} vectorEffect="non-scaling-stroke" className="ni-day-dial" />
        <path d={DIAL} pathLength={1} strokeDasharray="1 1" stroke="currentColor" strokeOpacity={0.8} strokeWidth={1.25} vectorEffect="non-scaling-stroke" className="ni-day-done" />

        {/* A tick for every hour of the day and night, longer on the named ones. */}
        <g className="ni-day-ticks">
          {HOURS.map((h) => {
            const long = h % 3 === 0
            const inner = at(h, R - (long ? 9 : 5))
            const outer = at(h, R)
            return (
              <line key={h} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="currentColor" strokeOpacity={long ? 0.5 : 0.25} vectorEffect="non-scaling-stroke" />
            )
          })}
        </g>

        {/* From each event to the card: drawn as the event's scene plays, then gone. Not on a phone, which has no card. */}
        <g className="hidden sm:block">
          {EVENTS.map((event, i) => {
            const from = at(event.hour, R - 24)
            return (
              <line
                key={event.time}
                x1={from.x}
                y1={from.y}
                x2={CENTRE.x}
                y2={CENTRE.y}
                pathLength={1}
                strokeDasharray="1 1"
                stroke="currentColor"
                vectorEffect="non-scaling-stroke"
                className={`ni-day-link ni-day-link-${i}`}
              />
            )
          })}
        </g>
      </svg>

      {/* The named hours, just inside the dial. */}
      {NAMED_HOURS.map((h) => (
        <span
          key={h}
          className="ni-day-ticks absolute hidden -translate-x-1/2 -translate-y-1/2 font-mono text-[10px] tracking-wider text-muted-foreground sm:block"
          style={place(at(h, R - (h === SUNRISE || h === SUNSET ? 36 : 26)))}
        >
          {String(h).padStart(2, '0')}
        </span>
      ))}

      {/* The middle: the running clock, and the latest thing the workspace
          did. On a phone, one line; from `sm` up, the result itself on a card. */}
      {latest !== null && (
        <div className="absolute left-1/2 top-1/2 flex w-full -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
          <span ref={clockRef} className="block font-mono text-2xl font-light tracking-[0.08em] tabular-nums text-foreground sm:text-5xl" />
          {/* Keyed, so each new outcome comes in with its own small rise. */}
          <span key={latest} className="ni-day-swap mt-1.5 block h-5 max-w-[60%] truncate text-xs text-muted-foreground sm:hidden">
            {card?.did ?? ''}
          </span>
          {/* The card keeps its room while it is away, so the clock never moves. */}
          <div className="mt-6 hidden h-[8.25rem] w-[19rem] sm:block">
            {card && (
              // Keyed, so each stop opens its own card: the card settles in
              // once the line from the event has reached it, then its lines
              // follow one at a time.
              <div key={`card-${latest}`} className="ni-day-card rounded-2xl border border-foreground/15 bg-background px-4 py-3 text-left">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-foreground/15">{card.icon}</span>
                  <span className="ni-day-line min-w-0 flex-1 truncate text-sm font-medium text-foreground" style={{ animationDelay: '0.45s' }}>
                    {card.did}
                  </span>
                  <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-foreground" fill="none">
                    <path d="M3.5 8.5 6.5 11.5 12.5 5" pathLength={1} strokeDasharray="1 1" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="ni-day-check" />
                  </svg>
                </div>
                <ul className="mt-2 space-y-0.5">
                  {card.result.map((line, n) => (
                    <li
                      key={line}
                      className={`ni-day-line text-[13px]/5 ${n === 0 ? 'text-foreground/90' : 'text-muted-foreground'}`}
                      style={{ animationDelay: `${0.55 + n * 0.09}s` }}
                    >
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
      {/* The clock's element must exist before the first read, so it is in the
          markup from the start; it is empty and takes no room until then. */}
      {latest === null && <span ref={clockRef} className="hidden" />}

      {/* Where the horizon meets the dial: sunrise on the left, sunset on the
          right. The marker starts and ends its day inside the first, and
          lights the second as it goes down past it. */}
      {(
        [
          [SUNRISE, 'rise', <Sunrise key="rise" className={ICON} />],
          [SUNSET, 'set', <Sunset key="set" className={ICON} />],
        ] as const
      ).map(([hour, name, icon]) => (
        <span key={name} className="ni-day-ticks absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 sm:h-10 sm:w-10" style={place(at(hour))}>
          <span className="relative isolate flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-foreground/20 bg-background">
            {icon}
            <span className={`ni-day-fill ni-day-fill-${name} absolute inset-0 rounded-full bg-white mix-blend-difference`} />
          </span>
        </span>
      ))}

      {/* The day's events, each at its time. */}
      {EVENTS.map((event, i) => (
        <div key={event.time}>
          <span className="absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 sm:h-10 sm:w-10" style={place(at(event.hour))}>
            {/* The ring that goes out from the event as the marker arrives. */}
            <span className={`ni-day-pulse ni-day-pulse-${i} absolute inset-0 rounded-full border border-foreground`} />
            {/* Isolated, so the fill below only ever blends with this disc. */}
            <span className={`ni-day-chip-${i} relative isolate flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-foreground/20 bg-background`}>
              {/* Dim until the marker has been here. Only the icon dims: the
                  disc itself stays solid, so the dial never shows through it. */}
              <span className={`ni-day-glyph ni-day-glyph-${i} flex`}>{event.icon}</span>
              {/* The marker, arrived: it floods the disc. White in "difference"
                  swaps the disc's two colours, so the disc becomes solid ink
                  and its icon the page's colour, in either theme. */}
              <span className={`ni-day-fill ni-day-fill-${i} absolute inset-0 rounded-full bg-white mix-blend-difference`} />
            </span>
          </span>
          <span className={`absolute hidden whitespace-nowrap text-[13px]/4 text-foreground sm:block ${labelLean(event.hour)}`} style={place(at(event.hour, labelReach(event.hour)))}>
            <span className={`ni-day-label-${i} block`}>
              <span className="mr-2 font-mono text-[11px] text-muted-foreground">{event.time}</span>
              {event.label}
            </span>
            <span className={`ni-day-did-${i} block text-xs/4 text-muted-foreground`}>{event.did}</span>
          </span>
        </div>
      ))}

      {/* The marker: it turns about the middle of the dial, so it rides it.
          A solid disc is the sun; when its core fades at sunset the ring that
          is left is the moon. */}
      <div
        ref={markerRef}
        className="ni-day-marker absolute aspect-square -translate-x-1/2 -translate-y-1/2"
        style={{ ...place(CENTRE), width: `${((2 * R) / W) * 100}%` }}
      >
        <span className="absolute left-1/2 top-0 block h-4 w-4 -translate-x-1/2 -translate-y-1/2 sm:h-5 sm:w-5">
          <span className="ni-day-ping absolute inset-0 rounded-full bg-foreground" />
          {/* By day: the sun. */}
          <span className="ni-day-core absolute inset-0 rounded-full bg-foreground ring-4 ring-foreground/15" />
          {/* By night: the moon, turned back so it stays the same way up as the marker carries it round. */}
          <span className="ni-day-moon absolute inset-0">
            <span className="ni-day-upright absolute inset-0 block">
              <svg viewBox="0 0 24 24" className="h-full w-full text-foreground" fill="currentColor">
                <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
              </svg>
            </span>
          </span>
        </span>
      </div>
    </div>
  )
}
