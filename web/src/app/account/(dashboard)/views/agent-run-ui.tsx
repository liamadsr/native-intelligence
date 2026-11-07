'use client'

/**
 * Shared presentational primitives for rendering a cloud (Vercel Sandbox) agent
 * run: the status vocabulary, the elapsed/meta helpers, and the <Terminal> log
 * surface. Extracted from cloud-run-view.tsx so BOTH the action-detail Cloud-run
 * view (action-scoped) and the standalone /account/agent-runs/[id] deep-link
 * page (run-id-scoped, serves flow-origin runs) render runs identically.
 */
import {
  Loader2,
  GitPullRequest,
  CircleCheck,
  CircleAlert,
  CircleSlash,
  CircleDot,
  Clock,
  MessageCircleQuestion,
  Package,
  AudioLines,
  FileText,
  User,
  FolderKanban,
  SquareCheckBig,
  Target,
  RefreshCw,
  Mail,
  Paperclip,
  MessageSquare,
  Quote,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  isAgentRunLive,
  type AgentRunStatus,
  type PendingInput,
  type WorkDeliverable,
  type WorkResourceRef,
} from '@/lib/agent-run/types'
import { Linkify } from '@/components/ui/linkify'

// Re-export the shared status union so existing importers of this module keep
// working while the vocabulary lives in ONE place (@/lib/agent-run/types).
export type { AgentRunStatus }

/** One agent run, as returned by the agent-runs routes. Two kinds share this
 *  shape: 'coding' (repo → PR; carries repo/pr/branch) and 'workspace' (an
 *  approved piece of work; carries task/result/deliverables/resources). The
 *  workspace fields are optional so a coding run degrades to the original shape. */
export interface AgentRun {
  id: string
  status: AgentRunStatus
  sandbox_id: string | null
  repo_full_name: string | null
  pr_url: string | null
  branch: string | null
  error_message: string | null
  log_tail: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  agent: { id: string; name: string; avatar_url: string | null } | null
  // ── workspace-kind fields (Loops v3) ──
  kind?: 'coding' | 'workspace'
  task_prompt?: string | null
  result_summary?: string | null
  deliverables?: WorkDeliverable[] | null
  resources?: WorkResourceRef[] | null
  attention_item_id?: string | null
  action?: { id: string; title: string | null; identifier: string | null } | null
  // ── interactive-work-run fields (Loops v3 Phase 3) ──
  /** Present iff status='needs_input' — the mid-run question(s) to render.
   *  `session_state` (the resume token) is server-only and never rides here. */
  pending_input?: PendingInput | null
  /** True when the run is terminal AND its parked eve session is reachable — the
   *  follow-up chat is offered. Derived server-side (terminal && session_state). */
  can_chat?: boolean
}

/** A run is "live" (still progressing) when it hasn't reached a terminal state.
 *  Delegates to the shared vocabulary so `needs_input` (a parked work run) is
 *  correctly live — polling continues while the run waits on the user. */
export function isLive(status: AgentRunStatus): boolean {
  return isAgentRunLive(status)
}

/** Whether the run can still be stopped. A parked (`needs_input`) run IS
 *  cancelable — Stop lets the user abandon the work without answering; only
 *  `canceling` (mid-teardown) drops the Stop affordance. */
export function isCancelable(status: AgentRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'needs_input'
}

export const STATUS_META: Record<
  AgentRunStatus,
  { label: string; tone: string; icon: React.ComponentType<{ className?: string }>; spin?: boolean; pulse?: boolean }
> = {
  queued: { label: 'Queued', tone: 'text-muted-foreground', icon: Clock },
  running: { label: 'Running', tone: 'text-blue-500', icon: Loader2, spin: true },
  needs_input: { label: 'Needs your input', tone: 'text-amber-600 dark:text-amber-400', icon: MessageCircleQuestion, pulse: true },
  canceling: { label: 'Stopping…', tone: 'text-muted-foreground', icon: Loader2, spin: true },
  pr_open: { label: 'PR opened', tone: 'text-emerald-500', icon: GitPullRequest },
  completed: { label: 'Completed', tone: 'text-emerald-500', icon: CircleCheck },
  failed: { label: 'Failed', tone: 'text-destructive', icon: CircleAlert },
  canceled: { label: 'Canceled', tone: 'text-muted-foreground', icon: CircleSlash },
}

