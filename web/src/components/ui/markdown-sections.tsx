'use client'

/**
 * Read-aloud sections in rendered markdown (./markdown.tsx): the hover "play
 * this section" button on a heading (h1–h4) or a bold lead-in paragraph. What
 * an anchor is, where its section ends, what is read and when a button may show
 * are @/lib/read-aloud/sections' rules, shared with the note editor; playback
 * is @/lib/read-aloud/section-player's.
 *
 * SECTION_COMPONENTS override h1–h4 and `p` in every Markdown. Where read-aloud
 * is unsupported (a browser, local-tts not Ready, a capture recording) or the
 * content is still streaming, an anchor renders its plain element with no
 * handlers, and a paragraph that isn't lead-in shaped always does. Otherwise an
 * anchor listens for the pointer entering and leaving its own row: on entering,
 * the rules run against the DOM (never while rendering), and when they pass,
 * one button sits right after the anchor's text until the pointer leaves.
 * While its section is read the button stays, as Pause, and the section's
 * blocks carry `data-read-aloud-reading` (styled in tailwind.css). Paused, it
 * turns into Resume, which picks up at the sentence it stopped in
 * (@/lib/read-aloud/resume-points). The most recently paused section keeps its
 * button without a hover, and its blocks a dimmer bar
 * (`data-read-aloud-reading="paused"`); an older paused one only says Resume
 * when hovered. The anchor going away pauses its section.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import type { Components } from 'react-markdown'
import { Pause, Play } from 'lucide-react'
import {
  collectDomSection,
  hastIsLeadIn,
  linesToSentences,
  sectionHasButton,
  type DomSection,
} from '@/lib/read-aloud/sections'
import { pauseSection, playSection, prepareSectionPlayer, useSectionPlayer } from '@/lib/read-aloud/section-player'
import { useIsLastPaused, useResumePoint } from '@/lib/read-aloud/resume-points'
import {
  SECTION_BUTTON_CLASS,
  SECTION_BUTTON_LABELS,
  SECTION_PAUSE_ICON_CLASS,
  SECTION_PLAY_ICON_CLASS,
  type SectionButtonKind,
} from '@/lib/read-aloud/section-button'

export interface MarkdownSections {
  /** The markdown root: an anchor must be one of its children. */
  rootRef: RefObject<HTMLElement | null>
  /** Buttons may show: the content has finished streaming. */
  enabled: boolean
  /** The surface reads its whole content itself (a chat reply's Read aloud):
   *  no button for a section that is all of it. */
  skipWhole: boolean
}

export const MarkdownSectionsContext = createContext<MarkdownSections | null>(null)

type AnchorTag = 'h1' | 'h2' | 'h3' | 'h4' | 'p'

function SectionAnchor({ as: Tag, children, ...props }: HTMLAttributes<HTMLElement> & { as: AnchorTag }) {
  const sections = useContext(MarkdownSectionsContext)
  const { supported, playingKey } = useSectionPlayer()
  const key = `md:${useId()}`
  const playing = playingKey === key
  const resumable = useResumePoint(key) !== null && !playing
  const lastPaused = useIsLastPaused(key)
  const active = supported && !!sections?.enabled
  /** The most recent pause: its button and a dimmer bar stay without a hover. */
  const marked = active && lastPaused && !playing
  const anchorRef = useRef<HTMLElement | null>(null)
  const sectionRef = useRef<DomSection | null>(null)
  /** Worked out when the pointer entered, until it leaves. */
  const [hover, setHover] = useState<{ eligible: boolean } | null>(null)

  const setAnchor = useCallback((el: HTMLElement | null) => {
    anchorRef.current = el
  }, [])

  // No handlers while inactive, so a pointer that left then never said so.
  useEffect(() => {
    if (!active) setHover(null)
  }, [active])

  // While its section is read, or is the most recent pause, the section's
  // blocks show it. React doesn't manage the attribute, so it survives
  // re-renders.
  const reading = playing ? '' : marked ? 'paused' : null
  useEffect(() => {
    if (reading === null) return
    const blocks = sectionRef.current?.blocks ?? []
    for (const block of blocks) block.setAttribute('data-read-aloud-reading', reading)
    return () => {
      for (const block of blocks) block.removeAttribute('data-read-aloud-reading')
    }
  }, [reading])

  // The anchor going away (the reply removed, the content replaced) pauses its
  // section, so nothing plays on with no button to reach.
  useEffect(() => () => pauseSection(key), [key])

  if (!active && !playing) {
    return (
      <Tag ref={setAnchor} {...props}>
        {children}
      </Tag>
    )
  }

  const onPointerEnter = (event: ReactPointerEvent<HTMLElement>) => {
    const root = sections?.rootRef.current
    const section = root ? collectDomSection(event.currentTarget, root) : null
    const eligible = !!section && sectionHasButton(section, { skipWhole: sections?.skipWhole })
    setHover({ eligible })
    if (eligible) prepareSectionPlayer()
  }

  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    // The button sits inside the content: keep the click off its surroundings
    // (an expandable card, a message row).
    event.preventDefault()
    event.stopPropagation()
    if (playing) {
      pauseSection(key)
      return
    }
    // Rules again at click time: the content may have changed since the hover.
    const anchor = anchorRef.current
    const root = sections?.rootRef.current
    const section = anchor && root ? collectDomSection(anchor, root) : null
    if (!section || !sectionHasButton(section, { skipWhole: sections?.skipWhole })) return
    sectionRef.current = section
    // From the sentence it was paused in, if it was.
    playSection(key, linesToSentences(section.lines))
  }

  const showButton = playing || (active && (marked || !!hover?.eligible))
  const kind: SectionButtonKind = playing ? 'pause' : resumable ? 'resume' : 'play'
  const label = SECTION_BUTTON_LABELS[kind]
  return (
    <Tag
      ref={setAnchor}
      {...props}
      onPointerEnter={active ? onPointerEnter : undefined}
      onPointerLeave={active ? () => setHover(null) : undefined}
    >
      {children}
      {showButton && (
        <button
          type="button"
          className={SECTION_BUTTON_CLASS}
          data-read-aloud-section={kind}
          aria-label={label}
          title={label}
          // Keep focus (and the caret) where it was, e.g. in the chat composer.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
        >
          {playing ? (
            <Pause aria-hidden className={SECTION_PAUSE_ICON_CLASS} />
          ) : (
            <Play aria-hidden className={SECTION_PLAY_ICON_CLASS} />
          )}
        </button>
      )}
    </Tag>
  )
}

/**
 * The overrides Markdown merges into its components (a consumer's own win on
 * the same tag). react-markdown's `node` is only read, never spread onto the DOM.
 */
export const SECTION_COMPONENTS: Partial<Components> = {
  h1: function SectionH1({ node: _node, ...props }) {
    return <SectionAnchor as="h1" {...props} />
  },
  h2: function SectionH2({ node: _node, ...props }) {
    return <SectionAnchor as="h2" {...props} />
  },
  h3: function SectionH3({ node: _node, ...props }) {
    return <SectionAnchor as="h3" {...props} />
  },
  h4: function SectionH4({ node: _node, ...props }) {
    return <SectionAnchor as="h4" {...props} />
  },
  // Only a lead-in-shaped paragraph can be an anchor; every other one is a plain <p>.
  p: function SectionParagraph({ node, ...props }) {
    return hastIsLeadIn(node) ? <SectionAnchor as="p" {...props} /> : <p {...props} />
  },
}
