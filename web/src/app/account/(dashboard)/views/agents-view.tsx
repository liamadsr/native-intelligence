'use client'

/**
 * Agents & Skills — existing library data, rows and dialogs, with the shared
 * saved-view toolbar used throughout the app. The type picker stays in the
 * header; All, Mine, Workspace and Discover are the default collection views.
 *
 * An agent of this workspace opens the one agent editor (bots-v4 B1,
 * components/agents/agent-editor.tsx): the agent and its bots, in one place.
 * So does "New agent", which makes the agent and its bot together. A built-in
 * agent, or one in Discover not yet added, keeps the read-only detail dialog;
 * skills keep their own editor.
 */

import { PageTitle } from '@/components/views/page-title'
import { ExpandableSearch } from '@/components/views/expandable-search'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsUpDown, Plus, Upload, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import {
  LIBRARY_CATEGORY_LABELS as CATEGORY_LABELS,
  LIBRARY_SURFACE_LABEL,
} from '@/lib/types/library'
import { LIBRARY_CATEGORY_ICONS } from '@/lib/types/library-icons'
import { ViewHeader } from './view-header'
import { useLibraryItems } from './agents/use-library-items'
import { myIdSet } from './agents/library-filter'
import { LibraryCollection } from './agents/library-collection'
import { LibraryRow } from './agents/library-row'
import {
  DetailDialog,
  EditorDialog,
  defaultForm,
  formFromRow,
  formFromParsedSkill,
  buildSubmitBody,
  type EditorForm,
} from './agents/item-dialogs'
import { AgentEditorDialog } from '@/components/agents/agent-editor'
import { parseSkillMd } from '@/lib/library/skill-md'
import {
  TYPE_FRAMING,
  type LibraryRow as LibraryRowData,
  type LibraryCategory,
  type LibraryScope,
  type LibraryVisibility,
} from './agents/library-types'

// ─── Persisted UI prefs ──────────────────────────────────────────────
// The active type persists across sessions. Default collections start on All;
// custom view selection and drafts use the shared views persistence.

const TYPE_STORAGE_KEY = 'dial8-agents-type'

/** Upper bound for a SKILL.md import — it's a prompt file, so 1 MB is plenty. */
const SKILL_MD_MAX_BYTES = 1_000_000

function readType(): LibraryCategory {
  if (typeof window === 'undefined') return 'agent'
  return window.localStorage.getItem(TYPE_STORAGE_KEY) === 'skill' ? 'skill' : 'agent'
}

// The type switcher renders as the app-wide pill "view picker" dropdown (the
// Knowledge / Team / Calendar pattern), not a segmented tab group. Icons come
// from the canonical library map so the picker, ⌘K, and tab labels agree.
const TYPE_PICKER: { id: LibraryCategory; label: string; Icon: LucideIcon }[] = [
  { id: 'agent', label: 'Agents', Icon: LIBRARY_CATEGORY_ICONS.agent },
  { id: 'skill', label: 'Skills', Icon: LIBRARY_CATEGORY_ICONS.skill },
]

/**
 * @param initialItemId       When set (deep-link from ⌘K / Recently viewed),
 *                            open the library focused on this item: pre-select
 *                            its type tab and pop its detail dialog once its row
 *                            has loaded. Consumed once — subsequent navigations
 *                            to the same id are ignored so closing the dialog
 *                            doesn't immediately re-open it.
 * @param initialItemCategory The item's category, so the correct type tab is
 *                            selected before the row is available to read it
 *                            from.
 */
/**
 * The library in a chat card (src/components/chat-cards/pages/library-card.tsx):
 * the card owns which of agents and skills it is on, so the page's remembered
 * choice (TYPE_STORAGE_KEY) is neither read nor written by a card.
 */
export interface LibraryCardMode {
  type: LibraryCategory
  onType: (type: LibraryCategory) => void
}

