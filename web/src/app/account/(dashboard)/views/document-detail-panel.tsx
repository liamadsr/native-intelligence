'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { usePanelSection } from './use-panel-section'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  FileText,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  User,
  Trash2,
  Plus,
  Circle,
  X,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ReferencedIn } from '@/components/entity-links/referenced-in'
import { RecordHistory } from '@/components/entity-links/record-history'
import { composeSectionChoice, conflictingSections, patchDocumentFields, planConflict, rollbackPatch, snapshotKeys, unmountAction, type ConflictPlan } from './document-field-save'
import { merge3 } from '@/lib/documents/line-diff'
import { describeRevisionAuthor, type RevisionSummary } from '@/lib/documents/revision-format'
import { SYSTEM_DOCUMENT_REFUSAL } from '@/lib/documents/system-document'
import { NoteEditor } from './note-editor-lazy'
import { formatCaptureDate } from './capture-utils'
import { ShareDialog } from '../components/share-dialog'
import {
  VisibilityControl,
  canOfferVisibilityControl,
  useVisibilityViewer,
  type Visibility,
} from '../components/visibility-control'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { emitEntityUpdated } from '@/lib/entity-events'
import { EntityActionsMenu, PANEL_OMIT } from '@/components/entities/entity-actions-menu'
import { CopyDocumentButton } from '../components/copy-document-button'
import { ListenTarget } from '@/components/read-aloud/listen-target'
import { titledMarkdownToSentences } from '@/lib/read-aloud/speech-text'
import { MoveToWorkspaceButton } from '@/components/move/move-to-workspace-button'
import { InlineCommentProvider } from '@/components/inline-comments/inline-comment-context'
import { AnnotatedContent } from '@/components/inline-comments/annotated-content'
import { SelectionPopover } from '@/components/inline-comments/selection-popover'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { ProjectPanelField, type ProjectOption as PickerProjectOption } from '@/components/views/properties'
import { ActivityRow } from '@/components/views/activity-row'
import { InlineCommentPopover } from '@/components/inline-comments/inline-comment-popover'
import { CommentableEditor } from '@/components/inline-comments/commentable-editor'
import { createAuthenticatedAPI, mapAuthComments } from '@/components/inline-comments/adapters'
import type { UnifiedComment, CommentIdentity } from '@/components/inline-comments/types'
import { useEntityDetailSync } from '@/hooks/use-entity-sync'
import { ProposalNodeExtension } from '@/components/capture/proposal-node-extension'
import { useSuggestionHome } from '@/components/suggestions/suggestions-store'
import type { ProposalChangeRef } from './markdown-conversion'
import { EntityRefDecorations } from '@/components/entity-refs/entity-ref-tiptap'
import { StaleSectionsNote, type StaleSectionMark } from '@/components/documents/stale-sections-note'
import {
  EntityRefDocPopover,
  type EntityRefClickTarget,
} from '@/components/entity-refs/entity-ref-doc-popover'

interface ProjectOption {
  id: string
  name: string
}

interface LinkedAction {
  link_id: string
  id: string
  identifier: string
  title: string
  status_name: string | null
  status_color: string | null
}

interface ActionOption {
  id: string
  identifier: string
  title: string
}

interface DocumentDetail {
  id: string
  title: string
  content: string | null
  project_id: string | null
  project_name: string | null
  team_id: string | null
  created_by_name: string | null
  status: string
  is_pinned: boolean
  created_at: string
  updated_at: string
  /** Goes up on every change to the text (migration 364); saves name it. */
  revision?: number
  /** Who may change it (migration 359); absent on an older response = allowed. */
  can_edit?: boolean
  can_delete?: boolean
  /** Owner/admin or the creator: may move it between projects. */
  can_set_project?: boolean
  /** A system document (migration 366): edited as usual, never deleted. */
  is_system?: boolean
  /** Its creator's member id. */
  created_by?: string | null
  /** "Workspace" or "Only me" (migration 369); absent on an older response = workspace. */
  visibility?: Visibility
  /** document.kind (migrations 367, 440): 'now' is the person's Now file, always theirs alone. */
  kind?: string
  /** A canon document's sections unchecked for 90 days (canon D3): the quiet marker under the title. */
  stale_sections?: StaleSectionMark[]
}

/** Shown under the title when the document is read-only for this person. */
const READ_ONLY_NOTE = 'Only the creator or an admin can edit this'

/** The person's save lost to a newer change (409): what they choose between. */
interface EditConflict {
  plan: Exclude<ConflictPlan, { kind: 'save' }>
  /** The document now, and its revision. */
  theirs: string
  revision: number
  /** Who made the newer change ("Dial8 (for Ana)"), when the history says. */
  by: string | null
}

/** Markdown as the editor writes it, so formatting alone never reads as an edit. */
async function editorMarkdown(markdown: string): Promise<string> {
  const { markdownToJSONContent, jsonContentToMarkdown } = await import('./markdown-conversion')
  return jsonContentToMarkdown(markdownToJSONContent(markdown))
}

// ── Document detail cache ─────────────────────────────────────
const documentDetailCache = new Map<string, DocumentDetail>()
const DOC_CACHE_MAX = 20

function writeDocCache(id: string, data: DocumentDetail) {
  documentDetailCache.set(id, data)
  if (documentDetailCache.size > DOC_CACHE_MAX) {
    const oldest = documentDetailCache.keys().next().value
    if (oldest) documentDetailCache.delete(oldest)
  }
}