export function elapsed(start: string | null, end: string | null): string | null {
  if (!start) return null
  const a = new Date(start).getTime()
  const b = end ? new Date(end).getTime() : Date.now()
  const s = Math.max(0, Math.round((b - a) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** A "label · label · label" metadata line that drops empty segments. */
export function metaLine(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' · ')
}

// ─── Terminal ────────────────────────────────────────────────────────
//
// A real terminal surface: dark chrome with a macOS-style title bar (traffic
// lights + a tty label), monospace output on near-black, and per-line tinting
// so commands, agent steps, the PR link, and errors read distinctly. Stays dark
// in both themes — a terminal is one of the few places a dark surface is the
// expected convention.

/** Classify a log line so we can tint it like a real shell would. */
function lineClass(line: string): string {
  const t = line.trimStart()
  if (/^DIAL8_PR_URL=/.test(t) || /https?:\/\/github\.com\/\S+\/pull\/\d+/.test(t)) {
    return 'text-emerald-400 font-medium'
  }
  if (/^(error|fatal|err!|npm err)/i.test(t) || /\b(failed|error)\b/i.test(t)) {
    return 'text-red-400'
  }
  if (/^[$+>]/.test(t) || /^(git|npx|npm|cd|sandbox ready)/i.test(t)) {
    return 'text-emerald-300/90'
  }
  if (/^\[agent\]/i.test(t)) {
    return 'text-sky-300/90'
  }
  if (/…$/.test(t) || /^(launching|switched|installing)/i.test(t)) {
    return 'text-zinc-400'
  }
  return 'text-zinc-300'
}

export function Terminal({
  log,
  sandboxId,
  live,
  logRef,
  onScroll,
}: {
  log: string | null
  sandboxId: string | null
  live: boolean
  logRef: React.RefObject<HTMLPreElement | null>
  onScroll: (e: React.UIEvent<HTMLPreElement>) => void
}) {
  const trimmed = log?.trim() || ''
  const lines = trimmed ? trimmed.split('\n') : []

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-sm dark:shadow-none">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <span className="ml-1.5 truncate font-mono text-[11px] text-zinc-400">
          {sandboxId ? `dial8@${sandboxId}` : 'dial8-sandbox'}
        </span>
        {live && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-400">
            <CircleDot className="h-2.5 w-2.5 animate-pulse text-emerald-400" />
            live
          </span>
        )}
      </div>

      {/* Output */}
      <pre
        ref={logRef}
        onScroll={onScroll}
        className="max-h-[460px] overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[11.5px] leading-[1.6] text-zinc-300 [scrollbar-width:thin]"
      >
        {lines.length > 0 ? (
          lines.map((line, i) => {
            const isLast = i === lines.length - 1
            return (
              <div key={i} className={cn('min-h-[1.6em]', lineClass(line))}>
                {line || ' '}
                {live && isLast && (
                  <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-px animate-pulse bg-emerald-400 align-middle" />
                )}
              </div>
            )
          })
        ) : (
          <div className="flex items-center gap-1.5 text-zinc-500">
            {live ? (
              <>
                Waiting for output
                <span className="inline-block h-3 w-1.5 animate-pulse bg-emerald-400 align-middle" />
              </>
            ) : (
              'No logs captured.'
            )}
          </div>
        )}
      </pre>
    </div>
  )
}

// ─── Workspace-run detail primitives (Loops v3) ──────────────────────────────
//
// Shared between the standalone /account/agent-runs/[id] page and the Loop
// Activity drill-in so a work run renders identically in both. The deliverable
// links defer navigation to a callback — the page uses hrefs, the drill-in uses
// the tab-context buildEntryForDetail pattern.

/** The task the work run was given, in a quiet bordered block. */
export function WorkTask({ task }: { task: string | null | undefined }) {
  if (!task) return null
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Task</p>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80"><Linkify text={task} /></p>
    </div>
  )
}

/**
 * Per-type icon for a declared work resource. Keyed on the `WorkResourceRef.type`
 * string (the WORK_RESOURCE_TYPES set). Icons match the app's existing entity
 * conventions where one dominates (project→FolderKanban and member→User mirror
 * the filter-field picker; initiative→Target mirrors nav + create-dialog), and
 * fall back to the design contract's list otherwise. An unknown type gets no icon.
 */
