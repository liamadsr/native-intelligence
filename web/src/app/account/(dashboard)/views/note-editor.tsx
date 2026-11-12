'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EditorRoot,
  EditorContent,
  EditorCommand,
  EditorCommandItem,
  EditorCommandEmpty,
  EditorCommandList,
  EditorBubble,
  EditorBubbleItem,
  type JSONContent,
  type SuggestionItem,
  TiptapLink,
  TaskList,
  TaskItem,
  HorizontalRule,
  StarterKit,
  Placeholder,
  handleCommandNavigation,
  createSuggestionItems,
  Command,
  renderItems,
  useEditor,
} from 'novel'
import type { Editor } from '@tiptap/core'
import type { Range } from '@tiptap/core'
import { CellSelection } from '@tiptap/pm/tables'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { TextAlign } from '@tiptap/extension-text-align'
import { Gapcursor } from '@tiptap/extension-gapcursor'
import { cx } from 'class-variance-authority'
import { LinkPreviewNode } from '@/components/editor/link-preview-extension'
import { RecordMention } from '@/components/editor/record-mention'
import { EDITOR_LINK_CLASS, UrlLinkDecorations } from '@/components/editor/url-link-decorations'
import { pasteUrlTransaction } from '@/components/editor/paste-url'
import { ReadAloudSections } from '@/components/editor/read-aloud-sections-extension'
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  TextQuote,
  Code,
  Minus,
  Table as TableIcon,
  Sparkles,
  BoldIcon,
  ItalicIcon,
  StrikethroughIcon,
  CodeIcon,
  MessageSquarePlus,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ArrowDownToLine,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  Columns3,
  Rows3,
} from 'lucide-react'
import { OrbLoader } from '@/components/ui/loader'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

// --- Extensions ---

const placeholder = Placeholder.configure({
  placeholder: ({ node, editor }) => {
    // Only show the main placeholder when the entire editor is empty
    if (node.type.name === 'paragraph' && editor.isEmpty) {
      return 'Start writing, or type / for commands...'
    }
    return ''
  },
  emptyEditorClass: 'is-editor-empty',
  emptyNodeClass: 'is-empty',
  showOnlyCurrent: true,
  includeChildren: false,
})

const tiptapLink = TiptapLink.configure({
  // Clicks are UrlLinkDecorations' (url-link-decorations.ts): the in-app
  // browser, the modifiers, and no window.open without noopener.
  openOnClick: false,
  HTMLAttributes: {
    class: cx(EDITOR_LINK_CLASS),
  },
})

const taskList = TaskList.configure({
  HTMLAttributes: { class: cx('not-prose pl-2') },
})

const taskItem = TaskItem.configure({
  HTMLAttributes: { class: cx('flex items-start my-4') },
  nested: true,
})

const horizontalRule = HorizontalRule.configure({
  HTMLAttributes: { class: cx('mt-4 mb-6 border-t border-muted-foreground') },
})

const table = Table.configure({
  HTMLAttributes: {
    class: cx('not-prose ni-table'),
  },
  resizable: true,
  lastColumnResizable: true,
})

const tableRow = TableRow.configure({})

const tableHeader = TableHeader.configure({
  HTMLAttributes: { class: cx('ni-table-header') },
})

const tableCell = TableCell.configure({
  HTMLAttributes: { class: cx('ni-table-cell') },
})

// Enables per-cell column alignment from GFM `:---:` delimiters.
const textAlign = TextAlign.configure({
  types: ['heading', 'paragraph'],
})

/**
 * Undo depth. ProseMirror's default is 100 EVENTS, and an event can hold an
 * unbounded number of steps (transactions less than 500ms apart merge into
 * one), so the default is not a memory bound in any useful sense. 30 covers
 * far more than anyone undoes by hand while capping what a long session can
 * retain.
 *
 * This is the belt to `setContentWithoutHistory`'s braces: the real fix is
 * keeping programmatic writes OUT of the history, since each one records an
 * inverted step holding the entire previous document.
 */
const UNDO_DEPTH = 30

/**
 * Replace the whole document WITHOUT recording an undo entry.
 *
 * Tiptap's `setContent` sets only `preventUpdate` (it does not opt out of
 * history), so every programmatic replace pushed a full-document snapshot onto
 * the undo stack — and because sub-500ms transactions merge into a single
 * event, depth pruning never reclaimed them. A streaming summary animation
 * writing the document once per frame therefore retained thousands of
 * document copies inside ONE unprunable undo event: hundreds of MB to a GB on
 * a long capture, held for as long as the panel stayed mounted.
 *
 * Undo is for the USER's edits. AI writes, external syncs and proposal
 * re-resolution are not things you should be able to step backwards through.
 */
function setContentWithoutHistory(editor: Editor, content: JSONContent) {
  editor.chain().setMeta('addToHistory', false).setContent(content, false).run()
}

const starterKit = StarterKit.configure({
  history: { depth: UNDO_DEPTH },
  bulletList: {
    HTMLAttributes: { class: cx('list-disc list-outside leading-3 -mt-2') },
  },
  orderedList: {
    HTMLAttributes: { class: cx('list-decimal list-outside leading-3 -mt-2') },
  },
  listItem: {
    HTMLAttributes: { class: cx('leading-normal -mb-2') },
  },
  blockquote: {
    HTMLAttributes: { class: cx('border-l-4 border-primary') },
  },
  codeBlock: {
    HTMLAttributes: {
      class: cx('rounded-sm bg-muted border p-5 font-mono font-medium'),
    },
  },
  code: {
    HTMLAttributes: {
      class: cx('rounded-md bg-muted px-1.5 py-1 font-mono font-medium'),
      spellcheck: 'false',
    },
  },
  horizontalRule: false,
  dropcursor: { color: '#DBEAFE', width: 4 },
  // Disable StarterKit's gapcursor and register it standalone below — required
  // so users can place the cursor above/below a table that sits at the very
  // start or end of the document (tables are block nodes that otherwise trap
  // the cursor).
  gapcursor: false,
})

