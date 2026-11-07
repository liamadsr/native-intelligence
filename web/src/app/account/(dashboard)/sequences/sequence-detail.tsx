'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

/**
 * Sequence detail — structured on the project detail panel's shape so moving
 * between a project and a sequence feels seamless: a centered main column
 * (title, stats, sections) beside a width-driven PROPERTIES sidebar
 * (usePropertiesVisible — up when there's room, gone when there isn't).
 *
 * Header: the shared EntityDetailHeader (also the flow editor's header —
 * the two pages are deliberately identical):
 *   [Sequences › name (inline-editable)] [⋯] ···· [status pill] [actions]
 *
 * Main column: lifecycle banners, inline-editable name (always editable —
 * renames are safe mid-flight under the graduated edit rules), description,
 * the stats row (enrolled / active / replied / reply rate / failed), then
 * sections — Steps (read-only table with an edit affordance into the
 * builder), Contacts (the enrollment table), and Activity (derived from the
 * row's own timestamps, no extra queries).
 *
 * Sidebar: status, sending account (pinned at launch), timezone, send window,
 * delay unit, created by, created. All read-only here — structure fields are
 * edited in the builder (per-step guards replace the old whole-form lock),
 * and status transitions carry semantics (resume recomputes schedules,
 * archive exits enrollments) that live behind the header's explicit actions.
 *
 * Live updates: enrollment rows ride the entity bus (sequence +
 * sequence_enrollment are realtime-published, wired through
 * use-realtime-entities) via useEntityListSync → quiet refetch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Trash2,
  CalendarClock,
  Clock3,
  Globe,
  Mail,
  MailX,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Rocket,
  UserMinus,
} from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { EntityDetailHeader } from '@/components/views/entity-detail-header'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { PropertyGroup } from '@/components/views/property-group'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions, useWindowPropertiesVisible } from '@/components/views/window-properties'
import {
  EXIT_REASON_META,
  SEQUENCE_STATUS_META,
  describeEnrollmentProgress,
  describeSendWindow,
  humanizeSendTime,
  replyRate,
  timezoneAbbreviation,
} from '@/lib/sequences/ui-helpers'
import { normalizeWindow } from '@/lib/sequences/schedule'
import { useOptionalSettingsOverlay } from '../settings-overlay'
import { AddContactsDialog } from './add-contacts-dialog'
import { ReviewLaunch } from './review-launch'
import { SequenceBuilder } from './sequence-builder'
import {
  fetchEmailAccounts,
  fetchSequenceDetail,
  optOutEnrollment,
  patchSequence,
  removeEnrollment,
  type EmailAccount,
  type EnrollmentWithContact,
  type SequenceDetailPayload,
} from './api'

// Status dot colors for the sidebar row — same palette family as the project
// panel's STATUS_CONFIG dots.
const STATUS_DOT: Record<string, string> = {
  draft: 'bg-gray-400',
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  archived: 'bg-gray-400',
}

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Gmail',
  microsoft: 'Outlook',
}

interface WorkspaceMember {
  id: string
  user_id: string
  display_name: string
  avatar_url: string | null
}

export function SequenceDetail({
  sequenceId,
  onBack,
  onNameLoaded,
}: {
  sequenceId: string
  /** Breadcrumb back to the sequences list (a real history step). Required:
   *  the header always renders the 'Sequences' crumb as a clickable button,
   *  so an omitted handler would leave a dead link that looks interactive. */
  onBack: () => void
  /** Lets the parent refresh the history entry's label once the name is known. */
  onNameLoaded?: (name: string) => void
}) {
  const [detail, setDetail] = useState<SequenceDetailPayload | null>(null)
  const inWindow = useWindowPropertiesVisible() !== null
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [addingContacts, setAddingContacts] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const [optOutTarget, setOptOutTarget] = useState<EnrollmentWithContact | null>(null)
  const [transitioning, setTransitioning] = useState(false)
  // Connected mailboxes — needed to explain an engine-forced pause (the
  // engine pauses a sequence when its sending account disappears/fails, and
  // a bare "Paused" chip left the user resuming straight back into the same
  // failure) and to render the sending-account property row. null = probe
  // still in flight.
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[] | null>(null)
  const settingsOverlay = useOptionalSettingsOverlay()
  const workspaceId = useWorkspaceId()

  // Workspace members — resolves created_by (an auth user id) to a display
  // name + avatar for the sidebar. Via cachedJson so repeat opens resolve
  // from the shared cache (same as the project panel's lead picker fetch).
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  useEffect(() => {
    let cancelled = false
    cachedJson<{ members?: WorkspaceMember[] }>('/api/account/workspace', { scope: workspaceId })
      .then((d) => {
        if (!cancelled && d) setMembers(d.members ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // The page-level inspector owns visibility; standalone panels use their width.
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const propertiesOpen = usePropertiesVisible(panelBodyRef)

  // Ref'd so a parent passing a fresh arrow each render doesn't churn `load`
  // (its identity drives the fetch effect below — a dep would loop).
  const onNameLoadedRef = useRef(onNameLoaded)
  onNameLoadedRef.current = onNameLoaded
  // Don't deliver results (or the name callback) after unmount — a stale
  // fetch resolving after the user navigated away must not re-label the tab.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // In-flight inline title edit — survives quiet reloads the same way the
  // project panel's pendingTitleRef does: a realtime refetch landing mid-type
  // must not clobber what's in the input.
  const pendingNameRef = useRef<string | null>(null)
  const nameTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const payload = await fetchSequenceDetail(sequenceId)
        if (!mountedRef.current) return
        setDetail((prev) => {
          if (pendingNameRef.current !== null && prev) {
            return {
              ...payload,
              sequence: { ...payload.sequence, name: pendingNameRef.current },
            }
          }
          return payload
        })
        onNameLoadedRef.current?.(payload.sequence.name)
      } catch {
        if (!quiet && mountedRef.current) setDetail(null)
      } finally {
        if (!quiet && mountedRef.current) setLoading(false)
      }
    },
    [sequenceId],
  )

  useEffect(() => {
    setDetail(null)
    setEditing(false)
    setReviewing(false)
    load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    fetchEmailAccounts()
      .then((accounts) => {
        if (!cancelled) setEmailAccounts(accounts)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Live-update on sequence / enrollment changes (send progress, replies,
  // teammate edits). Quiet refetch keeps the table on screen.
  useEntityListSync(['sequence', 'sequence_enrollment'], () => load(true), {
    match: (d) => {
      const f = d.fields
      if (d.entityType === 'sequence') return d.id == null || d.id === sequenceId
      // Enrollment events: scope by sequence_id when present (deletes carry
      // only the pk — pass those through).
      return f?.sequence_id == null || f.sequence_id === sequenceId
    },
  })

  const stats = useMemo(() => {
    const enrollments = detail?.enrollments ?? []
    const total = enrollments.length
    const active = enrollments.filter((e) => e.status === 'active').length
    const replied = enrollments.filter((e) => e.exit_reason === 'replied').length
    const failed = enrollments.filter((e) => e.exit_reason === 'failed').length
    return { total, active, replied, failed }
  }, [detail])

  const activeStepCount = useMemo(
    () => (detail?.steps ?? []).filter((s) => s.is_active).length,
    [detail],
  )

  // Per-step edit guards (the builder pins guarded steps): the rules key on
  // where each ACTIVE enrollment stands, so hand the builder the raw orders.
  const activeEnrollmentOrders = useMemo(
    () =>
      (detail?.enrollments ?? [])
        .filter((e) => e.status === 'active')
        .map((e) => e.current_step_order),
    [detail],
  )

  const stagedCount = useMemo(
    () =>
      (detail?.enrollments ?? []).filter(
        (e) => e.status === 'active' && e.current_step_order === 0 && e.next_send_at === null,
      ).length,
    [detail],
  )

  const transition = async (status: 'active' | 'paused' | 'archived') => {
    if (!detail) return
    setTransitioning(true)
    try {
      await patchSequence(detail.sequence.id, { status })
      toast.success(
        status === 'archived'
          ? 'Sequence archived'
          : status === 'paused'
            ? 'Sequence paused'
            : 'Sequence resumed',
      )
      await load(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update sequence')
    } finally {
      setTransitioning(false)
    }
  }

  // Inline name edit (header breadcrumb + main column title). Names are
  // ALWAYS editable under the graduated edit rules — renames are harmless
  // mid-flight. Debounced like the project panel's title.
  const handleNameChange = (value: string) => {
    if (!detail) return
    setDetail({ ...detail, sequence: { ...detail.sequence, name: value } })
    pendingNameRef.current = value
    if (nameTimeoutRef.current) clearTimeout(nameTimeoutRef.current)
    nameTimeoutRef.current = setTimeout(async () => {
      pendingNameRef.current = null
      const name = value.trim()
      if (!name) return
      try {
        await patchSequence(sequenceId, { name })
        onNameLoadedRef.current?.(name)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to rename sequence')
        load(true)
      }
    }, 500)
  }
  // Leaving inside the 500 ms debounce: send the pending rename now rather
  // than dropping it with the timer (pendingNameRef is set only until it fires).
  useEffect(
    () => () => {
      if (nameTimeoutRef.current) clearTimeout(nameTimeoutRef.current)
      const name = pendingNameRef.current?.trim()
      pendingNameRef.current = null
      if (name) void patchSequence(sequenceId, { name }).catch(() => {})
    },
    [sequenceId],
  )

  const handleRemoveEnrollment = async (enrollmentId: string) => {
    if (!detail) return
    try {
      await removeEnrollment(detail.sequence.id, enrollmentId)
      toast.success('Removed from sequence — already-sent emails are not retracted')
      await load(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove')
    }
  }

  const handleOptOut = async (enrollmentId: string) => {
    if (!detail) return
    try {
      await optOutEnrollment(detail.sequence.id, enrollmentId)
      toast.success('Opted out — suppressed workspace-wide for all future sequences')
      await load(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to opt out')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sequence not found
      </div>
    )
  }

  const { sequence } = detail
  const statusMeta = SEQUENCE_STATUS_META[sequence.status]

  if (editing) {
    return (
      <SequenceBuilder
        sequence={sequence}
        steps={detail.steps}
        // Graduated per-step guards (not a whole-form lock): the builder pins
        // steps the ledger or an active enrollment still needs. Staged draft
        // enrollments are status 'active' (inert until launch), so they count
        // toward the guards too — step 1 is what they'll receive at launch.
        activeEnrollmentOrders={activeEnrollmentOrders}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false)
          load(true)
        }}
      />
    )
  }

  const canLaunch =
    sequence.status === 'draft' ||
    (sequence.status !== 'archived' && stagedCount > 0)

  // The engine pauses a sequence when its mailbox fails; the notification that
  // explains why is easy to miss, so the page itself must say so. "Missing" =
  // the accounts probe finished and either no mailbox is connected or the
  // PINNED sending account (snapshotted at launch) is gone — resuming in that
  // state just fails and re-pauses on the next dispatch tick, so Resume is
  // disabled too.
  const mailboxMissing =
    emailAccounts !== null &&
    (emailAccounts.length === 0 ||
      (sequence.sending_account_id != null &&
        !emailAccounts.some((a) => a.id === sequence.sending_account_id)))
  const pausedWithoutMailbox = sequence.status === 'paused' && mailboxMissing

  const tzAbbrev = timezoneAbbreviation(sequence.timezone)
  const tzName = sequence.timezone.replace(/_/g, ' ')
  const sendWindowLabel = describeSendWindow(normalizeWindow(sequence.send_window))
  const sendingAccount =
    sequence.sending_account_id != null
      ? emailAccounts?.find((a) => a.id === sequence.sending_account_id) ?? null
      : null
  const creator =
    sequence.created_by != null
      ? members.find((m) => m.user_id === sequence.created_by) ?? null
      : null

  // Status pill + lifecycle actions, rendered in ONE place at a time: the
  // action strip above the properties panel normally, the header's far right
  // only while that sidebar is width-collapsed. h-7 matches the strip's
  // ghost-icon idiom (the capture-detail pattern).
  const statusPillEl = statusMeta && (
    <Badge
      variant="outline"
      className={cn('h-7 shrink-0 rounded-md px-2.5 text-xs font-medium', statusMeta.className)}
    >
      {statusMeta.label}
    </Badge>
  )
  const lifecycleButtons = (
    <>
      {canLaunch && (
        <PreferenceActionButton size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setReviewing(true)}>
          <Rocket className="h-3.5 w-3.5" />
          Review &amp; launch
        </PreferenceActionButton>
      )}
      {sequence.status === 'active' && (
        <PreferenceActionButton
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => transition('paused')}
          disabled={transitioning}
        >
          <Pause className="h-3.5 w-3.5" />
          Pause
        </PreferenceActionButton>
      )}
      {sequence.status === 'paused' && (
        <PreferenceActionButton
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => transition('active')}
          disabled={transitioning || pausedWithoutMailbox}
          title={
            pausedWithoutMailbox
              ? 'The sending mailbox is no longer connected — reconnect it before resuming.'
              : undefined
          }
        >
          <Play className="h-3.5 w-3.5" />
          Resume
        </PreferenceActionButton>
      )}
    </>
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Shared detail header — identical shape to the flow editor's:
          breadcrumb + inline-editable name, ⋯ right after the name, status
          pill far right, primary actions outermost. */}
      <EntityDetailHeader
        viewTitle="Sequences"
        onBack={onBack}
        name={sequence.name}
        onNameChange={handleNameChange}
        namePlaceholder="Untitled sequence"
        statusPill={inWindow || propertiesOpen ? undefined : statusPillEl}
        actions={
          <WindowActions className="flex items-center gap-1.5">
          <PreferenceActionButton
            label="Edit sequence"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setEditing(true)}
            title="Edit sequence"
            aria-label="Edit sequence"
          >
            <Pencil className="h-3.5 w-3.5" />
          </PreferenceActionButton>
          {sequence.status !== 'archived' && (
            <PreferenceActionButton
              label="Archive sequence"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => setArchiveConfirm(true)}
              title="Archive sequence"
              aria-label="Archive sequence"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </PreferenceActionButton>
          )}
          {lifecycleButtons}
          </WindowActions>
        }
      />

      {/* Body — the project detail panel's two-column shape: centered main
          column beside a width-driven properties sidebar. */}
      <div ref={panelBodyRef} className="flex min-h-0 flex-1 justify-center">
        {/* Left: main column */}
        <div className="mx-auto flex min-h-0 w-full max-w-[736px] min-w-0 flex-col">
          <ScrollArea className="h-full">
            <div className="px-8 pb-28">
              {/* Engine-forced pause dead-end: explain WHY it's paused and how
                  to fix it (the grouped notification is easy to miss, and
                  Resume alone would fail straight back into the same pause). */}
              {pausedWithoutMailbox && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      Paused: the sending mailbox is no longer connected.
                    </span>{' '}
                    Reconnect Gmail or Outlook before resuming — resuming without it
                    fails and pauses the sequence again.
                  </span>
                  {settingsOverlay && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 shrink-0 border-red-500/40 text-xs"
                      onClick={() => settingsOverlay.openSettings('connectors')}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              )}

              {/* Contacts staged AFTER launch are inert (next_send_at NULL)
                  until Review & launch runs again — without this banner they
                  look like healthy pre-launch staging and silently never send. */}
              {(sequence.status === 'active' || sequence.status === 'paused') && stagedCount > 0 && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {stagedCount} contact{stagedCount === 1 ? ' was' : 's were'} added since
                      launch and {stagedCount === 1 ? "isn't" : "aren't"} scheduled yet.
                    </span>{' '}
                    Run Review &amp; launch to schedule them — staged contacts are never
                    emailed until you do.
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 gap-1 border-amber-500/40 text-xs"
                    onClick={() => setReviewing(true)}
                  >
                    <Rocket className="h-3 w-3" />
                    Review &amp; launch
                  </Button>
                </div>
              )}

              {/* Title — always inline-editable (renames are safe mid-flight
                  under the graduated edit rules). */}
              <div className="pt-6 pb-2">
                <EntityTitleInput
                  value={sequence.name}
                  onChange={handleNameChange}
                  placeholder="Untitled sequence"
                />
              </div>

              {/* Description — a structure field, edited in the builder. */}
              {sequence.description && (
                <p className="mt-1 text-sm text-muted-foreground">{sequence.description}</p>
              )}

              {/* Stats row */}
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
                {[
                  { label: 'Enrolled', value: String(stats.total) },
                  { label: 'Active', value: String(stats.active) },
                  { label: 'Replied', value: String(stats.replied) },
                  { label: 'Reply rate', value: replyRate(stats.replied, stats.total) },
                  { label: 'Failed', value: String(stats.failed) },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border px-3 py-2.5">
                    <p className="text-lg font-semibold tabular-nums">{s.value}</p>
                    <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Frame of reference for every time on this page: send times are
                  wall-clock in the SEQUENCE's zone, not the viewer's. */}
              <p className="mt-3 text-[11px] text-muted-foreground">
                Sends {sendWindowLabel && `${sendWindowLabel} `}in {tzName}
                {tzAbbrev !== tzName && ` (${tzAbbrev})`} — all times below are shown in that
                timezone.
              </p>

              {/* Steps */}
              <div className="mt-8 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Steps
                  </p>
                  <button
                    className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground/80"
                    onClick={() => setEditing(true)}
                    title="Edit steps"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </button>
                </div>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Step</th>
                        <th className="px-3 py-2 font-medium">Subject</th>
                        <th className="px-3 py-2 font-medium">Delay</th>
                        <th className="px-3 py-2 text-right font-medium">Sent</th>
                        <th className="px-3 py-2 text-right font-medium">Failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.steps
                        .filter((s) => s.is_active)
                        .map((step) => (
                          <tr key={step.id} className="border-b last:border-0">
                            <td className="px-3 py-2 text-muted-foreground">{step.step_order}</td>
                            <td className="max-w-[280px] truncate px-3 py-2">
                              {step.subject ?? (
                                <span className="italic text-muted-foreground">
                                  Re: same thread as step 1
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {step.step_order === 1
                                ? 'At launch'
                                : `+${step.delay_days} ${sequence.delay_unit === 'business' ? 'business ' : ''}day${step.delay_days === 1 ? '' : 's'}`}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{step.counts.sent}</td>
                            <td
                              className={cn(
                                'px-3 py-2 text-right tabular-nums',
                                step.counts.failed > 0 && 'text-red-600 dark:text-red-400',
                              )}
                            >
                              {step.counts.failed}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Contacts (enrollments) */}
              <div className="mt-8 space-y-3">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Contacts
                  </p>
                  {sequence.status !== 'archived' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 gap-1.5 text-muted-foreground"
                      onClick={() => setAddingContacts(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add contacts
                    </Button>
                  )}
                </div>
                {detail.enrollments.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                    No contacts yet. Add contacts here, or select rows in the CRM and use
                    &ldquo;Add to sequence&rdquo;.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Contact</th>
                          <th className="px-3 py-2 font-medium">Progress</th>
                          {/* The humanizer renders in the SEQUENCE's zone — label
                              it, or a viewer elsewhere reads the times as local. */}
                          <th className="px-3 py-2 font-medium">Next email ({tzAbbrev})</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {detail.enrollments.map((e) => {
                          const exitMeta = e.exit_reason ? EXIT_REASON_META[e.exit_reason] : null
                          const staged =
                            e.status === 'active' &&
                            e.current_step_order === 0 &&
                            e.next_send_at === null
                          return (
                            <tr key={e.id} className="border-b last:border-0">
                              <td className="px-3 py-2">
                                <p className="truncate font-medium">
                                  {e.contact?.full_name || e.contact_email}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {e.contact?.email ?? e.contact_email}
                                </p>
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                {describeEnrollmentProgress(
                                  e.current_step_order,
                                  activeStepCount,
                                  e.status,
                                )}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                {e.status !== 'active'
                                  ? '—'
                                  : staged
                                    ? 'On launch'
                                    : humanizeSendTime(e.next_send_at, sequence.timezone)}
                              </td>
                              <td className="px-3 py-2">
                                {e.status === 'active' ? (
                                  <Badge
                                    variant="outline"
                                    className="border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] text-emerald-700 dark:text-emerald-400"
                                  >
                                    {staged ? 'Staged' : 'Active'}
                                  </Badge>
                                ) : exitMeta ? (
                                  <Badge
                                    variant="outline"
                                    className={cn('px-1.5 py-0 text-[10px]', exitMeta.className)}
                                  >
                                    {exitMeta.label}
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                                    Exited
                                  </Badge>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {e.status === 'active' && (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0 text-muted-foreground"
                                      >
                                        <MoreHorizontal className="h-3.5 w-3.5" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem onClick={() => handleRemoveEnrollment(e.id)}>
                                        <UserMinus className="mr-2 h-3.5 w-3.5" />
                                        Remove (sent emails stay sent)
                                      </DropdownMenuItem>
                                      {/* Confirmed via AlertDialog below — this is an
                                          irreversible WORKSPACE-WIDE suppression, not a
                                          remove-from-this-sequence. */}
                                      <DropdownMenuItem onClick={() => setOptOutTarget(e)}>
                                        <MailX className="mr-2 h-3.5 w-3.5" />
                                        Mark opted out
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Removing a contact stops future steps; emails already sent are never retracted.
                  Replies stop a contact&apos;s sequence automatically.
                </p>
              </div>

              {/* Activity — derived from the row's own timestamps (no extra
                  queries), same shape as the project panel's Activity rail. */}
              <div className="mt-8 space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Activity
                </p>
                <div className="relative space-y-0">
                  <div className="absolute bottom-3 left-[9px] top-3 w-px bg-border" />
                  {sequence.updated_at !== sequence.created_at && (
                    <div className="relative flex items-start gap-3 py-1.5">
                      <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                        <span
                          className={cn(
                            'h-2.5 w-2.5 rounded-full',
                            STATUS_DOT[sequence.status] ?? 'bg-gray-400',
                          )}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Last updated &middot; {formatRelativeTime(sequence.updated_at)}
                      </p>
                    </div>
                  )}
                  <div className="relative flex items-start gap-3 py-1.5">
                    <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                      <Plus className="h-2.5 w-2.5 text-green-500" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Created &middot; {formatRelativeTime(sequence.created_at)}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>
        </div>

        {/* Right: properties sidebar (Linear-style, matches the project panel).
            Read-only rows — structure fields are edited in the builder, status
            through the header's lifecycle actions. */}
        <WindowProperties key={sequenceId} title={sequence.name} fallbackVisible={propertiesOpen}>
                <div className="space-y-4 p-4">
                  <PropertyGroup title="Properties">
                    {/* Status */}
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <span
                        className={cn(
                          'h-4 w-4 shrink-0 rounded-full',
                          STATUS_DOT[sequence.status] ?? 'bg-gray-400',
                        )}
                      />
                      <span className="truncate">{statusMeta?.label ?? sequence.status}</span>
                    </div>

                    {/* Sending account — pinned at launch; read-only after. */}
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {sequence.sending_account_id == null ? (
                        <span className="truncate text-muted-foreground">
                          Sending account set at launch
                        </span>
                      ) : sendingAccount ? (
                        <>
                          <span className="min-w-0 flex-1 truncate">
                            {sendingAccount.account_email ?? sendingAccount.display_name ?? 'Mailbox'}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {PROVIDER_LABELS[sendingAccount.provider] ?? sendingAccount.provider}
                          </span>
                        </>
                      ) : (
                        <span className="truncate text-red-600 dark:text-red-400">
                          {emailAccounts === null ? 'Loading…' : 'Mailbox disconnected'}
                        </span>
                      )}
                    </div>

                    {/* Timezone */}
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{tzName}</span>
                      {tzAbbrev !== tzName && (
                        <span className="shrink-0 text-xs text-muted-foreground">{tzAbbrev}</span>
                      )}
                    </div>

                    {/* Send window */}
                    {sendWindowLabel && (
                      <div className="flex h-8 items-center gap-2 px-2 text-sm">
                        <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{sendWindowLabel}</span>
                      </div>
                    )}

                    {/* Delay unit */}
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {sequence.delay_unit === 'business'
                          ? 'Delays in business days'
                          : 'Delays in calendar days'}
                      </span>
                    </div>

                    {/* Created by */}
                    {creator && (
                      <div className="flex h-8 items-center gap-2 px-2 text-sm">
                        <Avatar className="h-4 w-4 shrink-0">
                          {creator.avatar_url && <AvatarImage src={creator.avatar_url} />}
                          <AvatarFallback className="bg-muted/40 text-[8px]">
                            {getInitials(creator.display_name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1 truncate">{creator.display_name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">Creator</span>
                      </div>
                    )}

                    {/* Created */}
                    <div className="flex h-8 items-center gap-2 px-2 text-sm">
                      <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        Created {formatDateStr(sequence.created_at)}
                      </span>
                    </div>
                  </PropertyGroup>
                </div>
              </WindowProperties>
      </div>

      {/* Review & Launch overlay */}
      {reviewing && (
        <ReviewLaunch
          detail={detail}
          onClose={() => setReviewing(false)}
          onLaunched={() => {
            setReviewing(false)
            load(true)
          }}
        />
      )}

      <AddContactsDialog
        sequenceId={sequence.id}
        sequenceStatus={sequence.status}
        open={addingContacts}
        onOpenChange={setAddingContacts}
        onEnrolled={() => load(true)}
      />

      {/* Opt-out confirmation — one click here writes a PERMANENT workspace-wide
          suppression row, so it must not fire from a bare menu item. */}
      <AlertDialog
        open={optOutTarget !== null}
        onOpenChange={(open) => {
          if (!open) setOptOutTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark {optOutTarget?.contact?.email ?? optOutTarget?.contact_email} as opted out?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This adds them to the workspace do-not-email list — they&apos;ll be skipped by
              every current and future sequence, for everyone in this workspace, and there is
              no way to undo it from this page. Already-sent emails are not retracted. To only
              stop this sequence, use &ldquo;Remove&rdquo; instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                const target = optOutTarget
                setOptOutTarget(null)
                if (target) await handleOptOut(target.id)
              }}
            >
              Opt out workspace-wide
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiveConfirm} onOpenChange={setArchiveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {sequence.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This exits {stats.active} active enrollment{stats.active === 1 ? '' : 's'};
              already-sent emails are not retracted. Archived sequences keep their history and
              cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={transitioning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={transitioning}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                await transition('archived')
                setArchiveConfirm(false)
              }}
            >
              {transitioning ? 'Archiving…' : 'Archive'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ============================================================
// Helpers (same shapes as the project detail panel's)
// ============================================================

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function formatDateStr(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
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