const RESOURCE_TYPE_ICONS: Record<string, LucideIcon> = {
  package: Package,
  capture: AudioLines,
  document: FileText,
  contact: User,
  project: FolderKanban,
  action: SquareCheckBig,
  initiative: Target,
  cycle: RefreshCw,
  email: Mail,
  attachment: Paperclip,
  member: User,
  conversation: MessageSquare,
  claim: Quote,
}

/**
 * Resource types the caller can navigate to. The DetailPanel-backed entity types
 * (action/capture/document/contact/project/initiative) plus 'package' (a deep
 * link into the Knowledge library). Everything else stays a static chip even when
 * `onOpen` and an id are present — there's no surface to open it in.
 */
const RESOURCE_OPENABLE_TYPES = new Set([
  'action',
  'capture',
  'document',
  'contact',
  'project',
  'initiative',
  'package',
])

/** True when a chip should be an interactive button: the caller wired `onOpen`,
 *  the ref carries an id, and its type has a navigation target. */
export function isResourceOpenable(
  r: WorkResourceRef,
  onOpen?: (r: WorkResourceRef) => void,
): boolean {
  return !!onOpen && !!r.id && RESOURCE_OPENABLE_TYPES.has(r.type)
}

/**
 * The declared resources the run drew on — per-type icon + label chips. A chip
 * becomes a click-to-open button only when `onOpen` is provided AND the ref has
 * an id AND its type has a navigation target (see RESOURCE_OPENABLE_TYPES);
 * everything else stays a static span.
 */
export function WorkResources({
  resources,
  onOpen,
  label = 'Used',
}: {
  resources: WorkResourceRef[] | null | undefined
  onOpen?: (r: WorkResourceRef) => void
  /** Section label — 'Used' on run views, 'Will use' on the pre-run card. */
  label?: string
}) {
  if (!resources || resources.length === 0) return null
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {resources.map((r, i) => {
          const Icon = RESOURCE_TYPE_ICONS[r.type]
          const icon = Icon ? (
            <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          ) : null
          const openable = isResourceOpenable(r, onOpen)
          const chipClass =
            'inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground/70'
          if (openable) {
            return (
              <button
                key={i}
                type="button"
                onClick={() => onOpen!(r)}
                className={cn(chipClass, 'transition-colors hover:border-foreground/30 hover:bg-muted/70')}
                title={r.label}
              >
                {icon}
                <span className="truncate">{r.label}</span>
              </button>
            )
          }
          return (
            <span key={i} className={chipClass} title={r.label}>
              {icon}
              <span className="truncate">{r.label}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The reviewable deliverables a completed work run produced. `document` and
 * `action` deliverables get a click affordance via `onOpen`; `email_draft`
 * shows a "in your email drafts" hint (no draft-review surface to deep-link);
 * `entity` renders as a plain chip. Rows the caller can't navigate (no onOpen,
 * or an email_draft) fall back to a non-interactive chip.
 */
export function WorkDeliverables({
  deliverables,
  onOpen,
}: {
  deliverables: WorkDeliverable[] | null | undefined
  onOpen?: (d: WorkDeliverable) => void
}) {
  if (!deliverables || deliverables.length === 0) return null
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Delivered</p>
      <ul className="space-y-1">
        {deliverables.map((d, i) => {
          const openable = !!onOpen && (d.type === 'document' || d.type === 'action')
          const emailHint = d.type === 'email_draft'
          return (
            <li key={i}>
              {openable ? (
                <button
                  type="button"
                  onClick={() => onOpen!(d)}
                  className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                >
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {DELIVERABLE_LABELS[d.type]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">{d.label}</span>
                  <span className="shrink-0 text-[10px] text-primary">Open</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/50 px-2.5 py-1.5 text-xs">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {DELIVERABLE_LABELS[d.type]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">{d.label}</span>
                  {emailHint && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">in your email drafts</span>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const DELIVERABLE_LABELS: Record<WorkDeliverable['type'], string> = {
  email_draft: 'Draft',
  document: 'Doc',
  action: 'Action',
  entity: 'Entity',
}