const defaultExtensions = [
  starterKit,
  placeholder,
  tiptapLink,
  // Bare URLs (loaded, synced or agent-written text) read as links, and a
  // click on any link opens it.
  UrlLinkDecorations,
  taskList,
  taskItem,
  horizontalRule,
  Gapcursor,
  table,
  tableRow,
  tableHeader,
  tableCell,
  textAlign,
  LinkPreviewNode,
  // A record @-mentioned in the body, drawn as a chip in every editor (the `@` picker is the documents': record-mention.ts).
  RecordMention,
]


// Markdown <-> JSONContent conversion lives in a React-free module so it
// can be unit-tested without pulling in Tiptap/Novel client components.
import {
  markdownToJSONContent,
  jsonContentToMarkdown,
  URL_REGEX,
  type ProposalChangeRef,
} from './markdown-conversion'

// --- Slash command items ---

function createSlashItems(onAIContinue: () => void): SuggestionItem[] {
  const cmd = (fn: (editor: Editor, range: Range) => void) => {
    return ({ editor, range }: { editor: Editor; range: Range }) => fn(editor, range)
  }

  return createSuggestionItems([
    {
      title: 'Heading 1',
      description: 'Big section heading.',
      searchTerms: ['title', 'big', 'large'],
      icon: <Heading1 size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run()
      }),
    },
    {
      title: 'Heading 2',
      description: 'Medium section heading.',
      searchTerms: ['subtitle', 'medium'],
      icon: <Heading2 size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run()
      }),
    },
    {
      title: 'Heading 3',
      description: 'Small section heading.',
      searchTerms: ['subtitle', 'small'],
      icon: <Heading3 size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run()
      }),
    },
    {
      title: 'Bullet List',
      description: 'Create a simple bullet list.',
      searchTerms: ['unordered', 'point'],
      icon: <List size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run()
      }),
    },
    {
      title: 'Numbered List',
      description: 'Create a list with numbering.',
      searchTerms: ['ordered'],
      icon: <ListOrdered size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run()
      }),
    },
    {
      title: 'To-do List',
      description: 'Track tasks with checkboxes.',
      searchTerms: ['todo', 'task', 'check', 'checkbox'],
      icon: <CheckSquare size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).toggleTaskList().run()
      }),
    },
    {
      title: 'Blockquote',
      description: 'Capture a quote.',
      searchTerms: ['quote'],
      icon: <TextQuote size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).toggleNode('paragraph', 'paragraph').toggleBlockquote().run()
      }),
    },
    {
      title: 'Code Block',
      description: 'Capture a code snippet.',
      searchTerms: ['codeblock'],
      icon: <Code size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
      }),
    },
    {
      title: 'Divider',
      description: 'Insert a horizontal divider.',
      searchTerms: ['hr', 'rule', 'line'],
      icon: <Minus size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run()
      }),
    },
    {
      title: 'Table',
      description: 'Insert a table.',
      searchTerms: ['table', 'grid', 'rows', 'columns'],
      icon: <TableIcon size={18} />,
      command: cmd((editor, range) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run()
      }),
    },
    {
      title: 'AI: Continue writing',
      description: 'Let AI continue from where you left off.',
      searchTerms: ['ai', 'continue', 'autocomplete', 'generate'],
      icon: <Sparkles size={18} />,
      command: cmd((editor, range) => {
        editor.chain().focus().deleteRange(range).run()
        onAIContinue()
      }),
    },
  ])
}

// --- Component ---

export interface EditorCommentSelection {
  text: string
  prefix: string
  suffix: string
  rect: DOMRect
}

export interface NoteEditorProps {
  /** Initial markdown content to load */
  initialContent: string
  /** Called with markdown string when content changes (debounced by parent) */
  onUpdate: (markdown: string) => void
  /** When true, editor is read-only (e.g., during AI streaming) */
  readOnly?: boolean
  /** When true, show the AI-activity indicator above the editor */
  isAIWriting?: boolean
  /** Optional label for the AI-activity indicator (e.g. "Writing the summary").
   *  Defaults to "AI is writing..." when omitted. */
  aiWritingLabel?: string
  /** When true, focus the editor on mount */
  autoFocus?: boolean
  /** Called when user clicks Comment in the bubble menu. Receives selection info. */
  onComment?: (selection: EditorCommentSelection) => void
  /** Additional Tiptap extensions to include */
  extraExtensions?: any[]
  /** Callback to receive the editor instance after creation */
  onEditorReady?: (editor: Editor) => void
  /**
   * External content update (e.g. from Supabase Realtime).
   * When this changes, the editor replaces its content in-place without remounting.
   * Does NOT trigger onUpdate (avoids save loops).
   */
  externalContent?: string
  /**
   * Handed `receiveExternal` on mount and `null` on unmount, so an owner
   * animating the content frame by frame can push each frame straight to the
   * editor without re-rendering itself; the final value still arrives through
   * `externalContent`, which no-ops because the sink already delivered it.
   * A value pushed here is handled exactly as if `externalContent` had changed
   * to it. (`RefObject` is mutable in React 19 — `MutableRefObject` is its
   * deprecated alias.)
   */
  externalContentSink?: React.RefObject<((markdown: string) => void) | null>
  /** Called when the user's text selection changes. Receives the selected text or null. */
  onSelectionChange?: (selectedText: string | null) => void
  className?: string
  /** Custom placeholder text (default: 'Start writing, or type / for commands...') */
  placeholder?: string
  /** Proposal change refs for resolving <!-- proposal:ID --> markers in markdown */
  proposalRefs?: ProposalChangeRef
  /** Read-aloud: a hover "play this section" button on headings and bold
   *  lead-ins (desktop only; see read-aloud-sections-extension). On by
   *  default; read once, when the editor is created. */
  readAloudSections?: boolean
}

