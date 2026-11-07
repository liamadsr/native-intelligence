import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  collectPmSection,
  linesToSentences,
  pmAnchorRank,
  sectionHasButton,
} from '@/lib/read-aloud/sections'
import {
  getSectionPlayerSnapshot,
  pauseSection,
  pauseSectionIfKeyStartsWith,
  playSection,
  prepareSectionPlayer,
  subscribeSectionPlayer,
} from '@/lib/read-aloud/section-player'
import { getLastPausedKey, getResumePoint, subscribeResumePoints } from '@/lib/read-aloud/resume-points'
import {
  SECTION_BUTTON_ATTR,
  SECTION_BUTTON_CLASS,
  SECTION_BUTTON_LABELS,
  SECTION_PAUSE_ICON_CLASS,
  SECTION_PLAY_ICON_CLASS,
  type SectionButtonKind,
} from '@/lib/read-aloud/section-button'

/**
 * Read-aloud sections in the note editor (documents, action descriptions,
 * project / initiative / contact and capture notes): the hover "play this
 * section" button on a heading or a bold lead-in, as in rendered markdown
 * (components/ui/markdown-sections.tsx) and under the same rules
 * (@/lib/read-aloud/sections). Playback is @/lib/read-aloud/section-player's.
 *
 * All of it is decorations, driven by META-ONLY transactions: hovering,
 * playing, pausing, and read-aloud coming or going never change the document,
 * so NoteEditor's onUpdate (the save) and the undo history never see them.
 *   - mouseover finds the top-level block under the pointer; when it is an
 *     anchor, its start becomes `hoverPos` (a transaction only when that
 *     changes; leaving the editor clears it);
 *   - a Play widget sits after the hovered anchor's text when its section
 *     passes the rules (worked out for that one anchor), and not while the
 *     content streams in (`isStreaming`, NoteEditor's AI writing). For a
 *     section paused before it says Resume;
 *   - every section read here is `tracked`: its key in the section player and
 *     its positions, mapped through edits. The same anchor keeps its key, which
 *     is what lets a paused section resume at the sentence it stopped in
 *     (@/lib/read-aloud/resume-points);
 *   - while one of this editor's sections plays: a Pause widget on its anchor,
 *     and its top-level blocks carry `read-aloud-reading` (tailwind.css). While
 *     one is the most recent pause anywhere: a Resume widget stays on its
 *     anchor, and its blocks carry the dimmer `read-aloud-paused`. When an
 *     anchor is deleted its section is no longer tracked, so its widget and bar
 *     go (a playing one reads on).
 * Read-only editors work the same. A document has no button that reads all of
 * it, so a section may be the whole document. Where read-aloud is unsupported
 * there are no decorations at all, and hovering dispatches nothing. The editor
 * going away pauses its section.
 */

/** A section this editor has read. */
interface Tracked {
  /** Its key in the section player (this editor's prefix, then a number). */
  key: string
  /** The anchor's start. */
  anchorPos: number
  /** The section's range when it last started, mapped through edits since. */
  from: number
  to: number
}

interface ReadAloudSectionsState {
  /** The start of the top-level anchor under the pointer, or null. */
  hoverPos: number | null
  /** The hovered anchor shows a Play (or Resume) button. */
  hoverButton: boolean
  /** The sections read here that are playing or can resume, oldest first. */
  tracked: Tracked[]
  /** The section player's playing key, when it is one of this editor's. */
  playingKey: string | null
  /** The most recent pause (@/lib/read-aloud/resume-points), when it is one
   *  of this editor's. */
  pausedKey: string | null
  /** The section player's `supported`. False → no decorations. */
  supported: boolean
  decorations: DecorationSet
}

type Meta = Partial<Pick<ReadAloudSectionsState, 'hoverPos' | 'tracked' | 'playingKey' | 'pausedKey' | 'supported'>>

export const READ_ALOUD_SECTIONS_KEY = new PluginKey<ReadAloudSectionsState>('readAloudSections')

export interface ReadAloudSectionsOptions {
  /** True while the content streams in: no Play buttons then. */
  isStreaming: () => boolean
}

/** Every editor's runs get their own key prefix. */
let editorSeq = 0

export const ReadAloudSections = Extension.create<ReadAloudSectionsOptions>({
  name: 'readAloudSections',

  addOptions() {
    return { isStreaming: () => false }
  },

  addProseMirrorPlugins() {
    return [readAloudSectionsPlugin(`pm:${editorSeq++}:`, this.options.isStreaming)]
  },
})