// Overview = the document; Agents = every agent interaction with it (plan row
// 12); History = every version of its text (migration 364). The Overview stays
// mounted while the others show, so the editor, its comments and its channels
// are not torn down.
const DOCUMENT_SECTIONS = ['overview', 'agents', 'history'] as const
const SECTION_LABELS: Record<(typeof DOCUMENT_SECTIONS)[number], string> = {
  overview: 'Overview',
  agents: 'Agents',
  history: 'History',
}
type DocumentSection = (typeof DOCUMENT_SECTIONS)[number]

const EntityActivitySection = dynamic(
  () => import('@/components/work/entity-activity-tab').then((m) => m.EntityActivitySection),
  { ssr: false },
)

const DocumentHistory = dynamic(() => import('@/components/documents/document-history').then((m) => m.DocumentHistory), {
  ssr: false,
})

export function DocumentDetailPanel({
  documentId,
  section,
  onSectionChange,
  onClose,
  onDeleted,
  onSelectionChange,
  onOpenEntity,
}: {
  documentId: string
  /** Active inner tab, restored from navigation history. */
  section?: string
  /** Switch the inner tab — pushes a history step so Back returns to the prior tab. */
  onSectionChange?: (section: string) => void
  onClose: () => void
  onDeleted?: () => void
  onSelectionChange?: (selection: { entityType: 'document'; entityId: string; field: string; selectedText: string } | null) => void
  /** Opens another entity in the host's navigation (project, initiative, …).
   *  Mount sites that don't wire this simply don't get the open affordance. */
  onOpenEntity?: (entityType: string, id: string, title: string, event?: React.MouseEvent) => void
}) {
  const cached = documentDetailCache.get(documentId)
  const [doc, setDoc] = useState<DocumentDetail | null>(cached ?? null)
  // Who may be offered "Workspace / Only me": the creator, in a shared
  // workspace (the capture rule, visibility-control.tsx).
  const { currentId: currentWorkspaceId } = useWorkspaces()
  const { memberId: viewerMemberId, memberCount: workspaceMemberCount } = useVisibilityViewer(currentWorkspaceId)
  // Suggestions staged into this document (a brief's, a chat's): their
  // `<!-- proposal:ID -->` markers render as cards, kept live by the store.
  // Pending ones the text doesn't place are appended at the end, as on the
  // capture page, so none is lost.
  const docSuggestions = useSuggestionHome(`document:${documentId}`)
  const suggestionRefs = useMemo<ProposalChangeRef | undefined>(() => {
    if (docSuggestions.length === 0) return undefined
    return {
      byIndex: new Map(),
      byId: new Map(docSuggestions.map((s) => [s.id, s.id])),
      allIds: docSuggestions.filter((s) => s.status === 'pending').map((s) => s.id),
    }
  }, [docSuggestions])
  const [loading, setLoading] = useState(!cached)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<'delete' | 'system' | null>(null)
  const [deleting, setDeleting] = useState(false)
  const titleInputRef = useRef<HTMLTextAreaElement>(null)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null)
  const latestContentRef = useRef<string | null>(null)
  // Compare-and-swap (migration 364): the revision the editor's text is based
  // on, and that text. They move only with this panel's own saves (and a load
  // or a conflict it resolved), never with a realtime refetch: the editor may
  // hold back an incoming change while the person types, so a refetch doesn't
  // prove the editor holds it.
  const baseRevisionRef = useRef<number | null>(cached?.revision ?? null)
  const baseContentRef = useRef<string>(cached?.content ?? '')
  const inFlightRef = useRef(0)
  const refetchAfterSaveRef = useRef(false)
  const conflictRef = useRef(false)
  const [conflict, setConflict] = useState<EditConflict | null>(null)
  // Bumped to remount the editor on a resolved conflict, so it holds exactly
  // the text that was saved.
  const [editorEpoch, setEditorEpoch] = useState(0)

  // Projects for picker
  const [projects, setProjects] = useState<ProjectOption[]>([])

  // Inject the document's current project so it renders immediately, even before
  // the projects lookup list finishes loading.
  const docProjectId = doc?.project_id ?? null
  const docProjectName = doc?.project_name ?? null
  const projectOptions = useMemo<PickerProjectOption[]>(() => {
    const list: PickerProjectOption[] = projects.map((p) => ({ id: p.id, name: p.name, icon: null }))
    if (docProjectId && docProjectName && !list.some((p) => p.id === docProjectId)) {
      list.unshift({ id: docProjectId, name: docProjectName, icon: null })
    }
    return list
  }, [projects, docProjectId, docProjectName])

  // Linked actions
  const [linkedActions, setLinkedActions] = useState<LinkedAction[]>([])
  const [allActions, setAllActions] = useState<ActionOption[]>([])
  const [actionSearchOpen, setActionSearchOpen] = useState(false)
  const [linkedActionsExpanded, setLinkedActionsExpanded] = useState(false)

  // Sidebar toggle
  // The page-level inspector owns visibility; standalone panels use their width.
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const sidebarOpen = usePropertiesVisible(panelBodyRef)
  const [activeSection, setActiveSection] = usePanelSection<DocumentSection>(section, onSectionChange, 'overview', DOCUMENT_SECTIONS)


  // Fetch projects for picker
  useEffect(() => {
    fetch('/api/account/projects')
      .then((r) => r.json())
      .then((d) => {
        const list = (d.projects || [])
          .filter((p: { name: string }) => p.name !== '__default__')
          .map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))
        setProjects(list)
      })
      .catch(() => {})
  }, [])

  // Fetch linked actions
  useEffect(() => {
    fetch(`/api/account/documents/${documentId}/actions`)
      .then((r) => r.json())
      .then((d) => setLinkedActions(d.actions || []))
      .catch(() => {})
  }, [documentId])

  // Fetch all actions for the picker
  useEffect(() => {
    fetch('/api/account/actions')
      .then((r) => r.json())
      .then((d) => {
        const actions = (d.actions || []).map((a: { id: string; identifier: string; title: string }) => ({
          id: a.id,
          identifier: a.identifier,
          title: a.title,
        }))
        setAllActions(actions)
      })
      .catch(() => {})
  }, [])

  // Inline commenting state
  const [inlineComments, setInlineComments] = useState<UnifiedComment[]>([])
  const [commentIdentity, setCommentIdentity] = useState<CommentIdentity | null>(null)

  // External content for live editor updates (from AI edit tool results)
  const [externalEditorContent, setExternalEditorContent] = useState<string | undefined>(undefined)

  // Live identifier chips in the document body (plan Phase 1). The TipTap
  // extension underlines resolved identifiers and reports a click + its rect;
  // the popover host (rendered once, below) opens the quick-edit there.
  const [entityRefTarget, setEntityRefTarget] = useState<EntityRefClickTarget | null>(null)
  const entityRefExtension = useMemo(
    () =>
      EntityRefDecorations.configure({
        onEntityRefClick: (identifier, rect) => setEntityRefTarget({ identifier, rect }),
      }),
    [],
  )
  // Both stable for the editor's lifetime: suggestion cards for `<!-- proposal:ID -->`
  // markers, and the identifier decorations.
  const docExtraExtensions = useMemo(() => [ProposalNodeExtension, entityRefExtension], [entityRefExtension])

  // Re-fetch the document and reconcile local state. Used by both the AI-edit
  // completion signal and the realtime detail sync (teammate/MCP/cron writes).
  const refetchDocument = useCallback(() => {
    // A save on the wire: refetch once it lands. A conflict being resolved:
    // the banner owns the text until the person picks.
    if (inFlightRef.current > 0) {
      refetchAfterSaveRef.current = true
      return
    }
    if (conflictRef.current) return
    fetch(`/api/account/documents/${documentId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.document) return
        // A content save is still queued — this fetch predates it, so its
        // content is stale; merging/pushing it would revert the user's edit.
        // (Same guard the editor uses for dial8:content-edited refreshes.)
        if (saveTimeoutRef.current || inFlightRef.current > 0 || conflictRef.current) return
        setDoc((prev) => prev ? { ...prev, ...data.document } : data.document)
        writeDocCache(documentId, data.document)
        // Track as the latest known content so the unmount flush can never
        // revert the incoming edit with an older snapshot.
        latestContentRef.current = data.document.content || ''
        setExternalEditorContent(data.document.content || '')
      })
      .catch(() => {})
  }, [documentId])

  // Listen for AI edit tool completions and re-fetch the document content
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { entityId: string }
      if (detail.entityId !== documentId) return
      refetchDocument()
    }
    window.addEventListener('dial8:content-edited', handler)
    return () => window.removeEventListener('dial8:content-edited', handler)
  }, [documentId, refetchDocument])

  // Live sync: refetch on any remote update (teammate, MCP tool, cron), close on
  // remote delete. refetchDocument's queued-save guard prevents clobbering the
  // user's unsaved editor content.
  useEntityDetailSync('document', documentId, {
    refetch: refetchDocument,
    onDeleted: () => {
      documentDetailCache.delete(documentId)
      onDeleted?.()
      onClose()
    },
  })

  // Selection change handler — reports to parent for AI context
  const handleEditorSelectionChange = useCallback(
    (selectedText: string | null) => {
      if (!onSelectionChange) return
      if (selectedText) {
        onSelectionChange({
          entityType: 'document',
          entityId: documentId,
          field: 'content',
          selectedText,
        })
      } else {
        onSelectionChange(null)
      }
    },
    [onSelectionChange, documentId],
  )

  useEffect(() => {
    let cancelled = false
    const hasCached = documentDetailCache.has(documentId)
    if (!hasCached) setLoading(true)
    fetch(`/api/account/documents/${documentId}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        setDoc(data.document)
        writeDocCache(documentId, data.document)
        latestContentRef.current = data.document.content
        if (typeof data.document?.revision === 'number') baseRevisionRef.current = data.document.revision
        baseContentRef.current = data.document?.content || ''
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    // Fetch inline comments + member identity in parallel
    Promise.all([
      fetch(`/api/account/documents/${documentId}/comments`).then((r) => r.ok ? r.json() : null),
      fetch('/api/account/workspace').then((r) => r.ok ? r.json() : null),
    ]).then(([commentsData, ws]) => {
      if (cancelled || !ws?.currentMemberId) return
      const me = (ws.members || []).find((m: { id: string }) => m.id === ws.currentMemberId)
      const identity: CommentIdentity = {
        mode: 'authenticated',
        memberId: ws.currentMemberId,
        displayName: me?.display_name || 'You',
        avatarUrl: me?.avatar_url || null,
      }
      setCommentIdentity(identity)
      if (commentsData?.comments) {
        setInlineComments(
          mapAuthComments(commentsData.comments, identity as Extract<CommentIdentity, { mode: 'authenticated' }>),
        )
      }
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [documentId])

  // Serializes PATCHes so overlapping content saves can't commit out of order —
  // an older request resolving after a newer one would win in the DB.
  //
  // `optimistic` (with the values it replaces, `before`) is shown at once and
  // rolled back if the save fails: a refusal (403, migration 359) or any
  // other error. The server's message is shown either way (saveError), for
  // every field, so a refused edit never looks saved.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const [saveError, setSaveError] = useState<string | null>(null)
  // The body save, for resolveConflict (declared before it).
  const saveTextRef = useRef<((markdown: string) => Promise<void>) | null>(null)

  // A save of the text lost the compare-and-swap: someone (an agent, another
  // tab) changed the document since this editor's base. Nothing was
  // overwritten. If the person's text already holds that change, save it on
  // the new revision; otherwise ask (combine both, keep mine, or use theirs).
  const resolveConflict = useCallback(async (): Promise<void> => {
    const [res, history] = await Promise.all([
      fetch(`/api/account/documents/${documentId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/account/documents/${documentId}/revisions?limit=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    const latest = res?.document as DocumentDetail | undefined
    const newest = (history?.revisions?.[0] ?? null) as RevisionSummary | null
    if (!latest || typeof latest.revision !== 'number') {
      setSaveError('This document changed while you were editing, and the latest version couldn’t be loaded. Your text is still here; try again.')
      return
    }
    const mine = latestContentRef.current ?? ''
    const [base, theirs] = await Promise.all([editorMarkdown(baseContentRef.current), editorMarkdown(latest.content || '')])
    const plan = planConflict(base, mine, theirs, merge3)
    if (plan.kind === 'save') {
      baseRevisionRef.current = latest.revision
      baseContentRef.current = latest.content || ''
      void saveTextRef.current?.(plan.text)
      return
    }
    conflictRef.current = true
    setConflict({ plan, theirs: latest.content || '', revision: latest.revision, by: newest ? describeRevisionAuthor(newest) : null })
  }, [documentId])

  // Serializes PATCHes so overlapping content saves can't commit out of order —
  // an older request resolving after a newer one would win in the DB.
  //
  // `optimistic` (with the values it replaces, `before`) is shown at once and
  // rolled back if the save fails: a refusal (403, migration 359) or any
  // other error. The server's message is shown either way (saveError), for
  // every field, so a refused edit never looks saved.
  //
  // A body save names the revision the editor's text is based on (migration
  // 364); a 409 means the document moved on, and resolveConflict takes it.
  const saveField = useCallback(
    (
      updates: Record<string, unknown>,
      optimistic?: { patch: Partial<DocumentDetail>; before: Partial<DocumentDetail> },
    ) => {
      if (optimistic) setDoc((prev) => (prev ? { ...prev, ...optimistic.patch } : prev))
      const run = saveChainRef.current.then(async () => {
        const isBody = typeof updates.content === 'string'
        // Held while a conflict is open: the banner decides what is saved.
        if (isBody && conflictRef.current) return
        const body = isBody && baseRevisionRef.current !== null ? { ...updates, base_revision: baseRevisionRef.current } : updates
        inFlightRef.current++
        let result: Awaited<ReturnType<typeof patchDocumentFields>>
        try {
          result = await patchDocumentFields(documentId, body)
        } finally {
          inFlightRef.current--
        }
        if (result.ok) {
          setSaveError(null)
          const saved = result.document as Partial<DocumentDetail> | null
          if (saved) {
            setDoc((prev) => (prev ? { ...prev, ...saved } : prev))
            // The base moves with a save only when the document is now exactly
            // what this editor holds.
            if (typeof saved.revision === 'number') {
              const savedContent = saved.content ?? ''
              if (isBody ? savedContent === updates.content : savedContent === baseContentRef.current) {
                baseRevisionRef.current = saved.revision
                baseContentRef.current = savedContent
              }
            }
          }
          if (refetchAfterSaveRef.current && !saveTimeoutRef.current) {
            refetchAfterSaveRef.current = false
            refetchDocument()
          }
          return
        }
        if (optimistic) setDoc((prev) => (prev ? rollbackPatch(prev, optimistic.before, optimistic.patch) : prev))
        if (isBody && result.status === 409) {
          setSaveError(null)
          await resolveConflict()
          return
        }
        setSaveError(result.error)
      })
      saveChainRef.current = run.catch(() => {})
      return run
    },
    [documentId, resolveConflict, refetchDocument],
  )

  // The body save (autosave and conflict resolution go through here).
  const saveText = useCallback((markdown: string) => saveField({ content: markdown }), [saveField])
  saveTextRef.current = saveText

  // The person's pick on the conflict banner: the whole text, or (a
  // section-level conflict, minimal D4) mine or theirs per section.
  const settleConflict = useCallback(
    (choice: 'combine' | 'mine' | 'theirs' | 'sections', sectionChoices?: Record<string, 'mine' | 'theirs'>) => {
      if (!conflict) return
      const mine = latestContentRef.current ?? ''
      const text =
        choice === 'sections' && conflict.plan.kind === 'sections'
          ? composeSectionChoice(conflict.plan.parts, sectionChoices ?? {})
          : choice === 'theirs'
            ? conflict.theirs
            : choice === 'combine' && conflict.plan.kind === 'combine'
              ? conflict.plan.text
              : mine
      baseRevisionRef.current = conflict.revision
      baseContentRef.current = conflict.theirs
      conflictRef.current = false
      setConflict(null)
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
      latestContentRef.current = text
      // Remount the editor on the chosen text, so it shows exactly that (and
      // drops any incoming change it was holding back while the person typed).
      setDoc((prev) => (prev ? { ...prev, content: text, revision: conflict.revision } : prev))
      setEditorEpoch((n) => n + 1)
      // Whatever of the person's text the choice leaves out is saved first, as
      // its own version, so "it stays in the version history" is true: then
      // the chosen text goes on top of it (one save each, in order).
      const tookTheirs =
        choice === 'theirs' ||
        (choice === 'sections' && conflict.plan.kind === 'sections' && conflictingSections(conflict.plan.parts).some((c) => sectionChoices?.[c.key] !== 'mine'))
      const dropsMine = tookTheirs && text !== mine && mine !== conflict.theirs
      if (dropsMine) {
        void saveField({ content: mine, change_summary: 'My unsaved edit, kept in the history before taking a newer change' })
      }
      if (text !== conflict.theirs || dropsMine) {
        void saveField({
          content: text,
          change_summary:
            choice === 'theirs'
              ? 'Took the newer version'
              : choice === 'combine' || choice === 'sections'
                ? 'Combined my edit with a newer change'
                : 'Kept my version over a newer change',
        })
      }
    },
    [conflict, saveField],
  )

  // A version restored from History: the editor takes exactly that text, on
  // its new revision, and anything queued or in conflict is dropped (the text
  // it held is in the history).
  const handleRestored = useCallback((restored: { title: string | null; content: string | null; revision: number }) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    conflictRef.current = false
    setConflict(null)
    const content = restored.content ?? ''
    baseRevisionRef.current = restored.revision
    baseContentRef.current = content
    latestContentRef.current = content
    setDoc((prev) => (prev ? { ...prev, content, revision: restored.revision, ...(restored.title ? { title: restored.title } : {}) } : prev))
    setEditorEpoch((n) => n + 1)
  }, [])

  // "Mark checked" on the not-checked-since marker: that section leaves it.
  const markSectionChecked = useCallback(
    (heading: string) => {
      setDoc((prev) => {
        if (!prev) return prev
        const next = { ...prev, stale_sections: (prev.stale_sections ?? []).filter((s) => s.heading !== heading) }
        writeDocCache(documentId, next)
        return next
      })
    },
    [documentId],
  )

  const handleLinkAction = useCallback(
    async (actionId: string) => {
      const res = await fetch(`/api/account/documents/${documentId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_id: actionId }),
      })
      if (res.ok) {
        // Re-fetch to get full action info
        fetch(`/api/account/documents/${documentId}/actions`)
          .then((r) => r.json())
          .then((d) => setLinkedActions(d.actions || []))
          .catch(() => {})
      }
      setActionSearchOpen(false)
    },
    [documentId],
  )

  const handleUnlinkAction = useCallback(
    async (linkId: string) => {
      const res = await fetch(
        `/api/account/documents/${documentId}/actions?link_id=${linkId}`,
        { method: 'DELETE' },
      )
      if (res.ok) {
        setLinkedActions((prev) => prev.filter((a) => a.link_id !== linkId))
      }
    },
    [documentId],
  )

  const handleContentChange = useCallback(
    (markdown: string) => {
      latestContentRef.current = markdown
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        // Null the ref when the timer fires so it accurately means "a save is
        // still queued" — otherwise the unmount flush re-PATCHes after every
        // session (reverting anything written to the doc since, e.g. AI edits).
        saveTimeoutRef.current = null
        saveText(markdown)
      }, 500)
    },
    [saveText],
  )

  // Flush a still-queued save on unmount — through saveField so it stays on the
  // save chain (a raw fetch here could race an in-flight chained PATCH and
  // commit out of order, losing the newer content).
  //
  // Closed with a conflict open (the banner unanswered): the body save is held,
  // so the person's text is kept as their draft, based on the revision they
  // edited, never dropped. Publishing it later asks first (STALE_DRAFT).
  useEffect(() => {
    return () => {
      const queued = saveTimeoutRef.current
      if (queued) {
        clearTimeout(queued)
        saveTimeoutRef.current = null
      }
      const text = latestContentRef.current
      const action = unmountAction({ text, conflictOpen: conflictRef.current, saveQueued: queued !== null })
      if (action === 'draft') {
        void fetch(`/api/account/documents/${documentId}/draft`, {
          method: 'PUT',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, base_revision: baseRevisionRef.current }),
        }).catch(() => {})
      } else if (action === 'save' && text !== null) {
        saveText(text)
      }
    }
  }, [documentId, saveText])

  function startEditingTitle() {
    if (!doc) return
    setTitleDraft(doc.title)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  async function saveTitle() {
    const trimmed = titleDraft.trim()
    if (!trimmed || !doc || trimmed === doc.title) {
      setEditingTitle(false)
      return
    }
    await saveField({ title: trimmed })
    setEditingTitle(false)
  }

  async function handleDelete() {
    if (deleting) return
    setDeleting(true)
    const permanent = deleteConfirm === 'delete'
    const res = await fetch(
      `/api/account/documents/${documentId}${permanent ? '?permanent=true' : ''}`,
      { method: 'DELETE' },
    )
    if (res.ok) {
      setDeleteConfirm(null)
      onDeleted?.()
      onClose()
    }
    setDeleting(false)
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Document not found
      </div>
    )
  }

  // Scope control. The PATCH itself (and the rollback on failure) lives in
  // VisibilityControl; this only mirrors the value into panel state, the
  // cache, and the list rows.
  const handleVisibilityChange = (visibility: Visibility) => {
    setDoc((prev) => {
      if (!prev) return prev
      const next = { ...prev, visibility }
      writeDocCache(documentId, next)
      return next
    })
    emitEntityUpdated({ entityType: 'document', id: documentId, fields: { visibility, created_by: viewerMemberId } })
  }

  const readOnly = doc.can_edit === false
  const isSystem = doc.is_system === true
  // The person's Now file (migration 440): always private, never shared or
  // moved, so the controls that would only ever refuse aren't shown.
  const isNowFile = doc.kind === 'now'
  const canDelete = doc.can_delete !== false && !isSystem
  const canSetProject = !readOnly && doc.can_set_project !== false
  const staleNote = <StaleSectionsNote documentId={documentId} sections={doc.stale_sections} canMark={!readOnly} onMarked={markSectionChecked} />
  const saveErrorLine = (
    <>
      {saveError ? <p role="alert" className="text-xs text-destructive">{saveError}</p> : null}
      {conflict ? (
        conflict.plan.kind === 'sections' ? (
          <SectionConflictBanner conflict={conflict} onSave={(choices) => settleConflict('sections', choices)} />
        ) : (
          <ConflictBanner conflict={conflict} onChoose={settleConflict} />
        )
      ) : null}
    </>
  )

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center px-5">
        <div className="flex shrink-0 items-center gap-1">
          {DOCUMENT_SECTIONS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveSection(tab)}
              className={cn(
                'inline-flex shrink-0 items-center px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap',
                activeSection === tab
                  ? 'bg-foreground text-background border-foreground font-medium'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
              )}
            >
              {SECTION_LABELS[tab]}
            </button>
          ))}
        </div>
        <WindowActions className="ml-auto flex items-center gap-1">
          {/* Visibility is creator-only and only offered in shared workspaces;
              a system document is never private (migration 369). */}
          {!isSystem &&
            !isNowFile &&
            canOfferVisibilityControl(doc.created_by, doc.visibility ?? 'workspace', viewerMemberId, workspaceMemberCount) && (
              <VisibilityControl
                noun="document"
                endpoint={`/api/account/documents/${documentId}/visibility`}
                visibility={doc.visibility ?? 'workspace'}
                onVisibilityChange={handleVisibilityChange}
              />
            )}
          {/* Read aloud (desktop only) in listen mode: the title, then the
                      document as it is now, unsaved edits included. No button of
                      its own: the Listen mode toggle in the top bar is its
                      control, as for an email or an action. */}
          <ListenTarget
            listenKey={`doc:${documentId}`}
            getSentences={() =>
              titledMarkdownToSentences(doc.title || '', latestContentRef.current ?? doc.content ?? '')
            }
          />
          {/* P9 (decision 9): copy the whole text out, e.g. a newsletter into Substack. Hidden when empty. */}
          {(doc.content ?? '').trim() && <CopyDocumentButton getMarkdown={() => latestContentRef.current ?? doc.content ?? ''} />}
          <EntityActionsMenu entity={{ type: 'document', id: documentId, label: doc.title ?? '' }} state={{ archived: doc.status === 'archived', status: doc.status }} omit={PANEL_OMIT} />
          {!isNowFile && <ShareDialog shareableType="document" shareableId={documentId} />}
          {/* Move to another workspace — same post-move handling as delete:
                      the document leaves this workspace's lists either way.
                      A Now file is one workspace's own. */}
          {!isNowFile && (
            <MoveToWorkspaceButton
              entityType="document"
              id={documentId}
              entityLabel={doc.title || undefined}
              onMoved={() => {
                onDeleted?.()
                onClose()
              }}
            />
          )}
          {(canDelete || isSystem) && (
            <PreferenceActionButton
              label="Delete document"
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7 text-muted-foreground', isSystem ? 'opacity-50' : 'hover:text-destructive')}
              // A system document says why instead of deleting.
              onClick={() => setDeleteConfirm(isSystem ? 'system' : 'delete')}
              title={isSystem ? SYSTEM_DOCUMENT_REFUSAL : 'Delete document'}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </PreferenceActionButton>
          )}
        </WindowActions>
      </div>

      {/* Content */}
      {commentIdentity ? (
        <InlineCommentProvider
          initialComments={inlineComments}
          identity={commentIdentity}
          api={createAuthenticatedAPI('document', documentId, commentIdentity as Extract<CommentIdentity, { mode: 'authenticated' }>)}
        >
          <div ref={panelBodyRef} className={cn('flex flex-1 min-h-0 justify-center', activeSection !== 'overview' && 'hidden')}>
            <div className="w-full max-w-[736px] min-w-0 mx-auto">
            <ScrollArea className="h-full">
              <div className="px-8 pb-28">
                <AnnotatedContent section="document">
                  <div className="pt-6 pb-2 space-y-2">
                    {editingTitle ? (
                      <EntityTitleInput
                        inputRef={titleInputRef}
                        value={titleDraft}
                        onChange={setTitleDraft}
                        onCommit={() => saveTitle()}
                        onCancel={() => setEditingTitle(false)}
                      />
                    ) : (
                      <h1
                        className={cn('text-xl font-semibold leading-snug', !readOnly && 'cursor-pointer hover:text-muted-foreground transition-colors')}
                        title={readOnly ? undefined : 'Click to rename'}
                        onClick={readOnly ? undefined : startEditingTitle}
                      >
                        {doc.title}
                      </h1>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <FileText className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">{isSystem ? 'System document' : 'Document'}</span>
                      </div>
                      {doc.project_name && (
                        <>
                          <span className="text-xs text-muted-foreground">·</span>
                          <span className="text-xs text-muted-foreground">{doc.project_name}</span>
                        </>
                      )}
                      {doc.created_by_name && (
                        <>
                          <span className="text-xs text-muted-foreground">·</span>
                          <span className="text-xs text-muted-foreground">{doc.created_by_name}</span>
                        </>
                      )}
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="text-xs text-muted-foreground">
                        {formatCaptureDate(doc.updated_at)}
                      </span>
                    </div>
                    {readOnly && <p className="text-xs text-muted-foreground">{READ_ONLY_NOTE}</p>}
                {staleNote}
                    {saveErrorLine}
                  </div>
                  <div className="mt-4">
                    <CommentableEditor
                      section="document"
                      key={`${documentId}:${editorEpoch}`}
                      initialContent={doc.content || ''}
                      onUpdate={handleContentChange}
                      externalContent={externalEditorContent}
                      onSelectionChange={handleEditorSelectionChange}
                      extraExtensions={docExtraExtensions}
                      proposalRefs={suggestionRefs}
                      readOnly={readOnly}
                      autoFocus={!readOnly}
                    />
                  </div>
                </AnnotatedContent>
              </div>
            </ScrollArea>
            </div>

              {/* Sidebar — properties + comments */}
              <WindowProperties key={documentId} title={doc.title || 'Document'} fallbackVisible={sidebarOpen}>
                      <div className="p-4 space-y-4">
                        {/* Properties group */}
                        <div className="rounded-lg">
                          <div data-properties-heading="" className="px-3 py-2 text-sm font-medium text-muted-foreground">Properties</div>
                          <div className="pb-2">
                            {/* Project — shown as text (or nothing) when this person
                                can't move the document between projects (read-only, or a
                                member editing a shared page: the server refuses it). */}
                            {!canSetProject ? (
                              doc.project_name && (
                                <div className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground">
                                  <span className="min-w-0 flex-1 truncate">{doc.project_name}</span>
                                </div>
                              )
                            ) : (
                              <ProjectPanelField
                                value={doc.project_id}
                                projects={projectOptions}
                                onChange={(projectId) => {
                                  const projectName = projects.find((p) => p.id === projectId)?.name || null
                                  const patch = { project_id: projectId, project_name: projectName }
                                  saveField({ project_id: projectId }, { patch, before: snapshotKeys(doc, patch) })
                                }}
                                placeholder="Set project"
                                padding="px-3"
                                onOpen={onOpenEntity && ((id, name, e) => onOpenEntity('project', id, name, e))}
                              />
                            )}

                            {/* Created by */}
                            {doc.created_by_name && (
                              <div className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground">
                                <User className="h-4 w-4 shrink-0" />
                                <span className="min-w-0 flex-1 truncate">{doc.created_by_name}</span>
                              </div>
                            )}

                            {/* Linked actions — a property row, like Participants:
                                a count that expands to the list, plus the picker
                                as its own row. */}
                            {linkedActions.length > 0 && (
                              <>
                                <button
                                  onClick={() => setLinkedActionsExpanded((v) => !v)}
                                  className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                                >
                                  <CheckSquare className="h-4 w-4 shrink-0" />
                                  <span>
                                    {linkedActions.length} {linkedActions.length === 1 ? 'action' : 'actions'}
                                  </span>
                                  {linkedActionsExpanded ? (
                                    <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
                                  ) : (
                                    <ChevronRight className="ml-auto h-3 w-3 shrink-0" />
                                  )}
                                </button>
                                {linkedActionsExpanded && (
                                  <div className="space-y-0.5 px-1 pb-1">
                                    {linkedActions.map((action) => (
                                      <div
                                        key={action.link_id}
                                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs group hover:bg-muted/50"
                                      >
                                        <Circle
                                          className="h-3 w-3 shrink-0"
                                          style={{ color: action.status_color || undefined }}
                                          fill={action.status_color || 'currentColor'}
                                        />
                                        <span className="font-mono text-muted-foreground shrink-0">{action.identifier}</span>
                                        <span className="min-w-0 flex-1 truncate">{action.title}</span>
                                        <button
                                          onClick={() => handleUnlinkAction(action.link_id)}
                                          className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                                        >
                                          <X className="h-3 w-3" />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                            <ActionSearchPicker
                              open={actionSearchOpen}
                              onOpenChange={setActionSearchOpen}
                              actions={allActions.filter((a) => !linkedActions.some((la) => la.id === a.id))}
                              onSelect={handleLinkAction}
                            />

                            {/* Activity — expands to the created/updated timeline.
                                Replaces the standalone Activity card AND the
                                bare "Updated" row, which said the same thing. */}
                            <ActivityRow
                              createdAt={doc.created_at}
                              updatedAt={doc.updated_at}
                              formatRelativeTime={formatRelativeTime}
                              padding="px-3"
                            />
                          </div>
                        </div>

                        <ReferencedIn entityType="document" entityId={documentId} />
                        <RecordHistory entityType="document" entityId={documentId} />

                        {/* Inline comment popover is rendered at root level */}
                      </div>
                    </WindowProperties>
          </div>

          <SelectionPopover />
          <InlineCommentPopover />
        </InlineCommentProvider>
      ) : (
        <div className={cn('flex flex-1 min-h-0', activeSection !== 'overview' && 'hidden')}>
          <div className="flex-1 min-w-0">
          <ScrollArea className="h-full">
            <div className="max-w-2xl mx-auto px-8 pb-28">
              <div className="pt-6 pb-2 space-y-2">
                {editingTitle ? (
                  <EntityTitleInput
                    inputRef={titleInputRef}
                    value={titleDraft}
                    onChange={setTitleDraft}
                    onCommit={() => saveTitle()}
                    onCancel={() => setEditingTitle(false)}
                  />
                ) : (
                  <h1
                    className={cn('text-xl font-semibold leading-snug', !readOnly && 'cursor-pointer hover:text-muted-foreground transition-colors')}
                    title={readOnly ? undefined : 'Click to rename'}
                    onClick={readOnly ? undefined : startEditingTitle}
                  >
                    {doc.title}
                  </h1>
                )}
                {readOnly && <p className="text-xs text-muted-foreground">{READ_ONLY_NOTE}</p>}
                {staleNote}
                {saveErrorLine}
              </div>
              <div className="mt-4">
                <NoteEditor
                  key={`${documentId}:${editorEpoch}`}
                  initialContent={doc.content || ''}
                  onUpdate={handleContentChange}
                  externalContent={externalEditorContent}
                  onSelectionChange={handleEditorSelectionChange}
                  extraExtensions={docExtraExtensions}
                  proposalRefs={suggestionRefs}
                  readOnly={readOnly}
                  autoFocus={!readOnly}
                />
              </div>
            </div>
          </ScrollArea>
          </div>
        </div>
      )}

      {activeSection === 'agents' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[736px] px-8">
            <EntityActivitySection entityType="document" entityId={documentId} />
          </div>
        </div>
      )}

      {activeSection === 'history' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[736px] px-8">
            <DocumentHistory
              documentId={documentId}
              currentRevision={doc.revision ?? null}
              canRestore={!readOnly}
              onRestored={handleRestored}
            />
          </div>
        </div>
      )}

      <AlertDialog open={deleteConfirm === 'system'} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This is a system document</AlertDialogTitle>
            <AlertDialogDescription>
              It can be edited, not deleted. Your agents ground their work in it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>OK</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteConfirm === 'delete'} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{doc.title}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this document. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* One popover host for identifier decorations clicked in the body. */}
      <EntityRefDocPopover target={entityRefTarget} onClose={() => setEntityRefTarget(null)} />
    </div>
  )
}

/**
 * A section-level conflict (minimal D4): someone (usually Dial8) changed the
 * same sections the person was editing. Every other section is combined
 * already; for each section both changed, the person keeps theirs or takes
 * the newer one, then saves. Nothing is overwritten until they do.
 */
function SectionConflictBanner({
  conflict,
  onSave,
}: {
  conflict: EditConflict
  onSave: (choices: Record<string, 'mine' | 'theirs'>) => void
}) {
  const sections = conflict.plan.kind === 'sections' ? conflictingSections(conflict.plan.parts) : []
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>(() => Object.fromEntries(sections.map((s) => [s.key, 'mine'])))
  const who = conflict.by ?? 'Someone'
  const names = [...new Set(sections.map((s) => s.heading))]
  return (
    <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
      <p className="font-medium text-foreground">
        {who} updated {names.join(', ')} while you were editing
      </p>
      <p className="mt-0.5 text-muted-foreground">
        Your other changes are combined with theirs. For {sections.length === 1 ? 'this section' : 'each of these sections'}, keep your version or take theirs. If you take theirs, your text is saved as a version first, so it stays in the history.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {sections.map(({ key, heading }) => (
          <li key={key} className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{heading}</span>
            {(['mine', 'theirs'] as const).map((side) => (
              <button
                key={side}
                type="button"
                aria-pressed={choices[key] === side}
                onClick={() => setChoices((prev) => ({ ...prev, [key]: side }))}
                className={cn(
                  'rounded-md border px-2.5 py-1',
                  choices[key] === side ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-muted',
                )}
              >
                {side === 'mine' ? 'Keep mine' : 'Take theirs'}
              </button>
            ))}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={() => onSave(choices)} className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background hover:bg-foreground/90">
          Save
        </button>
      </div>
    </div>
  )
}

/**
 * The document changed while the person was editing, and their latest change
 * isn't saved. Nothing has been overwritten: they choose.
 */
function ConflictBanner({
  conflict,
  onChoose,
}: {
  conflict: EditConflict
  onChoose: (choice: 'combine' | 'mine' | 'theirs') => void
}) {
  const canCombine = conflict.plan.kind === 'combine'
  return (
    <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
      <p className="font-medium text-foreground">
        {conflict.by ? `${conflict.by} changed this document while you were editing` : 'This document changed while you were editing'}
      </p>
      <p className="mt-0.5 text-muted-foreground">
        {canCombine
          ? 'Your latest change isn’t saved yet. The two changes touch different lines, so both can be kept.'
          : 'Your latest change isn’t saved yet. It changes the same lines as the newer change, so pick one. Either way, both stay in the version history.'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {canCombine && (
          <button
            type="button"
            onClick={() => onChoose('combine')}
            className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background hover:bg-foreground/90"
          >
            Keep both
          </button>
        )}
        <button
          type="button"
          onClick={() => onChoose('mine')}
          className={cn(
            'rounded-md border border-border px-2.5 py-1 hover:bg-muted',
            !canCombine && 'bg-foreground text-background border-foreground hover:bg-foreground/90',
          )}
        >
          Keep mine
        </button>
        <button type="button" onClick={() => onChoose('theirs')} className="rounded-md border border-border px-2.5 py-1 hover:bg-muted">
          Use the newer version
        </button>
      </div>
    </div>
  )
}

function ActionSearchPicker({
  open,
  onOpenChange,
  actions,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: ActionOption[]
  onSelect: (id: string) => void
}) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setSearch('')
      const timer = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [open])

  const filtered = search.trim()
    ? actions.filter((a) => {
        const q = search.toLowerCase()
        return a.identifier.toLowerCase().includes(q) || a.title.toLowerCase().includes(q)
      })
    : actions

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/50">
          <Plus className="h-4 w-4 shrink-0" />
          <span>Link action</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
        align="start"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <div className="flex items-center border-b border-border px-3">
          <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            placeholder="Search actions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex h-8 w-full bg-transparent py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[200px] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">No actions found</div>
          ) : (
            filtered.map((a) => (
              <button
                key={a.id}
                onClick={() => onSelect(a.id)}
                className="flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-xs text-left text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                <span className="font-mono text-muted-foreground shrink-0">{a.identifier}</span>
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  const diffYears = Math.floor(diffDays / 365)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return `${diffYears}y ago`
}