export function NoteEditor({
  initialContent,
  onUpdate,
  readOnly = false,
  isAIWriting = false,
  aiWritingLabel,
  autoFocus = false,
  onComment,
  extraExtensions,
  onEditorReady,
  externalContent,
  externalContentSink,
  onSelectionChange,
  className,
  placeholder: placeholderText,
  proposalRefs,
  readAloudSections = true,
}: NoteEditorProps) {
  const [openNode, setOpenNode] = useState(false)
  const [openLink, setOpenLink] = useState(false)
  const editorRef = useRef<any>(null)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  // Track whether the user has made local edits since the last save
  const isDirtyRef = useRef(false)

  // Cancel pending debounce on unmount — do NOT flush, because the component
  // may be unmounting due to an action switch (key change), and flushing would
  // overwrite the new action's description with the old one's content.
  // The blur flush (handleDOMEvents.blur below) covers the common unmount paths
  // (clicking elsewhere blurs first); only keyboard-driven switches within 300ms
  // of the last keystroke can still drop that tail.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      isDirtyRef.current = false
    }
  }, [])

  // Keep proposalRefs ref current — must be declared before effects that use it
  const proposalRefsRef = useRef(proposalRefs)
  proposalRefsRef.current = proposalRefs

  // Track the last raw markdown received via externalContent so the proposalRefs
  // effect can re-parse from the original source (not the round-tripped editor content,
  // which loses unmatched markers).
  const lastRawMarkdownRef = useRef(initialContent)

  // Markdown strings this editor emitted via onUpdate. Every emission is saved by
  // the parent and round-trips back (PATCH response merged into entity state,
  // Supabase Realtime echo of the row UPDATE) as a changed externalContent /
  // initialContent prop ~1s later. Recognizing our own content when it bounces
  // back is what stops those echoes from replacing the document and destroying
  // keystrokes typed during the save round-trip.
  const recentEmissionsRef = useRef<string[]>([])
  const latestEmissionRef = useRef<string | null>(null)
  // True from the moment we emit until that exact string comes back through
  // externalContent/initialContent. While an emission is un-echoed the server
  // may not have our content yet, so no external value may replace the doc.
  // This is an explicit flag rather than a string comparison against
  // lastRawMarkdownRef — comparing against a baseline that incoming values
  // themselves overwrite would misclassify every foreign update as "we're
  // ahead" and leave the editor deaf to external writes.
  const unechoedEmissionRef = useRef(false)

  // Monotonic count of local edit transactions. Deferred external values record
  // the sequence at stash time; if the user typed after the value arrived, the
  // local edits supersede it (they're newer) and it must be dropped, not applied.
  const editSeqRef = useRef(0)

  // External value that arrived while it wasn't safe to replace the doc (caret
  // in the editor, mid-edit, or an emission still un-echoed). Reconciled on
  // blur / debounce-flush / echo-arrival via processDeferred.
  const pendingExternalRef = useRef<string | null>(null)
  const pendingSeqRef = useRef(0)
  const needsReparseRef = useRef(false)

  // The proposalRefs actually used for the last parse that produced the current
  // doc (mount memo, applyExternal, or reparseProposals). Lets the reparse
  // effect detect an unprocessed refs change even across the editor-creation gap.
  const lastParsedRefsRef = useRef(proposalRefs)

  // The markdown the last applyExternal replaced the doc with. A new external
  // value that strictly extends it is an animation frame (typewriter / reveal)
  // and skips the whole-document comparisons in receiveExternal. Null after
  // the initialContent reset (a different document).
  const lastAppliedExternalRef = useRef<string | null>(null)

  // Serialize + hand the current doc to the parent, remembering the emission for
  // self-echo suppression.
  const emitMarkdown = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editor.isDestroyed) return
    const markdown = jsonContentToMarkdown(editor.getJSON())
    const emissions = recentEmissionsRef.current
    emissions.push(markdown)
    if (emissions.length > 20) emissions.shift()
    latestEmissionRef.current = markdown
    unechoedEmissionRef.current = true
    onUpdateRef.current(markdown)
  }, [])

  // The editor holds content the external world hasn't confirmed yet: unflushed
  // keystrokes, a pending debounce, or an emission whose echo hasn't returned.
  // While locally ahead, external values must not replace the doc.
  const isLocallyAhead = useCallback(() => {
    return (
      isDirtyRef.current ||
      debounceRef.current !== null ||
      unechoedEmissionRef.current
    )
  }, [])

  const applyExternal = useCallback((markdown: string, preParsed?: JSONContent) => {
    const editor = editorRef.current
    if (!editor || editor.isDestroyed) return
    const newContent = preParsed ?? markdownToJSONContent(markdown, proposalRefsRef.current)
    // The doc is being reset to the external baseline — the fresh state has no
    // outstanding local claim.
    latestEmissionRef.current = null
    unechoedEmissionRef.current = false
    lastRawMarkdownRef.current = markdown
    lastAppliedExternalRef.current = markdown
    lastParsedRefsRef.current = proposalRefsRef.current
    // Defer setContent to avoid flushSync-during-render warning from ProseMirror
    queueMicrotask(() => {
      if (editor.isDestroyed) return
      setContentWithoutHistory(editor, newContent)
    })
  }, [])

  // Re-resolve proposal markers against the current proposalRefs. Source: the
  // raw baseline when it provably still matches the doc (it holds markers the
  // previous parse couldn't resolve — re-parsing resurrects them), otherwise the
  // CURRENT doc — a raw baseline that diverged from the doc is stale, and
  // re-applying it would revert content (local typing or an applied external).
  const reparseProposals = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editor.isDestroyed) return
    const newRefs = proposalRefsRef.current
    const oldRefs = lastParsedRefsRef.current
    lastParsedRefsRef.current = newRefs
    const docMd = jsonContentToMarkdown(editor.getJSON())
    const raw = lastRawMarkdownRef.current
    const canUseRaw =
      !isLocallyAhead() &&
      jsonContentToMarkdown(markdownToJSONContent(raw, oldRefs)) === docMd
    const source = canUseRaw ? raw : docMd
    const newContent = markdownToJSONContent(source, newRefs)
    // No-op when re-resolution changes nothing — a wholesale setContent remounts
    // every proposal nodeview and resets the selection.
    if (JSON.stringify(newContent) === JSON.stringify(editor.getJSON())) return
    queueMicrotask(() => {
      if (editor.isDestroyed) return
      // Restore the caret when this fires under focus (the live-recording norm:
      // the summary editor is autofocused for the whole meeting). Proposal
      // re-resolution only swaps markers→atoms and appends unmatched atoms at
      // the end of the doc, so prior positions survive; clamping guards the
      // rest.
      const hadFocus = editor.isFocused
      const { from, to } = editor.state.selection
      setContentWithoutHistory(editor, newContent)
      if (hadFocus) {
        const max = editor.state.doc.content.size
        editor.commands.setTextSelection({
          from: Math.min(from, max),
          to: Math.min(to, max),
        })
      }
    })
  }, [isLocallyAhead])

  // Reconcile deferred external state once it's safe: keeps the value while the
  // editor is focused or locally ahead (retried on the next blur/echo), drops it
  // if local edits arrived after it (they supersede it), applies it otherwise.
  const processDeferred = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editor.isDestroyed) return
    if (editor.isFocused) return
    const pending = pendingExternalRef.current
    if (pending !== null) {
      if (editSeqRef.current !== pendingSeqRef.current) {
        // The user typed after this value arrived — local edits win; the
        // autosave persists them over it.
        pendingExternalRef.current = null
      } else if (!isLocallyAhead()) {
        pendingExternalRef.current = null
        needsReparseRef.current = false
        const currentMd = jsonContentToMarkdown(editor.getJSON())
        if (currentMd !== pending) {
          const parsed = markdownToJSONContent(pending, proposalRefsRef.current)
          if (jsonContentToMarkdown(parsed) !== currentMd) {
            applyExternal(pending, parsed)
          } else {
            lastParsedRefsRef.current = proposalRefsRef.current
          }
        }
        return
      }
      // else: an emission is still un-echoed — keep the pending value; the echo
      // triggers another processDeferred.
    }
    if (needsReparseRef.current) {
      needsReparseRef.current = false
      reparseProposals()
    }
  }, [isLocallyAhead, applyExternal, reparseProposals])

  // Shared handling for an own-emission bounce arriving through either prop
  // pathway: sync the echo flag, discard a deferred value that is itself one of
  // our own stale echoes, and give a surviving foreign deferred value a chance
  // to land now that the baseline caught up.
  const absorbOwnEcho = useCallback((incoming: string) => {
    if (incoming === latestEmissionRef.current) unechoedEmissionRef.current = false
    const pending = pendingExternalRef.current
    if (
      pending !== null &&
      // A pending value that is a PREFIX of our echo is an animation frame of
      // our own content (revealSummary / typewriter slices) — stale by
      // construction; applying it later would truncate the doc's tail.
      (pending === incoming || incoming.startsWith(pending) || recentEmissionsRef.current.includes(pending))
    ) {
      pendingExternalRef.current = null
    }
    // Self-heal: "own echo → doc already contains it" can be violated when
    // animation frames (applied as foreign prefixes) overwrote the doc. When
    // idle and fully echoed, restore the full content the echo carries — but
    // ONLY on the truncation signature (doc is a strict prefix of the echo and
    // no newer emission is outstanding). Anything broader lets a LATE echo of
    // an old save revert genuinely newer content (an applied AI edit, or a
    // deletion the user just made).
    const editor = editorRef.current
    if (editor && !editor.isDestroyed && !editor.isFocused && !isLocallyAhead()) {
      const currentMd = jsonContentToMarkdown(editor.getJSON())
      if (
        currentMd !== incoming &&
        incoming.startsWith(currentMd) &&
        (latestEmissionRef.current === null || incoming === latestEmissionRef.current)
      ) {
        applyExternal(incoming)
      }
    }
    if (pendingExternalRef.current !== null || needsReparseRef.current) processDeferred()
  }, [isLocallyAhead, applyExternal, processDeferred])

  // External content update (e.g. from Supabase Realtime after an AI edit).
  // Replaces editor content in-place without remounting or triggering onUpdate.
  // Values arrive through the `externalContent` prop (the effect below) or,
  // for an owner animating frame by frame, straight through
  // `externalContentSink`; both land in receiveExternal.
  const externalContentRef = useRef(externalContent)
  // The owner's most recent external value from EITHER path — what the
  // `externalContent` prop would read if every sink frame had gone through
  // React. The initialContent effect reads this instead of the prop, which
  // lags while an owner pushes frames through the sink.
  const latestExternalRef = useRef(externalContent)
  const receiveExternal = useCallback((markdown: string) => {
    latestExternalRef.current = markdown
    const editor = editorRef.current
    if (!editor) return
    // Skip the initial render (externalContent will match initialContent).
    // Exception: an empty string is a deliberate CLEAR signal (e.g. a batch
    // stream resetting the editor before typing the new summary). Don't let the
    // ref-equality fast-path swallow it — fall through to the actual-content
    // check below (line: currentMd === markdown), which no-ops correctly
    // if the editor is genuinely already empty.
    if (markdown !== '' && externalContentRef.current === markdown) return
    externalContentRef.current = markdown
    lastRawMarkdownRef.current = markdown

    // Own-save echo: this exact string left the editor via onUpdate and came back
    // through the server. The doc already contains it (or something newer).
    if (recentEmissionsRef.current.includes(markdown)) {
      absorbOwnEcho(markdown)
      return
    }

    // Never replace the document while the user has the caret in the editor or
    // holds locally-ahead content — stash the value; processDeferred reconciles
    // it on blur / debounce-flush / echo-arrival.
    if (editor.isFocused || isLocallyAhead()) {
      pendingExternalRef.current = markdown
      pendingSeqRef.current = editSeqRef.current
      return
    }

    // An animation frame: the text is the last applied external text plus more.
    // Nothing but this path has touched the doc since (a local edit would have
    // made us locally ahead), so the two whole-document round trips below could
    // only ever say "changed" — go straight to the parse. (The one exception is
    // a frame whose extra text the parser drops, e.g. a trailing newline: the
    // round trips would call it in sync, and this re-applies an equal doc,
    // which renders exactly as before.)
    const applied = lastAppliedExternalRef.current
    if (applied !== null && markdown.length > applied.length && markdown.startsWith(applied)) {
      applyExternal(markdown)
      return
    }

    const currentMd = jsonContentToMarkdown(editor.getJSON())
    if (currentMd === markdown) return // Already in sync
    // Normalization-only difference: external markdown not authored by this
    // serializer (blank lines, bullet style, emphasis delimiters) round-trips to
    // the same doc — replacing anyway would just remount nodeviews and drop the
    // selection for nothing.
    const parsed = markdownToJSONContent(markdown, proposalRefsRef.current)
    if (jsonContentToMarkdown(parsed) === currentMd) {
      lastParsedRefsRef.current = proposalRefsRef.current
      return
    }

    applyExternal(markdown, parsed)
  }, [isLocallyAhead, applyExternal, absorbOwnEcho])

  useEffect(() => {
    if (externalContent === undefined) {
      latestExternalRef.current = undefined
      return
    }
    receiveExternal(externalContent)
    // Stable callbacks (refs only) intentionally excluded from deps — this effect
    // is driven by externalContent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalContent])

  // Hand receiveExternal to an owner that animates the content (see the
  // `externalContentSink` prop). receiveExternal is stable, so this runs once
  // per mount.
  useEffect(() => {
    if (!externalContentSink) return
    externalContentSink.current = receiveExternal
    return () => {
      externalContentSink.current = null
    }
  }, [externalContentSink, receiveExternal])

  // Reset the document when `initialContent` changes to a genuinely different
  // value. The editor only reads initialContent ONCE (the [] memo below + the
  // EditorContent onCreate), so without this an in-place swap of the underlying
  // entity — e.g. starting a NEW capture while a capture panel is open, where the
  // panel/editor isn't fully remounted — leaves the OLD body rendered even though
  // title/state already updated.
  const initialContentRef = useRef(initialContent)
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (initialContentRef.current === initialContent) return
    initialContentRef.current = initialContent
    // The current external value. Equal to the `externalContent` prop (its
    // effect above has already run for this commit) unless the owner has
    // pushed newer frames through `externalContentSink`, which the prop lags.
    const external = latestExternalRef.current

    // Own-content bounce: parent state caught up with what we emitted (save
    // responses get merged into entity state, which re-derives this prop). Sync
    // the baseline and leave the doc alone.
    if (recentEmissionsRef.current.includes(initialContent)) {
      lastRawMarkdownRef.current = initialContent
      externalContentRef.current = external
      absorbOwnEcho(initialContent)
      return
    }

    // When the same value is simultaneously flowing through externalContent
    // (Realtime handlers set both in one commit), let that pathway own it — but
    // only when the externalContent effect will actually process it (the prop
    // value is new to it). If externalContentRef already equals the value, that
    // effect's fast-path will skip, and bailing here too would leave a foreign
    // write that round-tripped back to a previously-seen string permanently
    // unapplied.
    if (
      external !== undefined &&
      initialContent === external &&
      externalContentRef.current !== external
    ) return

    // A genuinely different document for the SAME entity (fresh fetch after a
    // stale cache, live-agent write mid-meeting). Every consumer keys the editor
    // by entity id, so entity swaps remount and never reach this path — which
    // makes deferring around active typing safe: the blur flush always saves to
    // this same entity's handler.
    lastRawMarkdownRef.current = initialContent
    if (editor.isFocused || isLocallyAhead()) {
      pendingExternalRef.current = initialContent
      pendingSeqRef.current = editSeqRef.current
      return
    }
    externalContentRef.current = external

    const currentMd = jsonContentToMarkdown(editor.getJSON())
    if (currentMd === initialContent) return // already in sync
    const parsed = markdownToJSONContent(initialContent, proposalRefsRef.current)
    if (jsonContentToMarkdown(parsed) === currentMd) {
      lastParsedRefsRef.current = proposalRefsRef.current
      return
    }
    applyExternal(initialContent, parsed)
    // A different document: the next external frame takes receiveExternal's
    // full comparison path rather than the strict-extension shortcut.
    lastAppliedExternalRef.current = null
    // Stable callbacks intentionally excluded from deps — this effect is driven
    // by initialContent changes (the external value is read from a ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent])

  // Re-parse editor content when proposalRefs change (e.g., new proposals arrive via Realtime).
  useEffect(() => {
    if (lastParsedRefsRef.current === proposalRefs) return

    const editor = editorRef.current
    // Editor not created yet — onCreate reconciles against lastParsedRefsRef.
    if (!editor) return
    if (isLocallyAhead()) {
      // Unsaved local divergence — a re-parse rebuilds the doc from a baseline
      // that would lose those edits. Defer to blur (processDeferred).
      needsReparseRef.current = true
      return
    }
    if (editor.view.composing) {
      // Mid-IME-composition (CJK, dead keys, etc.): a setContent would discard
      // the in-flight composition. Defer — compositionend triggers a blur/echo
      // path, and needsReparse is flushed by processDeferred.
      needsReparseRef.current = true
      return
    }
    // Focused-but-clean is the live-recording norm (the summary editor is
    // autofocused for the entire meeting), and it used to defer here too —
    // which made proposals staged mid-meeting invisible until the user
    // happened to blur the editor. With no local divergence a re-parse only
    // re-resolves proposal atoms (reparseProposals restores the caret and
    // no-ops when nothing changed), so it's safe to run under focus.
    reparseProposals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalRefs])

  // Selection change reporting for AI context
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const initialJSONContent = useMemo(
    () => markdownToJSONContent(initialContent, proposalRefs),
    // Only compute on initial mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // AI continue writing handler: /api/ai/complete streams the continuation as
  // plain text, and each chunk goes into the editor as it arrives.
  const handleAIContinue = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return

    const currentMarkdown = jsonContentToMarkdown(editor.getJSON())
    if (!currentMarkdown.trim()) return

    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      // Move cursor to end and insert from there
      editor.commands.focus('end')

      const res = await fetch('/api/ai/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ context: currentMarkdown }),
      })
      if (!res.ok || !res.body) throw new Error(`Completion request failed: ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        if (chunk) editor.commands.insertContent(chunk)
      }

      // Trigger an update after streaming is complete
      emitMarkdown()
    } catch (err) {
      console.error('AI continue writing error:', err)
    }
  }, [emitMarkdown])

  const suggestionItems = useMemo(
    () => createSlashItems(handleAIContinue),
    [handleAIContinue],
  )

  const slashCommand = useMemo(
    () =>
      Command.configure({
        suggestion: {
          items: () => suggestionItems,
          render: renderItems,
        },
      }),
    [suggestionItems],
  )

  // Read-aloud sections (hover a heading → play that section; desktop only).
  // One per editor, created with it; no Play buttons while the AI writes in.
  const isAIWritingRef = useRef(isAIWriting)
  isAIWritingRef.current = isAIWriting
  const readAloudSectionsExtension = useMemo(
    () =>
      readAloudSections
        ? [ReadAloudSections.configure({ isStreaming: () => isAIWritingRef.current })]
        : [],
    // Read at creation, like the rest of the extension list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const extensions = useMemo(
    () => {
      if (placeholderText) {
        const filtered = defaultExtensions.filter((ext) => ext.name !== 'placeholder')
        const customPlaceholder = Placeholder.configure({
          placeholder: ({ node, editor }) => {
            if (node.type.name === 'paragraph' && editor.isEmpty) {
              return placeholderText!
            }
            return ''
          },
          showOnlyCurrent: true,
          emptyEditorClass: 'is-editor-empty',
          emptyNodeClass: 'is-empty',
          includeChildren: false,
        })
        return [
          ...filtered,
          customPlaceholder,
          slashCommand,
          ...readAloudSectionsExtension,
          ...(extraExtensions || []),
        ]
      }
      return [...defaultExtensions, slashCommand, ...readAloudSectionsExtension, ...(extraExtensions || [])]
    },
    [slashCommand, readAloudSectionsExtension, extraExtensions, placeholderText],
  )

  return (
    <div className={className}>
      {isAIWriting && (
        <div
          data-onboarding-target="ai-writing"
          className="flex items-center gap-2 px-1 pb-2"
        >
          <OrbLoader state="composing" size="sm" />
          <span className="text-xs text-muted-foreground">
            {aiWritingLabel ? `${aiWritingLabel}…` : 'AI is writing...'}
          </span>
        </div>
      )}
      <EditorRoot>
        <EditorContent
          extensions={extensions}
          initialContent={initialJSONContent}
          editable={!readOnly}
          onCreate={({ editor }) => {
            editorRef.current = editor
            // proposalRefs may have changed between the mount-time parse and the
            // (async) editor creation — the effect couldn't act without an
            // editor, so reconcile here. No-ops when nothing changed.
            if (lastParsedRefsRef.current !== proposalRefsRef.current) {
              reparseProposals()
            }
            onEditorReady?.(editor)
            if (autoFocus) {
              setTimeout(() => editor.commands.focus('end'), 0)
            }
          }}
          onSelectionUpdate={({ editor }) => {
            if (!onSelectionChangeRef.current) return
            const { from, to } = editor.state.selection
            if (from === to) {
              onSelectionChangeRef.current(null)
            } else {
              const text = editor.state.doc.textBetween(from, to, ' ')
              onSelectionChangeRef.current(text || null)
            }
          }}
          onUpdate={({ editor }) => {
            editorRef.current = editor
            isDirtyRef.current = true
            editSeqRef.current += 1
            // Debounce the expensive getJSON + markdown conversion
            // so it doesn't run on every keystroke
            if (debounceRef.current) clearTimeout(debounceRef.current)
            debounceRef.current = setTimeout(() => {
              debounceRef.current = null
              isDirtyRef.current = false
              emitMarkdown()
              // A deferred external value / re-parse may have been stashed while
              // typing — reconcile now (no-op if the caret is still in the editor).
              processDeferred()
            }, 300)
          }}
          editorProps={{
            handleDOMEvents: {
              keydown: (_view, event) => handleCommandNavigation(event),
              blur: () => {
                // Flush un-emitted edits so clicking away never strands the last
                // <300ms of typing.
                if (debounceRef.current) {
                  clearTimeout(debounceRef.current)
                  debounceRef.current = null
                  isDirtyRef.current = false
                  emitMarkdown()
                }
                // Reconcile deferred state on the NEXT macrotask: a blur caused
                // by a bubble-menu/slash-menu click must let that command run
                // against the document it was invoked on before any replace.
                setTimeout(() => processDeferred(), 0)
                return false
              },
            },
            handlePaste: (view, event) => {
              const text = event.clipboardData?.getData('text/plain')?.trim()
              if (!text || !URL_REGEX.test(text)) return false
              // A card on an empty line, else a link where it was pasted.
              const tr = pasteUrlTransaction(view.state, text)
              if (!tr) return false
              view.dispatch(tr)
              return true
            },
            attributes: {
              class:
                'prose prose-sm dark:prose-invert prose-headings:font-semibold focus:outline-none max-w-full min-h-[200px] [overflow-wrap:anywhere]',
            },
          }}
          immediatelyRender={false}
          className="relative"
        >
          {/* Slash command menu */}
          <EditorCommand className="z-50 h-auto max-h-[330px] w-72 overflow-y-auto rounded-md border border-muted bg-background px-1 py-2 shadow-md transition-all">
            <EditorCommandEmpty className="px-2 text-muted-foreground">
              No results
            </EditorCommandEmpty>
            <EditorCommandList>
              {suggestionItems.map((item) => (
                <EditorCommandItem
                  value={item.title}
                  onCommand={(val) => item.command?.(val)}
                  className="flex w-full items-center space-x-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent aria-selected:bg-accent"
                  key={item.title}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-md border border-muted bg-background">
                    {item.icon}
                  </div>
                  <div>
                    <p className="font-medium">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                </EditorCommandItem>
              ))}
            </EditorCommandList>
          </EditorCommand>

          {/* Bubble menu on text selection.
              shouldShow: Tiptap's default implementation returns false when
              the editor isn't editable, which hides the menu in read-only
              contexts like the public share view. We override so any
              non-empty selection inside the editor shows the bubble —
              specifically so "Add comment" is reachable on shared captures. */}
          <EditorBubble
            tippyOptions={{ placement: 'top' }}
            className="flex w-fit max-w-[90vw] items-center overflow-hidden rounded border border-muted bg-background shadow-xl"
            shouldShow={({ state, from, to }) => {
              if (from === to) return false
              // A multi-cell drag is a CellSelection — defer to the table menu
              // so the user gets table controls, not text-format buttons.
              if (state.selection instanceof CellSelection) return false
              const text = state.doc.textBetween(from, to, ' ').trim()
              return text.length > 0
            }}
          >
            {/* Formatting buttons are write-actions — hide in read-only mode
                so the bubble shrinks down to just the "comment" affordance. */}
            {!readOnly && <TextFormatButtons />}
            {onComment && (
              <>
                {!readOnly && <div className="mx-0.5 h-5 w-px bg-border" />}
                <EditorBubbleItem
                  onSelect={(editor) => {
                    const { from, to } = editor.state.selection
                    const selectedText = editor.state.doc.textBetween(from, to, ' ')
                    if (!selectedText.trim()) return

                    // Get full text for prefix/suffix context. `from`/`to` are
                    // doc positions (they count node boundaries), so map them to
                    // offsets in textContent — the string the highlight
                    // extension searches — before slicing.
                    const doc = editor.state.doc
                    const fullText = doc.textContent
                    const startOff = doc.textBetween(0, from, '').length
                    const endOff = doc.textBetween(0, to, '').length
                    const prefix = fullText.slice(Math.max(0, startOff - 50), startOff)
                    const suffix = fullText.slice(endOff, Math.min(fullText.length, endOff + 50))

                    // Get the DOM selection rect
                    const domSel = window.getSelection()
                    if (!domSel || domSel.rangeCount === 0) return
                    const rect = domSel.getRangeAt(0).getBoundingClientRect()
                    if (rect.width === 0 && rect.height === 0) return

                    onComment({
                      text: selectedText.slice(0, 1000),
                      prefix,
                      suffix,
                      rect,
                    })
                  }}
                >
                  <Button size="icon" variant="ghost" className="h-8 w-8 rounded-none" title="Add comment">
                    <MessageSquarePlus className="h-4 w-4" />
                  </Button>
                </EditorBubbleItem>
              </>
            )}
          </EditorBubble>

          {/* Table controls — a separate bubble (own pluginKey) that shows
              when editing a table: either the cursor sits in a cell with no
              text selected, or multiple cells are selected (a CellSelection
              from a drag). Both cases are mutually exclusive with the
              text-format/comment bubble above (which needs a non-empty text
              selection that is NOT a CellSelection), so the two never stack.
              Write-only — hidden in read-only contexts. */}
          {!readOnly && (
            <EditorBubble
              pluginKey="tableMenu"
              tippyOptions={{ placement: 'top' }}
              className="flex w-fit max-w-[90vw] items-center gap-0.5 overflow-x-auto rounded border border-muted bg-background p-0.5 shadow-xl"
              shouldShow={({ editor, state, from, to }) => {
                if (!editor.isActive('table')) return false
                // Multiple cells selected (drag) → show table controls.
                if (state.selection instanceof CellSelection) return true
                // Plain cursor in a cell (no text selected) → show controls.
                // A text selection within a single cell defers to the text menu.
                return from === to && !state.doc.textBetween(from, to, ' ').trim()
              }}
            >
              <TableMenuButtons />
            </EditorBubble>
          )}
        </EditorContent>
      </EditorRoot>
    </div>
  )
}

// --- Bubble menu text format buttons ---

function TextFormatButtons() {
  const items = [
    {
      name: 'bold',
      icon: BoldIcon,
      isActive: (editor: any) => editor.isActive('bold'),
      command: (editor: any) => editor.chain().focus().toggleBold().run(),
    },
    {
      name: 'italic',
      icon: ItalicIcon,
      isActive: (editor: any) => editor.isActive('italic'),
      command: (editor: any) => editor.chain().focus().toggleItalic().run(),
    },
    {
      name: 'strike',
      icon: StrikethroughIcon,
      isActive: (editor: any) => editor.isActive('strike'),
      command: (editor: any) => editor.chain().focus().toggleStrike().run(),
    },
    {
      name: 'code',
      icon: CodeIcon,
      isActive: (editor: any) => editor.isActive('code'),
      command: (editor: any) => editor.chain().focus().toggleCode().run(),
    },
  ]

  return (
    <div className="flex">
      {items.map((item) => (
        <EditorBubbleItem
          key={item.name}
          onSelect={(editor) => item.command(editor)}
        >
          <Button size="icon" variant="ghost" className="h-8 w-8 rounded-none">
            <item.icon className="h-4 w-4" />
          </Button>
        </EditorBubbleItem>
      ))}
    </div>
  )
}

// --- Table controls (shown when the cursor is inside a table) ---

function TableButton({
  icon: Icon,
  title,
  onClick,
  disabled,
  active,
  destructive,
}: {
  icon: typeof Columns3
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  destructive?: boolean
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className={cx(
        'h-8 w-8 shrink-0 rounded',
        active && 'bg-accent',
        destructive && 'text-destructive hover:text-destructive',
      )}
      title={title}
      disabled={disabled}
      // Prevent the bubble from losing the editor selection on mousedown,
      // which would disable table commands before the click fires.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
    </Button>
  )
}

function TableMenuDivider() {
  return <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
}

function TableMenuButtons() {
  const { editor } = useEditor()
  if (!editor) return null

  const align = (value: 'left' | 'center' | 'right') =>
    editor.chain().focus().setTextAlign(value).run()

  return (
    <>
      {/* Columns */}
      <TableButton
        icon={ArrowLeftToLine}
        title="Add column before"
        onClick={() => editor.chain().focus().addColumnBefore().run()}
      />
      <TableButton
        icon={ArrowRightToLine}
        title="Add column after"
        onClick={() => editor.chain().focus().addColumnAfter().run()}
      />
      <TableButton
        icon={Columns3}
        title="Delete column"
        destructive
        onClick={() => editor.chain().focus().deleteColumn().run()}
      />

      <TableMenuDivider />

      {/* Rows */}
      <TableButton
        icon={ArrowUpToLine}
        title="Add row above"
        onClick={() => editor.chain().focus().addRowBefore().run()}
      />
      <TableButton
        icon={ArrowDownToLine}
        title="Add row below"
        onClick={() => editor.chain().focus().addRowAfter().run()}
      />
      <TableButton
        icon={Rows3}
        title="Delete row"
        destructive
        onClick={() => editor.chain().focus().deleteRow().run()}
      />

      <TableMenuDivider />

      {/* Alignment */}
      <TableButton
        icon={AlignLeft}
        title="Align left"
        active={editor.isActive({ textAlign: 'left' })}
        onClick={() => align('left')}
      />
      <TableButton
        icon={AlignCenter}
        title="Align center"
        active={editor.isActive({ textAlign: 'center' })}
        onClick={() => align('center')}
      />
      <TableButton
        icon={AlignRight}
        title="Align right"
        active={editor.isActive({ textAlign: 'right' })}
        onClick={() => align('right')}
      />

      <TableMenuDivider />

      {/* Delete table */}
      <TableButton
        icon={Trash2}
        title="Delete table"
        destructive
        onClick={() => editor.chain().focus().deleteTable().run()}
      />
    </>
  )
}


// Re-export types for existing consumers that import them from this module.
export type { ProposalChangeRef }