function readAloudSectionsPlugin(keyPrefix: string, isStreaming: () => boolean): Plugin<ReadAloudSectionsState> {
  let playSeq = 0
  /** `key` when it is one of this editor's, else null. */
  const own = (key: string | null) => (key !== null && key.startsWith(keyPrefix) ? key : null)

  const setMeta = (view: EditorView, meta: Meta) => {
    view.dispatch(view.state.tr.setMeta(READ_ALOUD_SECTIONS_KEY, meta))
  }

  const onButton = (view: EditorView, pos: number | undefined, kind: SectionButtonKind) => {
    const value = READ_ALOUD_SECTIONS_KEY.getState(view.state)
    if (!value) return
    if (kind === 'pause') {
      if (value.playingKey) pauseSection(value.playingKey)
      return
    }
    if (pos === undefined) return
    // The rules again at click time; the widget sits inside its anchor.
    const doc = view.state.doc
    const section = collectPmSection(doc, doc.resolve(pos).index(0))
    if (!section || !sectionHasButton(section)) return
    // The same anchor keeps its key, so a section paused before resumes.
    const key = value.tracked.find((t) => t.anchorPos === section.from)?.key ?? `${keyPrefix}${playSeq++}`
    playSection(key, linesToSentences(section.lines))
    // Unsupported, or nothing to say: the player didn't take it.
    if (getSectionPlayerSnapshot().playingKey !== key) return
    // What can still resume stays tracked (the section this one paused, if it
    // was ours, among them); one that ran to its end is dropped.
    const now = READ_ALOUD_SECTIONS_KEY.getState(view.state) ?? value
    const tracked = now.tracked.filter((t) => t.key !== key && getResumePoint(t.key) !== null)
    tracked.push({ key, anchorPos: section.from, from: section.from, to: section.to })
    setMeta(view, { tracked, playingKey: key })
  }

  const widget = (pos: number, kind: SectionButtonKind) =>
    Decoration.widget(pos, (view, getPos) => sectionButton(kind, () => onButton(view, getPos(), kind)), {
      side: 1,
      ignoreSelection: true,
      stopEvent: () => true,
      key: `read-aloud-section-${kind}`,
    })

  const build = (doc: PMNode, value: ReadAloudSectionsState): ReadAloudSectionsState => {
    const decorations: Decoration[] = []
    let hoverButton = false
    if (value.supported) {
      /** Anchors that carry a button already. */
      const withButton = new Set<number>()
      const mark = (key: string | null, className: string, kind: SectionButtonKind) => {
        const section = key === null ? undefined : value.tracked.find((t) => t.key === key)
        const anchor = section ? topLevelNodeAt(doc, section.anchorPos) : null
        if (!section || !anchor) return
        // Resume needs an anchor to find the section again (Pause does not).
        if (kind === 'resume' && pmAnchorRank(anchor) === null) return
        doc.forEach((node, offset) => {
          if (offset < section.to && offset + node.nodeSize > section.from) {
            decorations.push(Decoration.node(offset, offset + node.nodeSize, { class: className }))
          }
        })
        decorations.push(widget(section.anchorPos + anchor.nodeSize - 1, kind))
        withButton.add(section.anchorPos)
      }
      mark(value.playingKey, 'read-aloud-reading', 'pause')
      if (value.pausedKey !== value.playingKey) mark(value.pausedKey, 'read-aloud-paused', 'resume')

      const { hoverPos } = value
      const hovered = hoverPos === null || withButton.has(hoverPos) ? null : topLevelNodeAt(doc, hoverPos)
      if (hovered && hoverPos !== null && !isStreaming()) {
        const section = collectPmSection(doc, doc.resolve(hoverPos).index(0))
        if (section && sectionHasButton(section)) {
          const known = value.tracked.find((t) => t.anchorPos === hoverPos)
          const kind = known && getResumePoint(known.key) !== null ? 'resume' : 'play'
          decorations.push(widget(hoverPos + hovered.nodeSize - 1, kind))
          hoverButton = true
        }
      }
    }
    return {
      ...value,
      hoverButton,
      decorations: decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty,
    }
  }

  return new Plugin<ReadAloudSectionsState>({
    key: READ_ALOUD_SECTIONS_KEY,

    state: {
      init: (_config, state) =>
        build(state.doc, {
          hoverPos: null,
          hoverButton: false,
          tracked: [],
          playingKey: null,
          pausedKey: null,
          supported: getSectionPlayerSnapshot().supported,
          decorations: DecorationSet.empty,
        }),
      apply(tr, value, _oldState, newState) {
        const meta = tr.getMeta(READ_ALOUD_SECTIONS_KEY) as Meta | undefined
        if (!meta && !tr.docChanged) return value
        let next = tr.docChanged ? mapPositions(value, tr) : value
        if (meta) next = { ...next, ...meta }
        return build(newState.doc, next)
      },
    },

    props: {
      decorations: (state) => READ_ALOUD_SECTIONS_KEY.getState(state)?.decorations,
      handleDOMEvents: {
        mouseover: (view, event) => {
          const value = READ_ALOUD_SECTIONS_KEY.getState(view.state)
          if (!value?.supported) return false
          const pos = anchorPosAt(view, event.target)
          if (pos !== value.hoverPos) {
            setMeta(view, { hoverPos: pos })
            // Warm the engine, so the first sentence starts fast.
            if (READ_ALOUD_SECTIONS_KEY.getState(view.state)?.hoverButton) prepareSectionPlayer()
          }
          return false
        },
        mouseleave: (view) => {
          if (READ_ALOUD_SECTIONS_KEY.getState(view.state)?.hoverPos != null) setMeta(view, { hoverPos: null })
          return false
        },
      },
    },

    view: (view) => {
      // Read-aloud coming or going, one of our sections starting or ending
      // (done, paused, stopped, taken over by another section or a chat read),
      // and the most recent pause moving.
      const sync = () => {
        const value = READ_ALOUD_SECTIONS_KEY.getState(view.state)
        if (!value) return
        const { supported, playingKey } = getSectionPlayerSnapshot()
        const pausedKey = own(getLastPausedKey())
        const meta: Meta = {}
        if (supported !== value.supported) meta.supported = supported
        if (own(playingKey) !== value.playingKey) meta.playingKey = own(playingKey)
        if (pausedKey !== value.pausedKey) meta.pausedKey = pausedKey
        if (Object.keys(meta).length > 0) setMeta(view, meta)
      }
      const unsubscribePlayer = subscribeSectionPlayer(sync)
      const unsubscribePoints = subscribeResumePoints(sync)
      return {
        destroy: () => {
          unsubscribePlayer()
          unsubscribePoints()
          // The editor going away (a panel closed, a document switched) pauses
          // its section.
          pauseSectionIfKeyStartsWith(keyPrefix)
        },
      }
    },
  })
}

