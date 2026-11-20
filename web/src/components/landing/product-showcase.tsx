'use client'

/**
 * The real app, on the page: screens of Native Intelligence itself, taken on
 * a made-up studio's workspace (public/screens, the same shots the
 * repository's README shows). A row of tabs names what each one is; the
 * picture changes on its own every few seconds while it is on screen, with
 * the active tab filling as its time runs, and a click picks one and stops
 * the clock.
 *
 * The shots are light on purpose, in both themes: they are photographs of
 * the product, not drawings of it, so they are not re-tinted to match the
 * page.
 *
 * ALL OF IT IN ONE VIEW. The app is not only that window: it is on the phone
 * and the watch, and beside every call on the Mac. As the picture scrolls up
 * the page the window steps back a little and those three come in from the
 * sides around it (the same README shots: the phone's home, the watch
 * recording, the call window with what it has captured), so by the middle of
 * the screen the whole product is in one frame. The motion is tied to the
 * scroll position through framer-motion's useScroll (one passive listener,
 * transforms and opacity only). From `md` up; a phone has no room for them.
 * A visitor who asked for reduced motion gets them in place, still.
 *
 * Every picture is in the markup from the start (lazy-loaded, with its size,
 * so nothing shifts); only the opacity of two of them changes at a time. One
 * timer, only while on screen; none for a visitor who asked for reduced
 * motion, who changes the picture by hand.
 */
import { clsx } from 'clsx'
import {
  motion,
  useScroll,
  useTransform,
  type MotionValue,
} from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { DemoFrame } from '@/components/demo/demo-frame'
import type { DemoScreen } from '@/components/demo/demo-app'
import { IN_CSS, MOVE_CSS } from './motion'
import { useInView, useReducedMotion } from './use-in-view'

const SCREENS = [
  {
    tab: 'Ask',
    src: '/screens/chat-view.webp',
    alt: 'Asked for the open tasks on a project, the agent puts the live task board right in the chat and sums up what is left',
    caption:
      'Ask for anything in the workspace and it comes back live, here a project’s task board in the chat.',
  },
  {
    tab: 'Tasks',
    live: 'tasks',
    src: '/screens/chat-view-fullscreen.webp',
    alt: 'The same task board opened full screen, with its columns from backlog to done',
    caption:
      'Your open tasks, each with its identifier, project, priority and due date.',
  },
  {
    tab: 'Meetings',
    live: 'meeting',
    src: '/screens/meeting-notes.webp',
    alt: 'A finished meeting’s notes: overview, goals and discussion, with the date, length, project and participants beside them',
    caption:
      'A finished call: the overview, goals, discussion and next steps, ready when you hang up.',
  },
  {
    tab: 'Memory',
    src: '/screens/knowledge-graph.webp',
    alt: 'The knowledge graph: what the workspace knows, clustered around its clients, people, meetings, documents and tasks',
    caption:
      'What the workspace knows, joined up: clients, people, meetings, docs and tasks.',
  },
] as const satisfies readonly { tab: string; src: string; alt: string; caption: string; live?: DemoScreen }[]

/** The screens drawn by the app itself (components/demo/demo-frame.tsx), not a picture of it. */
const LIVE = SCREENS.flatMap((screen) => ('live' in screen ? [screen.live] : []))

/**
 * The rest of the product, around the window: where each sits (a share of the
 * stage), which side it comes in from, and the part of the scroll it moves in.
 */
const AROUND = [
  {
    src: '/screens/live-call.webp',
    alt: 'The call window on the Mac: it is listening to a call, and has captured three next steps so far',
    width: 954,
    height: 1069,
    place: 'right-[1%] top-[10%] w-[27%]',
    from: 90,
    span: [0.1, 0.75],
  },
  {
    src: '/screens/iphone-home.webp',
    alt: 'The iPhone app’s home: what is coming up and the open tasks',
    width: 742,
    height: 1564,
    place: 'left-[1.5%] top-[4%] w-[16%]',
    from: -90,
    span: [0.25, 0.9],
  },
  {
    src: '/screens/watch-recording.webp',
    alt: 'The Apple Watch app, recording',
    width: 448,
    height: 528,
    place: 'left-[13%] bottom-[3%] w-[10%]',
    from: -60,
    span: [0.4, 1],
  },
] as const

