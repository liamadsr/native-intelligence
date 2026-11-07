'use client'

/**
 * Review & Launch — the full-screen flow that turns STAGED enrollments into
 * scheduled sends. Left: one row per staged enrollment (status active,
 * step 0, next_send_at NULL — exactly the set the launch route arms; contacts
 * already mid-flight are counted in a note but not listed, since their earlier
 * steps have already gone out and edits here would misleadingly re-render
 * them). A warning badge marks anyone whose rendered emails still contain
 * unresolved tokens. Right: the rendered preview of EVERY step for the
 * selected contact (subject + body, tokens resolved with real contact data,
 * overrides applied), with inline per-step subject/body edits that are stored
 * as enrollment overrides and submitted with the launch.
 *
 * The client render uses the same template lib as the engine
 * (renderSequencePreview mirrors buildStepEmail), so the Launch button blocks
 * on exactly what the launch route would 400 on. If the server still returns
 * 'unresolved_tokens' (e.g. contact data changed underneath us), the failures
 * are mapped back onto the rows.
 *
 * Contact data: the sequence detail payload only carries (full_name, email),
 * but tokens also need first/last/company — so the workspace contact list is
 * fetched once and joined by id, with per-id fallback fetches for contacts
 * beyond the first page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle2, Pencil, Rocket, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { EnrollmentOverrides, StepOverride } from '@/lib/sequences/types'
import type { SequenceContactVars } from '@/lib/sequences/template'
import {
  groupLaunchFailures,
  renderSequencePreview,
  unresolvedTokenLabel,
  type EnrollmentFailureSummary,
} from '@/lib/sequences/ui-helpers'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { useOptionalSettingsOverlay } from '../settings-overlay'
import {
  SequencesRequestError,
  fetchEmailAccounts,
  launchFailuresFromError,
  launchSequence,
  type EmailAccount,
  type SequenceDetailPayload,
} from './api'

// ── Contact enrichment ───────────────────────────────────────────────────

interface EnrichedContact {
  id: string
  first_name: string | null
  last_name: string | null
  full_name: string | null
  email: string | null
  company: { name: string | null } | null
}

async function loadContactVars(
  contactIds: string[],
): Promise<Map<string, SequenceContactVars>> {
  const map = new Map<string, SequenceContactVars>()
  const wanted = new Set(contactIds)
  try {
    const res = await fetch('/api/account/contacts?limit=200')
    if (res.ok) {
      const data = (await res.json()) as { contacts: EnrichedContact[] }
      for (const c of data.contacts ?? []) {
        if (!wanted.has(c.id)) continue
        map.set(c.id, {
          first_name: c.first_name,
          last_name: c.last_name,
          full_name: c.full_name,
          company: c.company?.name ?? null,
          email: c.email,
        })
      }
    }
  } catch {
    /* fall through to per-id fetches */
  }
  const missing = contactIds.filter((id) => !map.has(id))
  await Promise.all(
    missing.map(async (id) => {
      try {
        const res = await fetch(`/api/account/contacts/${id}`)
        if (!res.ok) return
        const data = (await res.json()) as { contact?: EnrichedContact }
        const c = data.contact
        if (!c) return
        map.set(id, {
          first_name: c.first_name,
          last_name: c.last_name,
          full_name: c.full_name,
          company: c.company?.name ?? null,
          email: c.email,
        })
      } catch {
        /* stays missing — preview falls back to the enrollment snapshot */
      }
    }),
  )
  return map
}

// ── Component ────────────────────────────────────────────────────────────