export function AgentsView({
  initialItemId,
  initialItemCategory,
  card,
}: {
  initialItemId?: string
  initialItemCategory?: LibraryCategory
  card?: LibraryCardMode
} = {}) {
  const {
    discoverItems,
    workspaceItems,
    myItems,
    isLoading,
    forking,
    fork,
    remove,
    save,
    refetchOwned,
  } = useLibraryItems()

  const [ownType, setActiveType] = useState<LibraryCategory>(
    () => initialItemCategory ?? (card ? card.type : readType()),
  )
  const activeType = card ? card.type : ownType
  const cardRef = useRef(card)
  cardRef.current = card
  const [scope, setScope] = useState<LibraryScope>('all')
  const [search, setSearch] = useState('')

  const [viewingItem, setViewingItem] = useState<LibraryRowData | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  // When set, the editor is in edit mode (PATCH; category locked). null = create.
  const [editingItem, setEditingItem] = useState<LibraryRowData | null>(null)
  const [form, setForm] = useState<EditorForm>(() => defaultForm('agent'))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)

  // The one agent editor: open on an agent of this workspace, or on "New agent".
  const [agentEditor, setAgentEditor] = useState<{ agentId: string } | { create: true } | null>(null)

  const isEditMode = editingItem !== null
  const dialogOpen = showCreateDialog || isEditMode

  const setTypePersisted = useCallback((next: LibraryCategory) => {
    if (cardRef.current) {
      cardRef.current.onType(next)
      return
    }
    setActiveType(next)
    try {
      window.localStorage.setItem(TYPE_STORAGE_KEY, next)
    } catch {
      /* storage unavailable */
    }
  }, [])

  // Which ids the current user created — drives "Created by you" vs author
  // chips and the own-Discover-listing edit affordance.
  const myIds = useMemo(() => myIdSet(myItems), [myItems])

  // An agent of this workspace (not a built-in one, not a Discover listing not
  // yet added) opens in the one agent editor.
  const opensInAgentEditor = useCallback(
    (item: LibraryRowData) =>
      item.category === 'agent' &&
      !item.is_system &&
      (workspaceItems.some((r) => r.id === item.id) || myItems.some((r) => r.id === item.id)),
    [workspaceItems, myItems],
  )

  // ── Deep-link: open a specific item from outside (⌘K, Recently viewed) ──
  // The tab location carries { initialItemId, initialItemCategory }. Switch to
  // the item's type tab immediately (from the category, before the row loads),
  // then open its detail dialog once the row is present in one of the fetched
  // lists. Guarded by a ref so we consume each distinct id exactly once — after
  // opening, closing the dialog must not re-trigger, and re-navigating to the
  // SAME id (e.g. selecting it again in the palette) is a no-op until the id
  // actually changes. Not-yet-loaded is handled gracefully: the effect re-runs
  // as the lists arrive and simply does nothing until the row shows up (and
  // never at all if the id resolves to nothing the caller can see).
  // An agent of this workspace opens in the agent editor instead of the detail
  // dialog; the history rules are the same for both.
  const consumedItemIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!initialItemId) {
      if (consumedItemIdRef.current) {
        setViewingItem(null)
        setAgentEditor(null)
      }
      consumedItemIdRef.current = null
      return
    }
    if (consumedItemIdRef.current === initialItemId) return
    // A different history target replaces an open dialog. The consumed ID
    // above still prevents a list refetch from reopening a manually closed one.
    if (initialItemCategory) setActiveType(initialItemCategory)
    // Search every fetched list — the item may only live in Discover, Workspace,
    // or Mine depending on where the deep-link points.
    const found =
      workspaceItems.find((r) => r.id === initialItemId) ??
      myItems.find((r) => r.id === initialItemId) ??
      discoverItems.find((r) => r.id === initialItemId) ??
      null
    if (!found) {
      setViewingItem(null)
      if (consumedItemIdRef.current) setAgentEditor(null)
      return // lists still loading (or not visible to this user) — wait
    }
    consumedItemIdRef.current = initialItemId
    if (opensInAgentEditor(found)) {
      setViewingItem(null)
      setAgentEditor({ agentId: found.id })
    } else {
      setAgentEditor(null)
      setViewingItem(found)
    }
  }, [initialItemId, initialItemCategory, workspaceItems, myItems, discoverItems, opensInAgentEditor])

  const sources = useMemo(
    () => ({ discover: discoverItems, workspace: workspaceItems, mine: myItems }),
    [discoverItems, workspaceItems, myItems],
  )

  // ── Dialog lifecycle ──

  const openCreateDialog = useCallback(() => {
    // "New agent" is the one agent editor: the agent and its bot together.
    if (activeType === 'agent') {
      setAgentEditor({ create: true })
      return
    }
    setForm(defaultForm(activeType))
    setShowAdvanced(false)
    setShowCreateDialog(true)
  }, [activeType])

  // SKILL.md import (skills only). Read the picked file, parse the standard
  // frontmatter + body, and open the create dialog PRE-FILLED. An empty parsed
  // name is left blank so the editor's required-name validation catches it —
  // we don't invent one. Parse warnings (dropped keys, missing frontmatter)
  // surface as a single joined toast rather than a stack of them.
  const skillImportInputRef = useRef<HTMLInputElement>(null)

  const handleSkillFilePicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // Reset the input so re-picking the same file re-fires onChange.
      e.target.value = ''
      if (!file) return
      // A SKILL.md is a prompt file — 1 MB is already far past any real one.
      // Reject larger files before reading so a mis-picked binary can't be
      // slurped into memory (and the parser).
      if (file.size > SKILL_MD_MAX_BYTES) {
        toast.error('That file is too large for a SKILL.md (max 1 MB).')
        return
      }
      let text: string
      try {
        text = await file.text()
      } catch {
        toast.error("Couldn't read that file.")
        return
      }
      const parsed = parseSkillMd(text)
      setForm(formFromParsedSkill(parsed))
      setShowAdvanced(false)
      setShowCreateDialog(true)
      if (parsed.warnings.length > 0) {
        toast.warning(parsed.warnings.join(' · '))
      }
    },
    [],
  )

  const openEditDialog = useCallback(
    (item: LibraryRowData) => {
      if (opensInAgentEditor(item)) {
        setAgentEditor({ agentId: item.id })
        return
      }
      setForm(formFromRow(item))
      setEditingItem(item)
      // Expand advanced so the skill's tool scope and persona fields are visible without a click.
      setShowAdvanced(true)
    },
    [opensInAgentEditor],
  )

  const resetDialog = useCallback(() => {
    setShowCreateDialog(false)
    setEditingItem(null)
    setForm(defaultForm(activeType))
    setShowAdvanced(false)
  }, [activeType])

  const handleSubmit = useCallback(async () => {
    const name = form.name.trim()
    if (!name) return
    setSaving(true)
    try {
      const body = buildSubmitBody(form, isEditMode)
      const result = await save({
        isEditMode,
        editingId: editingItem?.id ?? null,
        category: form.category,
        body,
      })
      if (result.ok) {
        // The save landed. Prefer the server row's name; fall back to the typed
        // name when the body didn't parse into a row (item === null) so success
        // never silently leaves the dialog open on an ok-but-unparseable response.
        const savedName = result.item?.name || name
        toast.success(
          isEditMode
            ? `${CATEGORY_LABELS[form.category]} "${savedName}" updated`
            : `${CATEGORY_LABELS[form.category]} "${savedName}" created`,
        )
        resetDialog()
      }
    } finally {
      setSaving(false)
    }
  }, [form, isEditMode, editingItem, save, resetDialog])

  // The item's visibility before this edit — the publish guardrail compares
  // against it to detect a first-time publish. Create starts from workspace.
  const prevVisibility: LibraryVisibility = editingItem?.visibility ?? 'workspace'

  const framing = TYPE_FRAMING[activeType]
  const activePicker = TYPE_PICKER.find((t) => t.id === activeType) ?? TYPE_PICKER[0]

  return (
    <div className="flex h-full flex-col">
      {/* One ViewHeader owns: title + type picker (left), and search + ghost
          create (right). */}
      <ViewHeader className="gap-3">
        <PageTitle label={LIBRARY_SURFACE_LABEL} as="h1" />

        {/* Type switcher — the pill dropdown "view picker", matching the
            Knowledge / Team / Calendar pickers so the pattern reads the same
            across the app. */}
        <DropdownMenu>
          <DropdownMenuTrigger className="border-border text-foreground hover:bg-muted data-[state=open]:bg-muted inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-sm transition-colors dark:shadow-none">
            <activePicker.Icon className="h-3.5 w-3.5" />
            {activePicker.label}
            <ChevronsUpDown className="h-3 w-3 opacity-50" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            {TYPE_PICKER.map((t) => (
              <DropdownMenuItem key={t.id} onClick={() => setTypePersisted(t.id)} className="gap-2">
                <t.Icon className="h-3.5 w-3.5" />
                {t.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1.5">
          <ExpandableSearch
            value={search}
            onChange={setSearch}
            placeholder="Search…"
            label="Search agents and skills"
          />

          {/* Import a SKILL.md — skills only. Opens the create dialog pre-filled
              from the parsed file. */}
          {activeType === 'skill' && (
            <>
              <input
                ref={skillImportInputRef}
                type="file"
                accept=".md,.markdown,.txt"
                className="hidden"
                onChange={handleSkillFilePicked}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => skillImportInputRef.current?.click()}
                title="Import a SKILL.md file"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
              </Button>
            </>
          )}

          {/* Ghost icon-only create — matches the house convention. */}
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-8 w-8"
            onClick={openCreateDialog}
            title={`New ${CATEGORY_LABELS[activeType].toLowerCase()}`}
            aria-label={`New ${CATEGORY_LABELS[activeType].toLowerCase()}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </ViewHeader>

      <LibraryCollection
        key={activeType}
        category={activeType}
        sources={sources}
        search={search}
        onScopeChange={setScope}
      >
        {({ scope: collectionScope, displayedItems, resolvingView, scopeForItem }) => (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-1">
            {/* Content — list rows only; the card grid was cut by design decision
                (2026-07-12): one density, matching the app's browse convention. */}
            {isLoading || resolvingView ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-md" />
                ))}
              </div>
            ) : displayedItems.length === 0 ? (
              <EmptyState
                scope={collectionScope}
                type={activeType}
                search={search}
                framing={framing}
                onCreate={openCreateDialog}
              />
            ) : (
              <div className="space-y-2">
                {displayedItems.map((item) => (
                  <LibraryRow
                    key={item.id}
                    item={item}
                    scope={scopeForItem(item)}
                    isMine={myIds.has(item.id)}
                    onView={() => {
                      if (opensInAgentEditor(item)) {
                        setAgentEditor({ agentId: item.id })
                        return
                      }
                      setScope(scopeForItem(item))
                      setViewingItem(item)
                    }}
                    onEdit={() => openEditDialog(item)}
                    onFork={() => fork(item.id)}
                    onDelete={() => remove(item)}
                    forking={forking === item.id}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </LibraryCollection>

      {/* Detail dialog. */}
      <DetailDialog
        item={viewingItem}
        scope={scope}
        isMine={viewingItem ? myIds.has(viewingItem.id) : false}
        forking={viewingItem ? forking === viewingItem.id : false}
        onClose={() => setViewingItem(null)}
        onEdit={openEditDialog}
        onFork={fork}
      />

      {/* Create / edit dialog (with the publish-confirm guardrail). */}
      <EditorDialog
        open={dialogOpen}
        isEditMode={isEditMode}
        form={form}
        setForm={setForm}
        showAdvanced={showAdvanced}
        setShowAdvanced={setShowAdvanced}
        saving={saving}
        prevVisibility={prevVisibility}
        onCancel={resetDialog}
        onSubmit={handleSubmit}
      />

      {/* The one agent editor: an agent and its bots, or a new agent and its bot. */}
      <AgentEditorDialog
        open={agentEditor !== null}
        agentId={agentEditor && 'agentId' in agentEditor ? agentEditor.agentId : null}
        create={agentEditor !== null && 'create' in agentEditor}
        onClose={() => setAgentEditor(null)}
        onSaved={() => refetchOwned()}
      />
    </div>
  )
}

// ─── Empty state ─────────────────────────────────────────────────────

function EmptyState({
  scope,
  type,
  search,
  framing,
  onCreate,
}: {
  scope: LibraryScope
  type: LibraryCategory
  search: string
  framing: string
  onCreate: () => void
}) {
  const typeLabel = CATEGORY_LABELS[type].toLowerCase()
  const plural = `${typeLabel}s`
  let message: string
  if (search) {
    message = 'Try a different search term.'
  } else if (scope === 'mine') {
    message = `You haven't created any ${plural} yet.`
  } else if (scope === 'workspace') {
    message = `No ${plural} in this workspace yet.`
  } else if (scope === 'discover') {
    message = `You've already added every available ${typeLabel} — check the All scope.`
  } else {
    message = `No ${plural} here yet.`
  }

  return (
    <div className="mt-16 flex flex-col items-center gap-2 text-center">
      <p className="text-muted-foreground text-lg font-medium">Nothing here yet</p>
      <p className="text-muted-foreground max-w-md text-sm">{message}</p>
      <p className="text-muted-foreground/70 mt-1 max-w-md text-xs leading-snug">{framing}</p>
      {scope !== 'discover' && (
        <Button className="mt-3" onClick={onCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          New {typeLabel}
        </Button>
      )}
    </div>
  )
}
