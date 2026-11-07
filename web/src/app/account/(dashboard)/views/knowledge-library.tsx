'use client'

import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { ThinkingOrb } from 'thinking-orbs'
import { PageLoadingOrb } from '@/components/page-loading-orb'
import { Button } from '@/components/ui/button'
import { ReviewQueueDialog } from './review-queue-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/ui/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { downloadFile } from '@/lib/download'
import { cn } from '@/lib/utils'
import {
  Archive,
  BookOpen,
  Boxes,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  HelpCircle,
  ListChecks,
  Loader2,
  Lock,
  Package,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import type { OpenEntity } from './knowledge-view'

/**
 * Knowledge library — the brief-first, auto-populating sibling of the graph:
 *
 *   - workspace brief (compiled world model)
 *   - one row per project WITH knowledge (claims and/or reference docs) —
 *     these appear automatically as the product is used
 *   - packages: the curated, gated scopes — created deliberately, usually by
 *     PROMOTING a project (or a graph filter, see knowledge-view)
 *
 * The graph stays the inspection surface; this is the reading/managing one.
 */

// ─── API payload types ───────────────────────────────────────────────────────

interface BriefPayload {
  content: string
  generated_at: string
}

interface LibraryProject {
  id: string
  name: string
  status: string | null
  claim_count: number
  confirmed: number
  open_questions: number
  last_claim_at: string | null
  brief: BriefPayload | null
  spec_docs: Array<{ id: string; slug: string; title: string }>
}

export interface LibraryPackage {
  id: string
  name: string
  slug: string
  description: string | null
  visibility: 'personal' | 'team' | 'workspace'
  team_id: string | null
  rules: Record<string, unknown>
  pinned_items: number
  updated_at: string
  has_brief: boolean
}

interface LibraryData {
  workspace_brief: BriefPayload | null
  total_claims: number
  suggested_claims: number
  projects: LibraryProject[]
  packages: LibraryPackage[]
}

interface PackageDetail {
  package: LibraryPackage & { created_by: string; created_at: string }
  items: Array<{
    entity_type: string
    entity_id: string
    label: string | null
    created_at: string
  }>
  claims: Array<{
    id: string
    text: string
    type: string
    confidence: number | null
    confirmation: string
  }>
  brief: (BriefPayload & { claim_count: number }) | null
  export_url: string
}

interface WorkspaceMember {
  id: string
  user_id: string
  display_name: string | null
  role: string
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const days = Math.floor(ms / 86_400_000)
  if (days <= 0) {
    const hours = Math.floor(ms / 3_600_000)
    return hours <= 0 ? 'just now' : `${hours}h ago`
  }
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

const VISIBILITY_META: Record<
  LibraryPackage['visibility'],
  { label: string; icon: React.ReactNode }
> = {
  personal: { label: 'Private', icon: <Lock className="h-3 w-3" /> },
  team: { label: 'Team', icon: <Users className="h-3 w-3" /> },
  workspace: { label: 'Workspace', icon: <Boxes className="h-3 w-3" /> },
}

function VisibilityBadge({ visibility }: { visibility: LibraryPackage['visibility'] }) {
  const meta = VISIBILITY_META[visibility]
  return (
    <span className="border-border text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]">
      {meta.icon}
      {meta.label}
    </span>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export function KnowledgeLibrary({
  onOpenEntity,
  initialPackageId,
  onPackageChange,
}: {
  /** The person opened a package (or closed it: null). A chat card keeps it as
   *  where it is (pages in the chat); a tab needs no word of it. */
  onPackageChange?: (pkg: { id: string; name?: string } | null) => void
  onOpenEntity?: OpenEntity
  /** Deep link: open this package's PackagePanel once (read-once, mirrors
   *  AgentsView's initialItemId). Consumed exactly once per distinct id so
   *  closing the panel doesn't immediately re-open it and re-navigating to the
   *  same package is a no-op until the id changes. */
  initialPackageId?: string
}) {
  const workspaceId = useWorkspaceId()
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openPackageId, setOpenPackageId] = useState<string | null>(null)
  const [promoteProject, setPromoteProject] = useState<LibraryProject | null>(null)

  // Deep-link consume-once: open the PackagePanel for `initialPackageId` a single
  // time. Guarded by a ref so closing the panel (setOpenPackageId(null)) doesn't
  // re-fire this, and re-navigating to the same id is a no-op until it changes.
  // The panel loads the package by id itself, so it works before `data` arrives.
  const consumedPackageIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!initialPackageId) {
      if (consumedPackageIdRef.current) setOpenPackageId(null)
      consumedPackageIdRef.current = null
      return
    }
    if (consumedPackageIdRef.current === initialPackageId) return
    consumedPackageIdRef.current = initialPackageId
    setOpenPackageId(initialPackageId)
  }, [initialPackageId])

  // Dedupe overlapping fetches (mount + a live claim burst) without leaning on
  // `loading`, which a background refetch deliberately leaves untouched.
  const inFlightRef = useRef(false)
  // A background refetch requested while a load is already running would be
  // silently dropped by the in-flight guard — losing the newest data (e.g. a
  // claim landing during the initial load). Remember it and run exactly one
  // catch-up background load when the current one settles.
  const pendingRefetchRef = useRef(false)

  // `background` refetches (live-sync) keep the current page rendered — no
  // full-page spinner flash while the weaver's writes land.
  const load = useCallback(async (background = false) => {
    if (inFlightRef.current) {
      // Coalesce into a single trailing refetch rather than dropping the event.
      if (background) pendingRefetchRef.current = true
      return
    }
    inFlightRef.current = true
    if (!background) setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/account/knowledge/library')
      const json = res.ok ? ((await res.json()) as LibraryData) : null
      if (!json) {
        if (!background) setError('Failed to load the knowledge library.')
      } else setData(json)
    } catch {
      if (!background) setError('Failed to load the knowledge library.')
    } finally {
      inFlightRef.current = false
      if (!background) setLoading(false)
      // Drain a refetch that arrived mid-load so the freshest write shows.
      if (pendingRefetchRef.current) {
        pendingRefetchRef.current = false
        void load(true)
      }
    }
  }, [])

  useEffect(() => {
    if (!workspaceId) return
    void load()
  }, [workspaceId, load])

  // Live-sync: the weaver / a teammate / an MCP tool writing claims or links
  // refreshes projects, packages, and the brief rollup in the background.
  // 1s debounce coalesces the weaver's write bursts.
  const refetchLibrary = useCallback(() => {
    void load(true)
  }, [load])
  useEntityListSync(['claim', 'entity_link'], refetchLibrary, { debounceMs: 1000 })

  if (loading) {
    return <PageLoadingOrb label="Loading library…" />
  }
  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground text-sm">{error ?? 'No data.'}</p>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-8 px-5 py-6">
          <WorkspaceBriefCard
            brief={data.workspace_brief}
            totalClaims={data.total_claims}
            suggestedClaims={data.suggested_claims}
          />

          {/* Projects — the rows that appear automatically */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-foreground text-xs font-semibold tracking-wider uppercase">
                Projects
              </h2>
              <span className="text-muted-foreground text-[11px]">
                grow automatically from calls, docs, and chats
              </span>
            </div>
            {data.projects.length === 0 ? (
              <p className="text-muted-foreground border-border rounded-md border border-dashed p-4 text-sm">
                No project knowledge yet — link captures to projects and clusters
                will appear here on their own.
              </p>
            ) : (
              <div className="space-y-2">
                {data.projects.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    onOpenEntity={onOpenEntity}
                    onPromote={() => setPromoteProject(p)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Packages — the deliberate, gated scopes */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-foreground text-xs font-semibold tracking-wider uppercase">
                Packages
              </h2>
              <span className="text-muted-foreground text-[11px]">
                curated &amp; gated — promote a project or a graph filter to create one
              </span>
            </div>
            {data.packages.length === 0 ? (
              <p className="text-muted-foreground border-border rounded-md border border-dashed p-4 text-sm">
                No packages yet. Use “Promote” on a project to gate, share, or
                export its knowledge as a unit.
              </p>
            ) : (
              <div className="space-y-2">
                {data.packages.map((pkg) => (
                  <button
                    key={pkg.id}
                    type="button"
                    onClick={() => {
                      setOpenPackageId(pkg.id)
                      onPackageChange?.({ id: pkg.id, name: pkg.name })
                    }}
                    className="border-border bg-card hover:border-foreground/30 flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors"
                  >
                    <Package className="text-muted-foreground h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground truncate text-sm font-medium">
                          {pkg.name}
                        </span>
                        <VisibilityBadge visibility={pkg.visibility} />
                      </div>
                      {pkg.description && (
                        <p className="text-muted-foreground truncate text-xs">
                          {pkg.description}
                        </p>
                      )}
                    </div>
                    <span className="text-muted-foreground shrink-0 text-[11px]">
                      {pkg.pinned_items} pinned · updated {timeAgo(pkg.updated_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>

      {openPackageId && (
        <PackagePanel
          packageId={openPackageId}
          onClose={() => {
            setOpenPackageId(null)
            onPackageChange?.(null)
          }}
          onChanged={load}
          onOpenEntity={onOpenEntity}
        />
      )}

      {promoteProject && (
        <PromotePackageDialog
          open
          onOpenChange={(open) => !open && setPromoteProject(null)}
          defaultName={promoteProject.name}
          liveRules={{ projects: [promoteProject.id] }}
          liveDescription={`Follows project "${promoteProject.name}" — new claims flow in automatically.`}
          onCreated={() => {
            setPromoteProject(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

// ─── Workspace brief ─────────────────────────────────────────────────────────

function WorkspaceBriefCard({
  brief,
  totalClaims,
  suggestedClaims,
}: {
  brief: BriefPayload | null
  totalClaims: number
  suggestedClaims: number
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="border-border bg-card rounded-lg border">
      <div className="px-4 pt-3">
        {/* Title row: title left, actions right. The actions stay a fixed size;
            the title truncates first so the row never wraps into a bunched block. */}
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen className="text-muted-foreground h-4 w-4 shrink-0" />
            <h2 className="text-foreground truncate text-sm font-semibold">Workspace brief</h2>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ReviewQueueLink suggestedClaims={suggestedClaims} />
            <RefreshBriefsButton />
          </div>
        </div>
        {/* Meta on its own full-width line so it reads cleanly at any panel
            width instead of being squeezed between the title and the buttons. */}
        <p className="text-muted-foreground mt-1 text-[11px]">
          {totalClaims.toLocaleString()} claims
          {suggestedClaims > 0 && ` · ${suggestedClaims} awaiting review`}
          {brief && ` · compiled ${timeAgo(brief.generated_at)}`}
        </p>
      </div>
      <div className="px-4 pb-4">
        {brief ? (
          <>
            <div
              className={cn(
                'relative mt-2 overflow-hidden text-sm',
                !expanded && 'max-h-40',
              )}
            >
              <Markdown className="prose prose-sm dark:prose-invert max-w-none">
                {brief.content}
              </Markdown>
              {!expanded && (
                <div className="from-card pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t to-transparent" />
              )}
            </div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-muted-foreground hover:text-foreground mt-1 text-xs font-medium"
            >
              {expanded ? 'Show less' : 'Read the full brief'}
            </button>
          </>
        ) : (
          <p className="text-muted-foreground mt-2 text-sm">
            No brief compiled yet — the nightly weaver generates one once the
            workspace has claims. Use “Refresh briefs” to compile one now.
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * Opens the review queue in a centered popup (see ReviewQueueDialog) where
 * suggested claims and draft docs get confirmed or dismissed — keeping the user
 * in the dashboard rather than sending them to a dead-end full-screen route.
 * Badges the count of suggested claims from the library rollup — no extra query.
 */
function ReviewQueueLink({ suggestedClaims }: { suggestedClaims: number }) {
  return (
    <ReviewQueueDialog suggestedClaims={suggestedClaims}>
      <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1 text-xs">
        <ListChecks className="h-3 w-3" />
        Review queue
        {suggestedClaims > 0 && (
          <span className="bg-muted text-muted-foreground ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums">
            {suggestedClaims}
          </span>
        )}
      </Button>
    </ReviewQueueDialog>
  )
}

/**
 * Fires the manual "regenerate briefs now" lever (POST /knowledge/reweave),
 * the same event the nightly cron emits. The weaver runs async, so we only
 * confirm the request was queued — the refreshed brief appears on the next
 * load once the pass completes. Rate-limited server-side (10-min cooldown per
 * workspace); a 429 surfaces the cooldown message.
 */
function RefreshBriefsButton() {
  const [state, setState] = useState<'idle' | 'busy' | 'queued'>('idle')

  const refresh = useCallback(async () => {
    setState('busy')
    try {
      const res = await fetch('/api/account/knowledge/reweave', { method: 'POST' })
      if (res.ok) {
        setState('queued')
        toast.success('Brief refresh queued — check back in a few minutes.')
        // Fall back to the idle label after a beat so the button is reusable.
        setTimeout(() => setState('idle'), 4000)
        return
      }
      const json = (await res.json().catch(() => null)) as { error?: string } | null
      toast.error(json?.error ?? 'Failed to queue a brief refresh.')
      setState('idle')
    } catch {
      toast.error('Failed to queue a brief refresh.')
      setState('idle')
    }
  }, [])

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 shrink-0 gap-1 text-xs"
      onClick={() => void refresh()}
      disabled={state !== 'idle'}
    >
      {state === 'busy' ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <RefreshCw className="h-3 w-3" />
      )}
      {state === 'queued' ? 'Queued' : 'Refresh briefs'}
    </Button>
  )
}

// ─── Project row ─────────────────────────────────────────────────────────────

function ProjectRow({
  project,
  onOpenEntity,
  onPromote,
}: {
  project: LibraryProject
  onOpenEntity?: OpenEntity
  onPromote: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border-border bg-card rounded-md border">
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground shrink-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => onOpenEntity?.('project', project.id, project.name, e)}
          className="text-foreground hover:text-foreground/80 min-w-0 truncate text-left text-sm font-medium"
        >
          {project.name}
        </button>
        <div className="text-muted-foreground ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap text-[11px]">
          <span>{project.claim_count} claims</span>
          {project.claim_count > 0 && (
            <span>
              {Math.round((project.confirmed / project.claim_count) * 100)}% confirmed
            </span>
          )}
          {project.open_questions > 0 && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <HelpCircle className="h-3 w-3" />
              {project.open_questions} open
            </span>
          )}
          <span>{timeAgo(project.last_claim_at)}</span>
        </div>
        <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1 text-xs" onClick={onPromote}>
          <Package className="h-3 w-3" />
          Promote
        </Button>
      </div>

      {expanded && (
        <div className="border-border space-y-3 border-t px-9 py-3">
          {project.spec_docs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
                Reference docs
              </span>
              {project.spec_docs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={(e) => onOpenEntity?.('document', d.id, d.title, e)}
                  className="border-border bg-background/50 text-foreground hover:border-foreground/30 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors"
                >
                  <FileText className="text-muted-foreground h-3 w-3" />
                  {d.title}
                </button>
              ))}
            </div>
          )}
          {project.brief ? (
            <div className="text-sm">
              <Markdown className="prose prose-sm dark:prose-invert max-w-none">
                {project.brief.content}
              </Markdown>
              <p className="text-muted-foreground mt-2 text-[10px]">
                Compiled {timeAgo(project.brief.generated_at)} — regenerates
                nightly when the project&apos;s claims change.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No brief compiled for this project yet.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Package detail panel ────────────────────────────────────────────────────

function PackagePanel({
  packageId,
  onClose,
  onChanged,
  onOpenEntity,
}: {
  packageId: string
  onClose: () => void
  onChanged: () => void
  onOpenEntity?: OpenEntity
}) {
  const [detail, setDetail] = useState<PackageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [shares, setShares] = useState<
    Array<{
      id: string
      access_level: string
      member: { id: string; display_name: string | null } | null
      team: { id: string; name: string } | null
    }>
  >([])
  const [shareMemberId, setShareMemberId] = useState('')
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState<'markdown' | 'jsonl' | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [detailRes, sharesRes, membersRes] = await Promise.all([
        fetch(`/api/account/knowledge-packages/${packageId}`),
        fetch(`/api/account/knowledge-packages/${packageId}/shares`),
        fetch('/api/account/workspace/members'),
      ])
      if (detailRes.ok) setDetail((await detailRes.json()) as PackageDetail)
      if (sharesRes.ok) setShares(((await sharesRes.json()) as { shares: typeof shares }).shares)
      if (membersRes.ok) {
        setMembers(((await membersRes.json()) as { members: WorkspaceMember[] }).members)
      }
    } finally {
      setLoading(false)
    }
  }, [packageId])

  useEffect(() => {
    void load()
  }, [load])

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/account/knowledge-packages/${packageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        await load()
        onChanged()
      }
    } finally {
      setBusy(false)
    }
  }

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const deletePackage = async () => {
    setBusy(true)
    const res = await fetch(`/api/account/knowledge-packages/${packageId}`, {
      method: 'DELETE',
    })
    setBusy(false)
    setConfirmingDelete(false)
    if (res.ok) {
      onChanged()
      onClose()
    } else {
      toast.error('Failed to delete the package')
    }
  }

  const exportPackage = async (format: 'markdown' | 'jsonl') => {
    if (!detail) return
    setExporting(format)
    try {
      const ext = format === 'markdown' ? 'md' : 'jsonl'
      const saved = await downloadFile(
        `${detail.export_url}?format=${format}`,
        `${detail.package.slug || 'knowledge-package'}.${ext}`,
      )
      // null = user cancelled the save dialog — stay quiet
      if (saved !== null) toast.success(`Exported ${saved}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(null)
    }
  }

  const addShare = async () => {
    if (!shareMemberId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/account/knowledge-packages/${packageId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: shareMemberId, access_level: 'view' }),
      }).catch(() => null)
      if (res?.ok) setShareMemberId('')
      else toast.error('Failed to share the package')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const removeShare = async (shareId: string) => {
    setBusy(true)
    try {
      const res = await fetch(
        `/api/account/knowledge-packages/${packageId}/shares?share_id=${shareId}`,
        { method: 'DELETE' },
      ).catch(() => null)
      if (!res?.ok) toast.error('Failed to remove access')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-border bg-card absolute inset-y-0 right-0 z-20 flex w-[26rem] shrink-0 flex-col border-l shadow-xl">
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          Package
        </span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-1 transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {loading || !detail ? (
        <div className="flex flex-1 items-center justify-center">
          <ThinkingOrb state="weaving" size={20} theme="auto" />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-4">
            <div>
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-foreground text-base font-semibold">
                  {detail.package.name}
                </h3>
                <VisibilityBadge visibility={detail.package.visibility} />
              </div>
              {detail.package.description && (
                <p className="text-muted-foreground mt-1 text-sm">
                  {detail.package.description}
                </p>
              )}
            </div>

            {/* Controls */}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={detail.package.visibility}
                onValueChange={(v) => void patch({ visibility: v })}
                disabled={busy}
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workspace">Workspace</SelectItem>
                  <SelectItem value="personal">Private (only me)</SelectItem>
                  {detail.package.visibility === 'team' && (
                    <SelectItem value="team">Team</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                disabled={exporting !== null}
                onClick={() => void exportPackage('markdown')}
              >
                {exporting === 'markdown' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
                Markdown
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                disabled={exporting !== null}
                onClick={() => void exportPackage('jsonl')}
              >
                {exporting === 'jsonl' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
                JSONL
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive h-8 gap-1 text-xs"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
              <ConfirmDialog
                open={confirmingDelete}
                onOpenChange={setConfirmingDelete}
                title="Delete package"
                description={`This deletes "${detail.package.name}" and its shares. The claims themselves are untouched — a package is a view over the graph, not the storage.`}
                busy={busy}
                onConfirm={() => void deletePackage()}
              />
            </div>

            {/* Shares */}
            <div>
              <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                Shared with
              </p>
              <div className="space-y-1.5">
                {shares.map((s) => (
                  <div
                    key={s.id}
                    className="border-border bg-background/50 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                  >
                    {s.team ? (
                      <Users className="text-muted-foreground h-3 w-3" />
                    ) : (
                      <Lock className="text-muted-foreground h-3 w-3" />
                    )}
                    <span className="text-foreground min-w-0 flex-1 truncate">
                      {s.team?.name ?? s.member?.display_name ?? 'Member'}
                    </span>
                    <span className="text-muted-foreground">{s.access_level}</span>
                    <button
                      type="button"
                      onClick={() => void removeShare(s.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Remove share"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {shares.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    No individual grants — visibility controls who sees this.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Select value={shareMemberId} onValueChange={setShareMemberId}>
                    <SelectTrigger className="h-8 flex-1 text-xs">
                      <SelectValue placeholder="Share with a member…" />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.display_name ?? m.id.slice(0, 8)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    onClick={() => void addShare()}
                    disabled={!shareMemberId || busy}
                  >
                    <Plus className="h-3 w-3" />
                    Share
                  </Button>
                </div>
              </div>
            </div>

            {/* Brief */}
            {detail.brief ? (
              <div>
                <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                  Brief · compiled {timeAgo(detail.brief.generated_at)}
                </p>
                <div className="border-border bg-background/50 rounded-md border p-3 text-sm">
                  <Markdown className="prose prose-sm dark:prose-invert max-w-none">
                    {detail.brief.content}
                  </Markdown>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                Brief compiles on the next nightly weaver run.
              </p>
            )}

            {/* Pinned items */}
            {detail.items.length > 0 && (
              <div>
                <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                  Pinned ({detail.items.length})
                </p>
                <div className="space-y-1">
                  {detail.items.map((it) => (
                    <div
                      key={`${it.entity_type}:${it.entity_id}`}
                      className="text-foreground flex items-center gap-2 text-xs"
                    >
                      <Archive className="text-muted-foreground h-3 w-3 shrink-0" />
                      <span className="text-muted-foreground shrink-0 capitalize">
                        {it.entity_type}
                      </span>
                      <span className="min-w-0 truncate">
                        {it.label ?? it.entity_id.slice(0, 8)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Resolved claims */}
            <div>
              <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                Claims in scope ({detail.claims.length})
              </p>
              <div className="space-y-1.5">
                {detail.claims.map((c) => (
                  <div
                    key={c.id}
                    className="border-border bg-background/50 rounded-md border p-2"
                  >
                    <p className="text-foreground line-clamp-3 text-xs leading-snug">
                      {c.text}
                    </p>
                    <p className="text-muted-foreground mt-1 text-[10px]">
                      {c.type.replace('_', ' ')} · {c.confirmation}
                      {c.confidence != null && ` · ${Math.round(c.confidence * 100)}%`}
                    </p>
                  </div>
                ))}
                {detail.claims.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    Nothing in scope yet — pin items or add rules.
                  </p>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

// ─── Promote dialog (shared with the graph view) ─────────────────────────────

export interface PromoteLiveRules {
  projects?: string[]
  types?: string[]
  since?: string
  min_confidence?: number
  include_suggested?: boolean
}

/**
 * Creates a package from a context — a project row (live rules only) or a
 * graph filter (live rules and/or frozen pins). When both `liveRules` and
 * `frozenClaimIds` are provided the user chooses; a context that can't be
 * expressed as rules passes only `frozenClaimIds`.
 */
export function PromotePackageDialog({
  open,
  onOpenChange,
  defaultName,
  liveRules,
  liveDescription,
  frozenClaimIds,
  frozenTotal,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultName: string
  liveRules?: PromoteLiveRules
  liveDescription?: string
  frozenClaimIds?: string[]
  /**
   * How many claims the frozen set is drawn FROM, when that differs from
   * `frozenClaimIds.length`. The map path is handed the server's top 50 and
   * never holds the rest, so without this the "top 50 of N" sentence would
   * either vanish or have to lie about N. Copy only — the pins still come from
   * `frozenClaimIds`. Omitted, the count is the id list's length, which is what
   * the Library and legacy graph paths have always used.
   */
  frozenTotal?: number
  onCreated: (pkg: { id: string; name: string }) => void
}) {
  const [name, setName] = useState(defaultName)
  const [visibility, setVisibility] = useState<'workspace' | 'personal'>('workspace')
  const [mode, setMode] = useState<'live' | 'frozen'>(liveRules ? 'live' : 'frozen')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset on open / a new target — keyed on whether live rules EXIST, not on
  // the object: callers pass a fresh `liveRules` object on every re-render (a
  // realtime reload, a map meta update), which would otherwise wipe the typed
  // name and flip a chosen "Frozen" back to "Live" while the dialog is open.
  const hasLiveRules = !!liveRules
  useEffect(() => {
    setName(defaultName)
    setMode(hasLiveRules ? 'live' : 'frozen')
    setError(null)
  }, [defaultName, hasLiveRules, open])

  const bothModes = !!liveRules && !!frozenClaimIds?.length
  // What the snapshot is drawn from. `frozenTotal` wins when the caller knows
  // a count the id list cannot express, but never shrinks below the ids we
  // actually hold — a stale total must not make the copy claim fewer matches
  // than the pins it is about to send.
  const frozenMatchCount = Math.max(frozenTotal ?? 0, frozenClaimIds?.length ?? 0)
  const frozenOverflow = frozenMatchCount > 50

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { name, visibility }
      if (mode === 'live' && liveRules) {
        body.rules = liveRules
      } else if (frozenClaimIds?.length) {
        // Pins cap at 50 — keep the strongest matches.
        body.pins = frozenClaimIds.slice(0, 50).map((id) => ({
          entity_type: 'claim',
          entity_id: id,
        }))
      }
      const res = await fetch('/api/account/knowledge-packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null
        setError(json?.error ?? 'Failed to create the package.')
        return
      }
      const json = (await res.json()) as { package: { id: string; name: string } }
      onCreated(json.package)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote to package</DialogTitle>
          <DialogDescription>
            A package is a gated, shareable, exportable view over the knowledge
            graph — the claims themselves never move.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-foreground text-xs font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <label className="text-foreground text-xs font-medium">Visibility</label>
            <Select
              value={visibility}
              onValueChange={(v) => setVisibility(v as 'workspace' | 'personal')}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace">Workspace — everyone</SelectItem>
                <SelectItem value="personal">Private — only me</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {bothModes && (
            <div className="space-y-1.5">
              <label className="text-foreground text-xs font-medium">Contents</label>
              <div className="space-y-1.5">
                <ModeOption
                  selected={mode === 'live'}
                  onSelect={() => setMode('live')}
                  title="Live — keeps growing"
                  body={
                    liveDescription ??
                    'The current filter becomes a standing rule; matching claims flow in (and superseded ones drop out) automatically.'
                  }
                />
                <ModeOption
                  selected={mode === 'frozen'}
                  onSelect={() => setMode('frozen')}
                  title="Frozen — snapshot of now"
                  body={`Pin the ${Math.min(frozenClaimIds!.length, 50)} current matches as a fixed set${
                    frozenOverflow ? ` (top 50 of ${frozenMatchCount} by confidence)` : ''
                  }.`}
                />
              </div>
            </div>
          )}
          {!bothModes && liveRules && liveDescription && (
            <p className="text-muted-foreground text-xs">{liveDescription}</p>
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Create package
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModeOption({
  selected,
  onSelect,
  title,
  body,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  body: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'border-border w-full rounded-md border p-2.5 text-left transition-colors',
        selected ? 'border-foreground/50 bg-accent/50' : 'hover:border-foreground/30',
      )}
    >
      <p className="text-foreground text-xs font-medium">{title}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{body}</p>
    </button>
  )
}