export function ReviewLaunch({
  detail,
  onClose,
  onLaunched,
}: {
  detail: SequenceDetailPayload
  onClose: () => void
  onLaunched: () => void
}) {
  // Only STAGED enrollments (nothing sent, nothing scheduled) — the exact set
  // the launch route arms. Filtering on bare status === 'active' also swept in
  // mid-flight contacts on a launched sequence: the button promised
  // "Launch (18)" while the server armed 5, and the reviewer was shown
  // editable step-1 previews for people who had already received step 1.
  const stagedEnrollments = useMemo(
    () =>
      detail.enrollments.filter(
        (e) =>
          e.status === 'active' && e.current_step_order === 0 && e.next_send_at === null,
      ),
    [detail.enrollments],
  )
  const midFlightCount = useMemo(
    () =>
      detail.enrollments.filter(
        (e) =>
          e.status === 'active' && !(e.current_step_order === 0 && e.next_send_at === null),
      ).length,
    [detail.enrollments],
  )
  const activeSteps = useMemo(
    () =>
      detail.steps
        .filter((s) => s.is_active)
        .sort((a, b) => a.step_order - b.step_order),
    [detail.steps],
  )

  const [selectedId, setSelectedId] = useState<string | null>(
    stagedEnrollments[0]?.id ?? null,
  )
  const [overridesByEnrollment, setOverridesByEnrollment] = useState<
    Record<string, EnrollmentOverrides>
  >(() => {
    const initial: Record<string, EnrollmentOverrides> = {}
    for (const e of stagedEnrollments) {
      if (e.overrides && Object.keys(e.overrides).length > 0) initial[e.id] = e.overrides
    }
    return initial
  })
  const [contactVars, setContactVars] = useState<Map<string, SequenceContactVars> | null>(null)
  const settingsOverlay = useOptionalSettingsOverlay()
  const workspaceId = useWorkspaceId()
  const [sender, setSender] = useState<EmailAccount | null>(null)
  const [senderLoaded, setSenderLoaded] = useState(false)
  // The sender's HUMAN name for {{sender_name}}/{{sender_first_name}}.
  // EmailAccount.display_name is the provider label ('Gmail'), so the preview
  // has to resolve the person the same way the engine does — via the workspace
  // member row, matched on the sending mailbox's address.
  const [senderMemberName, setSenderMemberName] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [serverFailures, setServerFailures] = useState<Map<string, EnrollmentFailureSummary>>(
    new Map(),
  )
  const [launchError, setLaunchError] = useState<string | null>(null)
  /** details.code of the last launch failure — drives code-specific CTAs. */
  const [launchErrorCode, setLaunchErrorCode] = useState<string | null>(null)
  // Which step of the selected enrollment is in edit mode + its scratch values.
  const [editingStep, setEditingStep] = useState<number | null>(null)
  const [editSubject, setEditSubject] = useState('')
  const [editBody, setEditBody] = useState('')

  // Keyed on the CONTACT ID SET, not the enrollments array: the detail page
  // quiet-refetches on every realtime enrollment event while this overlay is
  // open, handing down a brand-new array each time. Keying on identity re-ran
  // the whole contact-vars fetch fan-out (a /contacts page + one request per
  // missing contact) on every event even though nothing relevant changed.
  const contactIdsKey = useMemo(
    () =>
      stagedEnrollments
        .map((e) => e.contact_id)
        .filter((id): id is string => !!id)
        .sort()
        .join(','),
    [stagedEnrollments],
  )
  useEffect(() => {
    let cancelled = false
    const contactIds = contactIdsKey === '' ? [] : contactIdsKey.split(',')
    loadContactVars(contactIds).then((map) => {
      if (!cancelled) setContactVars(map)
    })
    fetchEmailAccounts()
      .then((accounts) => {
        if (cancelled) return
        const pinned = accounts.find((a) => a.id === detail.sequence.sending_account_id)
        setSender(pinned ?? accounts[0] ?? null)
        setSenderLoaded(true)
      })
      .catch(() => {
        // Offline: preview unsigned rather than "Preparing previews…" forever.
        if (cancelled) return
        setSender(null)
        setSenderLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [contactIdsKey, detail.sequence.sending_account_id])

  // Resolve the sending mailbox to the workspace member who owns it, so the
  // preview signs with the same name the engine will send with.
  const senderEmail = sender?.account_email ?? null
  useEffect(() => {
    if (!senderEmail) return
    let cancelled = false
    cachedJson<{ members?: { display_name: string | null; email?: string | null }[] }>(
      '/api/account/workspace',
      { scope: workspaceId },
    )
      .then((d) => {
        if (cancelled || !d) return
        const match = (d.members ?? []).find(
          (m) => (m.email ?? '').toLowerCase() === senderEmail.toLowerCase(),
        )
        setSenderMemberName(match?.display_name ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [senderEmail, workspaceId])

  // A teammate removing the selected enrollment mid-review left the right
  // pane silently empty — fall back to the first remaining row.
  useEffect(() => {
    if (selectedId && stagedEnrollments.some((e) => e.id === selectedId)) return
    setSelectedId(stagedEnrollments[0]?.id ?? null)
  }, [stagedEnrollments, selectedId])

  const varsFor = useCallback(
    (enrollmentId: string): SequenceContactVars => {
      const enrollment = stagedEnrollments.find((e) => e.id === enrollmentId)
      const fromContact = enrollment?.contact_id
        ? contactVars?.get(enrollment.contact_id)
        : undefined
      if (fromContact) return fromContact
      // Fallback: the enrollment's own contact join / email snapshot.
      return {
        first_name: null,
        last_name: null,
        full_name: enrollment?.contact?.full_name ?? null,
        company: null,
        email: enrollment?.contact?.email ?? enrollment?.contact_email ?? null,
      }
    },
    [stagedEnrollments, contactVars],
  )

  const senderVars = useMemo(
    () => ({ name: senderMemberName, email: sender?.account_email ?? null }),
    [senderMemberName, sender],
  )

  // Client-side render of every enrollment × step — drives the warning badges
  // and the launch block.
  const previews = useMemo(() => {
    const map = new Map<string, ReturnType<typeof renderSequencePreview>>()
    if (!contactVars) return map
    for (const e of stagedEnrollments) {
      map.set(
        e.id,
        renderSequencePreview(
          activeSteps.map((s) => ({
            step_order: s.step_order,
            subject: s.subject,
            body: s.body,
          })),
          overridesByEnrollment[e.id] ?? {},
          varsFor(e.id),
          senderVars,
        ),
      )
    }
    return map
  }, [stagedEnrollments, activeSteps, overridesByEnrollment, contactVars, varsFor, senderVars])

  const blockedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const [id, steps] of previews) {
      if (steps.some((s) => s.unresolved.length > 0)) ids.add(id)
    }
    for (const id of serverFailures.keys()) ids.add(id)
    return ids
  }, [previews, serverFailures])

  const selected = stagedEnrollments.find((e) => e.id === selectedId) ?? null
  const selectedPreview = selectedId ? previews.get(selectedId) : undefined

  const startEdit = (stepOrder: number) => {
    if (!selectedId) return
    const step = activeSteps.find((s) => s.step_order === stepOrder)
    if (!step) return
    const override = overridesByEnrollment[selectedId]?.[String(stepOrder)]
    setEditSubject(override?.subject ?? step.subject ?? '')
    setEditBody(override?.body ?? step.body)
    setEditingStep(stepOrder)
  }

  const saveEdit = () => {
    if (!selectedId || editingStep === null) return
    const step = activeSteps.find((s) => s.step_order === editingStep)
    if (!step) return
    const entry: StepOverride = {}
    // Subject: stored only when non-empty AND different from the step's own
    // template. The engine resolves `override.subject ?? step.subject`, so a
    // null/absent override always falls back to the template — an emptied
    // field here therefore means "revert to the step's default", never
    // "force same-thread" (renderSequencePreview mirrors this exactly).
    if (editSubject !== '' && editSubject !== (step.subject ?? '')) {
      entry.subject = editSubject
    }
    if (editBody !== step.body) entry.body = editBody
    setOverridesByEnrollment((prev) => {
      const next = { ...prev }
      const perStep: EnrollmentOverrides = { ...(next[selectedId] ?? {}) }
      if (Object.keys(entry).length === 0) {
        delete perStep[String(editingStep)]
      } else {
        perStep[String(editingStep)] = entry
      }
      if (Object.keys(perStep).length === 0) delete next[selectedId]
      else next[selectedId] = perStep
      return next
    })
    // Any edit invalidates that row's server-reported failure — it will be
    // re-validated client-side immediately and server-side at launch.
    setServerFailures((prev) => {
      if (!prev.has(selectedId)) return prev
      const next = new Map(prev)
      next.delete(selectedId)
      return next
    })
    setEditingStep(null)
  }

  const handleLaunch = async () => {
    setLaunching(true)
    setLaunchError(null)
    setLaunchErrorCode(null)
    try {
      const result = await launchSequence(detail.sequence.id, overridesByEnrollment)
      toast.success(
        `Launched — ${result.armed_enrollments} contact${result.armed_enrollments === 1 ? '' : 's'} scheduled`,
      )
      onLaunched()
    } catch (err) {
      const failures = launchFailuresFromError(err)
      if (failures) {
        setServerFailures(groupLaunchFailures(failures))
        setLaunchError('Some contacts still have unresolved fields — fix the highlighted rows.')
        return
      }
      // Map the route's other 400 codes to actionable copy — the raw server
      // strings (a Postgres trigger message for 'account_not_reachable') are
      // dead ends inside a full-screen overlay with no route to settings.
      const code = err instanceof SequencesRequestError ? err.apiError.code : null
      setLaunchErrorCode(code)
      if (code === 'no_email_account' || code === 'account_not_reachable') {
        setLaunchError(
          'No usable sending mailbox — connect a Gmail or Outlook account, then launch again.',
        )
      } else if (code === 'no_active_steps') {
        setLaunchError(
          'This sequence has no active steps — close this review and add at least one email in the builder.',
        )
      } else if (code === 'no_enrollments') {
        setLaunchError(
          'No contacts are staged — close this review and add contacts from the detail page.',
        )
      } else {
        setLaunchError(err instanceof Error ? err.message : 'Launch failed')
      }
    } finally {
      setLaunching(false)
    }
  }

  const nameOf = (enrollmentId: string): string => {
    const e = stagedEnrollments.find((x) => x.id === enrollmentId)
    return e?.contact?.full_name || e?.contact_email || 'Contact'
  }

  const loading = contactVars === null || !senderLoaded

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-5">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground"
          onClick={onClose}
          disabled={launching}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <h1 className="truncate text-sm font-semibold">
          Review &amp; launch — {detail.sequence.name}
        </h1>
        <div className="ml-auto flex items-center gap-3">
          {blockedIds.size > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              {blockedIds.size} contact{blockedIds.size === 1 ? ' has' : 's have'} unresolved
              fields
            </span>
          )}
          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleLaunch}
            // `!sender` is a HARD block: launching without a mailbox 400s with
            // 'no_email_account', so don't offer a button that can only fail.
            disabled={
              loading ||
              launching ||
              blockedIds.size > 0 ||
              stagedEnrollments.length === 0 ||
              !sender
            }
          >
            <Rocket className="h-3.5 w-3.5" />
            {launching ? 'Launching…' : `Launch (${stagedEnrollments.length})`}
          </Button>
        </div>
      </div>

      {/* Explainer + sender */}
      <div className="shrink-0 border-b bg-muted/30 px-5 py-2 text-xs text-muted-foreground">
        Step 1 sends within the send window; follow-ups go automatically until someone replies.
        {sender ? (
          <>
            {' '}
            Sending as <span className="font-medium text-foreground">{sender.account_email}</span>.
          </>
        ) : senderLoaded ? (
          <span className="text-red-600 dark:text-red-400">
            {' '}
            No connected mailbox — connect Gmail or Outlook before launching.
            {settingsOverlay && (
              <button
                type="button"
                className="ml-1.5 underline underline-offset-2"
                onClick={() => settingsOverlay.openSettings('connectors')}
              >
                Connect
              </button>
            )}
          </span>
        ) : null}
        {midFlightCount > 0 && (
          <>
            {' '}
            {midFlightCount} contact{midFlightCount === 1 ? ' is' : 's are'} already mid-sequence
            and {midFlightCount === 1 ? 'is' : 'are'} not shown — they keep their schedule, and
            launching only schedules the {stagedEnrollments.length} staged contact
            {stagedEnrollments.length === 1 ? '' : 's'} listed here.
          </>
        )}
      </div>

      {launchError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-5 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{launchError}</span>
          {(launchErrorCode === 'no_email_account' ||
            launchErrorCode === 'account_not_reachable') &&
            settingsOverlay && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 shrink-0 border-red-500/40 text-xs"
                onClick={() => settingsOverlay.openSettings('connectors')}
              >
                Connect a mailbox
              </Button>
            )}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Preparing previews…
        </div>
      ) : stagedEnrollments.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {midFlightCount > 0
            ? 'Everyone enrolled is already mid-sequence — nothing new to launch. Add contacts from the detail page to stage more.'
            : 'No contacts staged — add contacts from the detail page first.'}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Left: contact list */}
          <div className="flex w-72 shrink-0 flex-col border-r">
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-0.5 p-2">
                {stagedEnrollments.map((e) => {
                  const blocked = blockedIds.has(e.id)
                  const isSelected = e.id === selectedId
                  return (
                    <button
                      key={e.id}
                      onClick={() => {
                        setSelectedId(e.id)
                        setEditingStep(null)
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                        isSelected ? 'bg-muted' : 'hover:bg-muted/50',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">
                          {e.contact?.full_name || e.contact_email}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {e.contact?.email ?? e.contact_email}
                        </p>
                      </div>
                      {blocked ? (
                        <AlertTriangle
                          className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                          aria-label="Unresolved fields"
                        />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      )}
                    </button>
                  )
                })}
              </div>
            </ScrollArea>
          </div>

          {/* Right: full preview of every step for the selected contact */}
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-[720px] space-y-4 px-6 py-4">
              {selected && serverFailures.has(selected.id) && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    The server reported unresolved fields for {nameOf(selected.id)}:{' '}
                    {serverFailures
                      .get(selected.id)!
                      .tokens.map(unresolvedTokenLabel)
                      .join(', ')}{' '}
                    (step{serverFailures.get(selected.id)!.steps.length === 1 ? '' : 's'}{' '}
                    {serverFailures.get(selected.id)!.steps.join(', ')})
                  </span>
                </div>
              )}

              {selected &&
                (selectedPreview ?? []).map((preview) => {
                  const step = activeSteps.find((s) => s.step_order === preview.step_order)
                  const override =
                    overridesByEnrollment[selected.id]?.[String(preview.step_order)]
                  const isEditing = editingStep === preview.step_order
                  return (
                    <div
                      key={preview.step_order}
                      className={cn(
                        'rounded-lg border',
                        preview.unresolved.length > 0 && 'border-amber-500/50',
                      )}
                    >
                      <div className="flex items-center gap-2 border-b px-3 py-2">
                        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                          Step {preview.step_order}
                        </Badge>
                        {preview.sameThread && (
                          <span className="text-[11px] italic text-muted-foreground">
                            same thread
                          </span>
                        )}
                        {override && (
                          <Badge
                            variant="outline"
                            className="shrink-0 border-blue-500/30 bg-blue-500/10 px-1.5 py-0 text-[10px] text-blue-700 dark:text-blue-400"
                          >
                            Edited for this contact
                          </Badge>
                        )}
                        <div className="ml-auto">
                          {!isEditing && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                              onClick={() => startEdit(preview.step_order)}
                            >
                              <Pencil className="h-3 w-3" />
                              Edit
                            </Button>
                          )}
                        </div>
                      </div>

                      {isEditing ? (
                        <div className="space-y-3 px-3 py-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">
                              Subject{' '}
                              {step && step.step_order > 1 && (
                                <span className="text-muted-foreground/70">
                                  (blank = the step&apos;s default
                                  {step.subject == null
                                    ? ' — replies in step 1’s thread'
                                    : ''}
                                  )
                                </span>
                              )}
                            </Label>
                            <Input
                              value={editSubject}
                              onChange={(e) => setEditSubject(e.target.value)}
                              placeholder={
                                step && step.step_order > 1
                                  ? 'Re: … (same thread)'
                                  : 'Subject'
                              }
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">Body</Label>
                            <Textarea
                              value={editBody}
                              onChange={(e) => setEditBody(e.target.value)}
                              rows={8}
                              className="font-mono text-xs"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <Button size="sm" className="h-7" onClick={saveEdit}>
                              Apply
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1 text-muted-foreground"
                              onClick={() => setEditingStep(null)}
                            >
                              <X className="h-3 w-3" />
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="px-3 py-3">
                          <p className="text-sm font-medium">
                            {preview.subject || (
                              <span className="italic text-muted-foreground">(no subject)</span>
                            )}
                          </p>
                          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                            {preview.body}
                          </p>
                          {preview.unresolved.length > 0 && (
                            <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                              <AlertTriangle className="h-3 w-3 shrink-0" />
                              Unresolved:{' '}
                              {preview.unresolved.map(unresolvedTokenLabel).join(', ')} — edit
                              this step or fix the contact record.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