/** The top-level node starting at `pos`, or null. */
function topLevelNodeAt(doc: PMNode, pos: number): PMNode | null {
  if (pos < 0 || pos >= doc.content.size) return null
  const $pos = doc.resolve(pos)
  return $pos.depth === 0 ? $pos.nodeAfter : null
}

/** The start of the top-level anchor holding the DOM `target`, or null. */
function anchorPosAt(view: EditorView, target: EventTarget | null): number | null {
  let el: Node | null = target instanceof Node ? target : null
  while (el && el.parentNode !== view.dom) el = el.parentNode
  if (!el) return null
  let inside: number
  try {
    inside = view.posAtDOM(el, 0)
  } catch {
    return null
  }
  const doc = view.state.doc
  if (inside < 0 || inside > doc.content.size) return null
  const $pos = doc.resolve(inside)
  const index = $pos.index(0)
  if (index >= doc.childCount || pmAnchorRank(doc.child(index)) === null) return null
  return $pos.posAtIndex(index, 0)
}

/** Map the hovered anchor and the tracked sections through an edit. A section
 *  whose anchor was deleted is no longer tracked. */
function mapPositions(value: ReadAloudSectionsState, tr: Transaction): ReadAloudSectionsState {
  let hoverPos = value.hoverPos
  if (hoverPos !== null) {
    const mapped = tr.mapping.mapResult(hoverPos, 1)
    hoverPos = mapped.deleted ? null : mapped.pos
  }
  const tracked: Tracked[] = []
  for (const section of value.tracked) {
    const anchor = tr.mapping.mapResult(section.anchorPos, 1)
    if (anchor.deleted) continue
    tracked.push({
      ...section,
      anchorPos: anchor.pos,
      from: tr.mapping.map(section.from, 1),
      to: tr.mapping.map(section.to, -1),
    })
  }
  return { ...value, hoverPos, tracked }
}

// ── The button: plain DOM, the same look as Markdown's ─────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg'

/** lucide's Play and Pause (lucide-react 0.563), as Markdown renders them. */
function sectionIcon(kind: SectionButtonKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const pause = kind === 'pause'
  const attrs: Record<string, string> = {
    xmlns: SVG_NS,
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    class: pause ? `lucide lucide-pause ${SECTION_PAUSE_ICON_CLASS}` : `lucide lucide-play ${SECTION_PLAY_ICON_CLASS}`,
  }
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value)
  if (pause) {
    for (const x of ['14', '5']) {
      const rect = document.createElementNS(SVG_NS, 'rect')
      for (const [name, value] of Object.entries({ x, y: '3', width: '5', height: '18', rx: '1' })) {
        rect.setAttribute(name, value)
      }
      svg.appendChild(rect)
    }
  } else {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z')
    svg.appendChild(path)
  }
  return svg
}

function sectionButton(kind: SectionButtonKind, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  const label = SECTION_BUTTON_LABELS[kind]
  button.type = 'button'
  button.className = SECTION_BUTTON_CLASS
  button.setAttribute('contenteditable', 'false')
  button.setAttribute(SECTION_BUTTON_ATTR, kind)
  button.setAttribute('aria-label', label)
  button.title = label
  button.appendChild(sectionIcon(kind))
  // Keep the selection, the caret and focus where they are.
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onClick()
  })
  return button
}