/** One of the pictures around the window: it slides in from its side as `progress` crosses its span. */
function Around({
  item,
  progress,
  still,
}: {
  item: (typeof AROUND)[number]
  progress: MotionValue<number>
  still: boolean
}) {
  const x = useTransform(progress, [...item.span], [item.from, 0])
  // Solid for the whole slide: it only fades over the first sliver of its move, so it never sits half see-through over the window.
  const opacity = useTransform(progress, [item.span[0], item.span[0] + 0.05], [0, 1])
  return (
    <motion.img
      src={item.src}
      alt={item.alt}
      width={item.width}
      height={item.height}
      loading="lazy"
      decoding="async"
      style={still ? undefined : { x, opacity }}
      className={clsx(
        'absolute z-10 hidden h-auto drop-shadow-2xl md:block',
        item.place,
      )}
    />
  )
}

/** Seconds each screen stays up before the next one comes. */
const DWELL = 6

const CSS = `
.ni-screen { transition: opacity 0.5s ${MOVE_CSS}, transform 0.6s ${IN_CSS}; }
@media (prefers-reduced-motion: no-preference) {
  .ni-screen-clock { animation: ni-screen-clock ${DWELL}s linear both; }
}
@keyframes ni-screen-clock {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
`

export function ProductShowcase() {
  const [ref, inView] = useInView<HTMLDivElement>()
  const reduced = useReducedMotion()
  const [active, setActive] = useState(0)
  // A person picking a tab stops the clock: they are reading that one.
  const [picked, setPicked] = useState(false)
  const running = inView && !reduced && !picked
  // How far the stage has come up the screen: 0 as its top passes three
  // quarters of the way down, 1 once it is near the top.
  const stageRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: stageRef,
    offset: ['start 0.8', 'start 0.15'],
  })
  const scale = useTransform(scrollYProgress, [0, 0.8], [1, 0.86])

  const shown = SCREENS[active]
  const liveScreen: DemoScreen | undefined = 'live' in shown ? shown.live : undefined
  // The frame keeps the last live screen while a picture is showing, so coming back is instant.
  const [lastLive, setLastLive] = useState<DemoScreen>(LIVE[0])
  useEffect(() => {
    if (liveScreen) setLastLive(liveScreen)
  }, [liveScreen])

  useEffect(() => {
    if (!running) return
    const timer = setTimeout(
      () => setActive((n) => (n + 1) % SCREENS.length),
      DWELL * 1000,
    )
    return () => clearTimeout(timer)
  }, [running, active])

  return (
    <div ref={ref}>
      <style>{CSS}</style>
      <div
        role="tablist"
        aria-label="Screens of the app"
        className="border-border bg-background/50 mx-auto flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border p-1 backdrop-blur-md"
      >
        {SCREENS.map((screen, i) => (
          <button
            key={screen.tab}
            type="button"
            role="tab"
            aria-selected={i === active}
            onClick={() => {
              setActive(i)
              setPicked(true)
            }}
            className={clsx(
              'relative overflow-hidden rounded-full px-5 py-2 text-sm font-medium transition-colors sm:text-base',
              i === active
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {/* The active tab fills as its time runs. Keyed, so it starts over each time. */}
            {i === active && running && (
              <span
                key={active}
                aria-hidden
                className="ni-screen-clock bg-foreground/10 absolute inset-0 origin-left"
              />
            )}
            <span className="relative">{screen.tab}</span>
          </button>
        ))}
      </div>

      {/* The first picture sets the height; the others lie over it. */}
      <div ref={stageRef} className="relative mt-8 md:px-[7%]">
        {AROUND.map((item) => (
          <Around
            key={item.src}
            item={item}
            progress={scrollYProgress}
            still={reduced}
          />
        ))}
        {/* The window steps back to make room, from `md` up where there is something to make room for. */}
        <motion.div
          style={reduced ? undefined : { scale }}
          className="relative max-md:!scale-100 max-md:!transform-none"
        >
          {SCREENS.map((screen, i) => (
            <img
              key={screen.src}
              src={screen.src}
              alt={i === active ? screen.alt : ''}
              aria-hidden={i === active ? undefined : true}
              width={1908}
              height={1237}
              // The first screen is the page's opening picture; the others wait until wanted.
              loading={i === 0 ? 'eager' : 'lazy'}
              decoding="async"
              className={clsx(
                'ni-screen h-auto w-full',
                i > 0 && 'absolute inset-0',
                i === active ? 'opacity-100' : 'scale-[0.985] opacity-0',
              )}
            />
          ))}
          {/* The app itself, over the picture of it, for the screens it can draw: one frame, kept
              loaded, told which screen to show. The picture under it holds the slot until it is up. */}
          <div
            className={clsx(
              'ni-screen absolute inset-0 overflow-hidden rounded-[0.9rem]',
              liveScreen ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            <DemoFrame screen={liveScreen ?? lastLive} label={SCREENS[active].alt} height={934} />
          </div>
        </motion.div>
      </div>
      <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-center text-sm sm:text-base">
        {SCREENS[active].caption}
      </p>
    </div>
  )
}
