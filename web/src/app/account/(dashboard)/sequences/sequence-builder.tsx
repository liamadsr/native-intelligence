'use client'

/**
 * Sequence builder — create a sequence, or edit an existing one (including
 * mid-flight: the old whole-form 'sequence_locked' is gone). UX ports the
 * admin campaign-steps-editor's feel (collapsible timeline step cards, inline
 * preview) minus its defects: integer delay_days only (no fractional-day
 * units), explicit up/down reorder buttons instead of a decorative drag
 * handle, and a sequence-level business/calendar delay toggle.
 *
 * Graduated edit rules: instead of a lock banner, each step carries per-step
 * PINNED indicators + tooltips driven by the same verdict function the API
 * enforces (stepEditVerdicts in src/lib/sequences/mutations.ts — no drift):
 * copy is always editable; delete/reorder/delay/threading are disabled per
 * step when the ledger or an active enrollment still needs the step. Saves
 * send the full step list WITH ids (reconcile-by-id); a save race that trips
 * a server guard surfaces the per-step reasons (details.code 'step_guarded').
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clock,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { DEFAULT_SEND_WINDOW, normalizeWindow } from '@/lib/sequences/schedule'
import { stepEditVerdicts, type StepEditVerdict, type StepGuardError } from '@/lib/sequences/mutations'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { ViewHeader } from '../views/view-header'
import type { SequenceRow } from '@/lib/sequences/types'
import {
  MERGE_TOKENS,
  SAMPLE_PREVIEW_CONTACT,
  defaultStepBody,
  renderSequencePreview,
  unresolvedTokenLabel,
} from '@/lib/sequences/ui-helpers'
import {
  SequencesRequestError,
  createSequence,
  fetchEmailAccounts,
  patchSequence,
  type EmailAccount,
  type SequenceStepWithCounts,
  type SequenceStructureInput,
} from './api'

// ── Local editing model ──────────────────────────────────────────────────

interface DraftStep {
  /** Stable client key across reorders. */
  key: string
  /** Existing sequence_step id (drives reconcile-by-id); null = new step. */
  id: string | null
  subject: string
  body: string
  delayDays: number
  /** Preserved through edits; the builder has no toggle for it (the agent
   *  tool does), but dropping it on save would silently reactivate steps. */
  isActive: boolean
  /** Whether the step had a subject when loaded — flipping NULL↔set is
   *  guarded on sent steps (threading is meaning). null = new step. */
  originalHadSubject: boolean | null
}

let stepKeyCounter = 0
function nextStepKey(): string {
  return `step-${++stepKeyCounter}`
}

function newDraftStep(delayDays: number): DraftStep {
  return {
    key: nextStepKey(),
    id: null,
    subject: '',
    body: defaultStepBody(),
    delayDays,
    isActive: true,
    originalHadSubject: null,
  }
}

/** All-allowed verdict for new steps / create mode. */
const OPEN_VERDICT: StepEditVerdict = {
  step_id: '',
  step_order: 0,
  delete: { allowed: true },
  reorder: { allowed: true },
  delay: { allowed: true },
  subject_presence: { allowed: true },
}

const DAY_LABELS: Array<{ iso: number; label: string }> = [
  { iso: 1, label: 'Mon' },
  { iso: 2, label: 'Tue' },
  { iso: 3, label: 'Wed' },
  { iso: 4, label: 'Thu' },
  { iso: 5, label: 'Fri' },
  { iso: 6, label: 'Sat' },
  { iso: 7, label: 'Sun' },
]

function hourLabel(h: number): string {
  // 24 is the "Until" picker's midnight end, as in lib/sequences/ui-helpers.
  if (h === 0 || h === 24) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

/** Common IANA zones for the picker; the browser zone and the sequence's own
 *  stored zone are merged in so an uncommon value still round-trips. */
const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
]

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'
  } catch {
    return 'America/Los_Angeles'
  }
}

/**
 * Delay-days field that can go BLANK mid-edit. A controlled numeric input
 * bound straight to `delayDays` snapped Backspace to '0' (`Number('') || 0`),
 * so retyping a value fought the user with leading-zero churn. The raw string
 * lives here; only parseable non-negative integers are committed, and blur
 * snaps the text back to the last committed value.
 */
function DelayDaysInput({
  value,
  disabled,
  onCommit,
}: {
  value: number
  disabled: boolean
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState(() => String(value))
  // Re-sync when the committed value changes underneath (e.g. the reorder
  // normalization in moveStep rewrites a step's delay).
  useEffect(() => {
    setText(String(value))
  }, [value])
  return (
    <Input
      type="number"
      min={0}
      step={1}
      value={text}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        if (raw.trim() === '') return
        const parsed = Math.floor(Number(raw))
        if (Number.isFinite(parsed) && parsed >= 0) onCommit(parsed)
      }}
      onBlur={() => setText(String(value))}
      className="h-8 w-20"
      disabled={disabled}
    />
  )
}

// ── Component ────────────────────────────────────────────────────────────

export function SequenceBuilder({
  sequence,
  steps,
  activeEnrollmentOrders = [],
  onCancel,
  onSaved,
}: {
  /** null = create mode. */
  sequence: SequenceRow | null
  steps: SequenceStepWithCounts[] | null
  /** current_step_order of every ACTIVE enrollment — feeds the per-step edit
   *  guards (stepEditVerdicts). Empty = nothing enrolled, everything open. */
  activeEnrollmentOrders?: number[]
  onCancel: () => void
  onSaved: (sequence: SequenceRow) => void
}) {
  const isCreate = sequence === null

  const [name, setName] = useState(sequence?.name ?? '')
  const [description, setDescription] = useState(sequence?.description ?? '')
  const [timezone, setTimezone] = useState(sequence?.timezone ?? browserTimezone())
  const [sendWindow, setSendWindow] = useState(() =>
    sequence ? normalizeWindow(sequence.send_window) : DEFAULT_SEND_WINDOW,
  )
  const [delayUnit, setDelayUnit] = useState<'business' | 'calendar'>(
    sequence?.delay_unit ?? 'business',
  )
  // Sending identity — always visible so there's never a question of which
  // mailbox a sequence sends from. Changeable while draft; pinned at launch
  // (live threads come from that identity). null probe = still loading.
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[] | null>(null)
  const [sendingAccountId, setSendingAccountId] = useState<string | null>(
    sequence?.sending_account_id ?? null,
  )
  const accountLocked = sequence !== null && sequence.status !== 'draft'
  useEffect(() => {
    let cancelled = false
    fetchEmailAccounts()
      .then((accounts) => {
        if (cancelled) return
        setEmailAccounts(accounts)
        // Default the picker to what the server would adopt (primary first),
        // so what the user SEES is what a bare create would do anyway.
        setSendingAccountId((current) => current ?? accounts[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setEmailAccounts([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The sample preview's SENDER is never a placeholder — it's whoever is
  // building the sequence. Showing 'You' where the real name will appear made
  // the preview disagree with what actually sends (the engine signs with the
  // workspace member name). Contact vars stay sampled; only the sender is real.
  const workspaceId = useWorkspaceId()
  const [senderMemberName, setSenderMemberName] = useState<string | null>(null)
  const selectedAccountEmail =
    emailAccounts?.find((a) => a.id === sendingAccountId)?.account_email ?? null
  useEffect(() => {
    if (!selectedAccountEmail) return
    let cancelled = false
    cachedJson<{ members?: { display_name: string | null; email?: string | null }[] }>(
      '/api/account/workspace',
      { scope: workspaceId },
    )
      .then((d) => {
        if (cancelled || !d) return
        const match = (d.members ?? []).find(
          (m) => (m.email ?? '').toLowerCase() === selectedAccountEmail.toLowerCase(),
        )
        setSenderMemberName(match?.display_name ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [selectedAccountEmail, workspaceId])
  const [draftSteps, setDraftSteps] = useState<DraftStep[]>(() => {
    if (steps && steps.length > 0) {
      return [...steps]
        .sort((a, b) => a.step_order - b.step_order)
        .map((s) => ({
          key: nextStepKey(),
          id: s.id,
          subject: s.subject ?? '',
          body: s.body,
          delayDays: s.delay_days,
          isActive: s.is_active,
          originalHadSubject: s.subject !== null,
        }))
    }
    const first = newDraftStep(0)
    return [first]
  })
  const [openKey, setOpenKey] = useState<string | null>(() => draftSteps[0]?.key ?? null)
  const [previewKeys, setPreviewKeys] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const bodyRefs = useRef(new Map<string, HTMLTextAreaElement>())

  const timezoneOptions = useMemo(() => {
    const set = new Set([timezone, browserTimezone(), ...COMMON_TIMEZONES])
    return [...set].sort()
  }, [timezone])

  const disabled = saving

  // Per-step edit verdicts — the SAME rule function the API enforces, fed the
  // same definition of "has sends": ANY ledger row counts, including in-flight
  // ('claimed'/'sending') ones, exactly like the server's unfiltered step_id
  // scan. Still a point-in-time hint (the ledger can change between load and
  // save) — the server re-evaluates and a race surfaces its per-step reasons.
  const verdicts = useMemo(() => {
    if (!steps || steps.length === 0) return new Map<string, StepEditVerdict>()
    return stepEditVerdicts(
      steps.map((s) => ({
        id: s.id,
        step_order: s.step_order,
        subject: s.subject,
        delay_days: s.delay_days,
        is_active: s.is_active,
        has_sends: s.counts.sent + s.counts.failed + s.counts.in_flight > 0,
      })),
      activeEnrollmentOrders,
    )
  }, [steps, activeEnrollmentOrders])

  const verdictFor = (step: DraftStep): StepEditVerdict =>
    (step.id !== null ? verdicts.get(step.id) : undefined) ?? OPEN_VERDICT

  // Sample-render every step once per edit for the preview cards.
  const samplePreview = useMemo(
    () =>
      renderSequencePreview(
        draftSteps.map((s, idx) => ({
          step_order: idx + 1,
          subject: s.subject.trim() === '' ? null : s.subject,
          body: s.body,
        })),
        {},
        SAMPLE_PREVIEW_CONTACT,
        // 'You' is deliberately kept as the last resort: while the accounts +
        // member lookups are still in flight both fields are null, and an
        // unresolved sender token would flash a spurious "Unresolved" warning
        // on a template that is actually fine.
        {
          name: senderMemberName ?? (selectedAccountEmail ? null : 'You'),
          email: selectedAccountEmail ?? 'you@example.com',
        },
      ),
    [draftSteps, senderMemberName, selectedAccountEmail],
  )

  const updateStep = (key: string, patch: Partial<DraftStep>) => {
    setDraftSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }

  const moveStep = (index: number, delta: -1 | 1) => {
    setDraftSteps((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      // A move swaps two positions — BOTH must be reorderable (a guarded step
      // may not move, and nothing may move into a guarded step's slot).
      if (!verdictFor(prev[index]).reorder.allowed || !verdictFor(prev[target]).reorder.allowed) {
        return prev
      }
      const next = [...prev]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      // A move through slot 0 changes which step "sends when launched", and
      // that slot's delay field is hidden (its delayDays is meaningless). If
      // the delays simply rode along, moving step 1 down silently made the
      // new step 2 a zero-day step — two emails back-to-back. Preserve the
      // TIMELINE instead: the new first step is forced to 0, and the
      // displaced step inherits the gap the second slot previously had (the
      // promoted step's delay), falling back to the addStep default.
      if (index === 0 || target === 0) {
        const promotedDelay = next[0].delayDays
        next[0] = { ...next[0], delayDays: 0 }
        next[1] = { ...next[1], delayDays: promotedDelay > 0 ? promotedDelay : 3 }
      }
      return next
    })
  }

  const removeStep = (key: string) => {
    setDraftSteps((prev) => {
      if (prev.length <= 1) return prev
      const step = prev.find((s) => s.key === key)
      if (step && !verdictFor(step).delete.allowed) return prev
      return prev.filter((s) => s.key !== key)
    })
  }

  const addStep = () => {
    const step = newDraftStep(3)
    setDraftSteps((prev) => [...prev, step])
    setOpenKey(step.key)
  }

  const insertToken = (key: string, token: string) => {
    const el = bodyRefs.current.get(key)
    const step = draftSteps.find((s) => s.key === key)
    if (!step) return
    if (!el) {
      updateStep(key, { body: step.body + token })
      return
    }
    const start = el.selectionStart ?? step.body.length
    const end = el.selectionEnd ?? start
    const body = step.body.slice(0, start) + token + step.body.slice(end)
    updateStep(key, { body })
    // Restore the cursor after React re-renders the textarea.
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }

  const toggleDay = (iso: number) => {
    setSendWindow((prev) => {
      const days = prev.days.includes(iso)
        ? prev.days.filter((d) => d !== iso)
        : [...prev.days, iso].sort((a, b) => a - b)
      // An empty window would degrade server-side to the default anyway; keep
      // at least one day selected so the UI never lies about what's stored.
      if (days.length === 0) return prev
      return { ...prev, days }
    })
  }

  const validate = (): string[] => {
    const problems: string[] = []
    if (!name.trim()) problems.push('Name is required.')
    if (sendWindow.end_hour <= sendWindow.start_hour) {
      problems.push('Send window must end after it starts.')
    }
    draftSteps.forEach((s, idx) => {
      if (idx === 0 && s.subject.trim() === '') {
        problems.push('Step 1 needs a subject (follow-ups may leave it blank to stay in the same thread).')
      }
      if (s.body.trim() === '') problems.push(`Step ${idx + 1} needs a body.`)
      if (!Number.isInteger(s.delayDays) || s.delayDays < 0) {
        problems.push(`Step ${idx + 1}: delay must be a whole number of days.`)
      }
      // Threading is meaning on a sent step: flipping the subject between
      // blank (thread as a reply) and set (new thread) is refused server-side
      // — catch it here with the same reason so the save doesn't bounce.
      const verdict = verdictFor(s)
      if (s.originalHadSubject !== null && !verdict.subject_presence.allowed) {
        const hasSubject = s.subject.trim() !== ''
        if (hasSubject !== s.originalHadSubject) {
          problems.push(`Step ${idx + 1}: ${verdict.subject_presence.reason}.`)
        }
      }
    })
    return problems
  }

  const handleSave = async () => {
    const problems = validate()
    setErrors(problems)
    if (problems.length > 0) return

    const payload: SequenceStructureInput = {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      timezone,
      send_window: sendWindow,
      delay_unit: delayUnit,
      // Draft-only: the PATCH route rejects account changes after launch, so
      // only send the field while it's still legal (and actually chosen).
      ...(!accountLocked && sendingAccountId ? { sending_account_id: sendingAccountId } : {}),
      // Full desired list, reconciled by id server-side: kept steps carry
      // their id, new steps none, and omitted steps are deleted (per-step
      // guards permitting).
      steps: draftSteps.map((s, idx) => ({
        ...(s.id !== null ? { id: s.id } : {}),
        subject: s.subject.trim() === '' ? null : s.subject,
        body: s.body,
        // Step 1's delay is "from launch" and always 0 — the field is hidden
        // for it, so don't persist whatever stale value the row carried.
        delay_days: idx === 0 ? 0 : s.delayDays,
        is_active: s.isActive,
      })),
    }

    setSaving(true)
    try {
      const saved = isCreate
        ? await createSequence(payload)
        : await patchSequence(sequence.id, payload)
      toast.success(isCreate ? 'Sequence created' : 'Sequence saved')
      onSaved(saved)
    } catch (err) {
      if (err instanceof SequencesRequestError && err.apiError.code === 'step_guarded') {
        // A guard tripped server-side (this client's view was stale — e.g. a
        // send landed mid-edit). Surface each per-step reason inline.
        const guardErrors = Array.isArray(err.apiError.details?.guard_errors)
          ? (err.apiError.details!.guard_errors as StepGuardError[])
          : []
        setErrors(
          guardErrors.length > 0
            ? guardErrors.map((g) => `Step ${g.step_order}: ${g.reason}.`)
            : [err.message],
        )
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to save sequence')
      }
    } finally {
      setSaving(false)
    }
  }

  const firstSubject = draftSteps[0]?.subject.trim() ?? ''

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title={isCreate ? 'New sequence' : `Edit ${sequence.name}`}
        actions={
          <>
            <Button variant="ghost" size="sm" className="h-8" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8" onClick={handleSave} disabled={disabled}>
              {saving ? 'Saving…' : isCreate ? 'Create sequence' : 'Save changes'}
            </Button>
          </>
        }
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[720px] space-y-6 px-5 pb-24 pt-2">
          {errors.length > 0 && (
            <div className="space-y-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
              {errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          )}

          {/* ── Basics ── */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seed raise — first touch"
                disabled={disabled}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Description (optional)</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this sequence is for"
                disabled={disabled}
              />
            </div>
          </div>

          {/* ── Schedule ── */}
          <div className="space-y-3 rounded-lg border p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Sending schedule
            </p>
            {/* Identity first — WHICH mailbox sends is the highest-stakes
                fact in the section; it must never be a launch-time surprise. */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Send from</Label>
              {emailAccounts === null ? (
                <div className="h-8 w-[260px] animate-pulse rounded-md bg-muted" />
              ) : accountLocked || emailAccounts.length <= 1 ? (
                (() => {
                  const account =
                    emailAccounts.find((a) => a.id === sendingAccountId) ?? emailAccounts[0] ?? null
                  return account ? (
                    <div className="space-y-1">
                      <div className="flex h-8 w-fit items-center gap-2 rounded-md border bg-muted/40 px-3 text-xs">
                        <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">
                          {account.account_email ?? account.display_name ?? 'Mailbox'}
                        </span>
                        <span className="text-muted-foreground">
                          {account.provider === 'google' ? 'Gmail' : 'Outlook'}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {accountLocked
                          ? 'Pinned at launch — live threads come from this identity.'
                          : 'All emails in this sequence send from this account.'}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      No email account connected — connect Gmail or Outlook in Settings before
                      launching.
                    </p>
                  )
                })()
              ) : (
                <div className="space-y-1">
                  <Select
                    value={sendingAccountId ?? ''}
                    onValueChange={(v) => setSendingAccountId(v)}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-8 w-[280px]">
                      <SelectValue placeholder="Choose a mailbox" />
                    </SelectTrigger>
                    <SelectContent>
                      {emailAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.account_email ?? a.display_name ?? 'Mailbox'} ·{' '}
                          {a.provider === 'google' ? 'Gmail' : 'Outlook'}
                          {a.is_primary ? ' · primary' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    All emails in this sequence send from this account. Pinned once launched.
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Send on</Label>
              <div className="flex flex-wrap gap-1.5">
                {DAY_LABELS.map(({ iso, label }) => {
                  const active = sendWindow.days.includes(iso)
                  return (
                    <button
                      key={iso}
                      type="button"
                      onClick={() => toggleDay(iso)}
                      disabled={disabled}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition-colors',
                        active
                          ? 'border-foreground bg-foreground font-medium text-background'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                        disabled && 'opacity-60',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">From</Label>
                <Select
                  value={String(sendWindow.start_hour)}
                  onValueChange={(v) => setSendWindow((p) => ({ ...p, start_hour: Number(v) }))}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8 w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }, (_, h) => (
                      <SelectItem key={h} value={String(h)}>
                        {hourLabel(h)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Until</Label>
                <Select
                  value={String(sendWindow.end_hour)}
                  onValueChange={(v) => setSendWindow((p) => ({ ...p, end_hour: Number(v) }))}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8 w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {hourLabel(h)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Timezone</Label>
                <Select value={timezone} onValueChange={setTimezone} disabled={disabled}>
                  <SelectTrigger className="h-8 w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {timezoneOptions.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Count delays in</Label>
              <div className="inline-flex rounded-md border p-0.5">
                {(['business', 'calendar'] as const).map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    onClick={() => setDelayUnit(unit)}
                    disabled={disabled}
                    className={cn(
                      'rounded px-3 py-1 text-xs transition-colors',
                      delayUnit === unit
                        ? 'bg-foreground font-medium text-background'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {unit === 'business' ? 'Business days' : 'Calendar days'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Steps timeline ── */}
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Mail className="h-4 w-4 text-muted-foreground" />
              Steps
            </p>

            {draftSteps.map((step, idx) => {
              const isOpen = openKey === step.key
              const preview = samplePreview[idx]
              const showPreview = previewKeys.has(step.key)
              const verdict = verdictFor(step)
              // Pinned = some structural edit is guarded for this step —
              // including the threading (subject NULL↔set) freeze, so a step
              // whose ONLY guarded edit is threading still shows the pin on
              // the collapsed row. Copy stays editable — the pin explains
              // what doesn't.
              const pinned =
                !verdict.delete.allowed ||
                !verdict.reorder.allowed ||
                !verdict.delay.allowed ||
                !verdict.subject_presence.allowed
              const pinnedReason =
                verdict.delete.reason ??
                verdict.reorder.reason ??
                verdict.delay.reason ??
                verdict.subject_presence.reason
              const canMoveUp =
                idx > 0 &&
                verdict.reorder.allowed &&
                verdictFor(draftSteps[idx - 1]).reorder.allowed
              const canMoveDown =
                idx < draftSteps.length - 1 &&
                verdict.reorder.allowed &&
                verdictFor(draftSteps[idx + 1]).reorder.allowed
              const subjectPlaceholder =
                idx === 0
                  ? 'Subject (required)'
                  : firstSubject
                    ? `Re: ${firstSubject} (same thread)`
                    : 'Re: <step 1 subject> (same thread)'
              return (
                <div key={step.key} className="rounded-lg border">
                  {/* Card header. The whole row stays mouse-clickable, but the
                      expand affordance itself is a real <button> (the reorder/
                      remove Buttons are its SIBLINGS, not children — nested
                      interactive elements are invalid) so keyboard users can
                      open steps 2+ and reach their subject/body fields. */}
                  <div
                    className="flex cursor-pointer items-center gap-2 px-3 py-2.5"
                    onClick={() => setOpenKey(isOpen ? null : step.key)}
                  >
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={(e) => {
                        // The outer div handles the mouse path — don't double-toggle.
                        e.stopPropagation()
                        setOpenKey(isOpen ? null : step.key)
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                        Step {idx + 1}
                      </Badge>
                      {/* Pinned indicator — this step has been sent (or is
                          about to send): copy edits still apply to future
                          sends, but delete/reorder/delay are locked. */}
                      {pinned && (
                        <span
                          className="flex shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400"
                          title={`Copy edits apply to future sends; other changes are locked: ${pinnedReason}.`}
                        >
                          <Lock aria-hidden className="h-2.5 w-2.5" />
                          Pinned
                        </span>
                      )}
                      {!step.isActive && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                          OFF
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {step.subject.trim() !== '' ? (
                          step.subject
                        ) : idx === 0 ? (
                          <span className="text-muted-foreground">No subject yet</span>
                        ) : (
                          <span className="text-muted-foreground italic">
                            Re: same thread as step 1
                          </span>
                        )}
                      </span>
                      {idx > 0 && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          +{step.delayDays} {delayUnit === 'business' ? 'business' : ''} day
                          {step.delayDays === 1 ? '' : 's'}
                        </span>
                      )}
                    </button>
                    <div
                      className="flex shrink-0 items-center gap-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground"
                        onClick={() => moveStep(idx, -1)}
                        disabled={disabled || !canMoveUp}
                        title={
                          idx > 0 && !canMoveUp && !disabled ? verdict.reorder.reason : undefined
                        }
                        aria-label="Move step up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground"
                        onClick={() => moveStep(idx, 1)}
                        disabled={disabled || !canMoveDown}
                        title={
                          idx < draftSteps.length - 1 && !canMoveDown && !disabled
                            ? verdict.reorder.reason
                            : undefined
                        }
                        aria-label="Move step down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500"
                        onClick={() => removeStep(step.key)}
                        disabled={disabled || draftSteps.length <= 1 || !verdict.delete.allowed}
                        title={!verdict.delete.allowed ? verdict.delete.reason : undefined}
                        aria-label="Remove step"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                        isOpen && 'rotate-180',
                      )}
                    />
                  </div>

                  {/* Card body */}
                  {isOpen && (
                    <div className="space-y-3 border-t px-3 py-3">
                      {idx > 0 && (
                        <div className="flex items-center gap-2" title={verdict.delay.reason}>
                          <DelayDaysInput
                            value={step.delayDays}
                            disabled={disabled || !verdict.delay.allowed}
                            onCommit={(v) => updateStep(step.key, { delayDays: v })}
                          />
                          <span className="text-xs text-muted-foreground">
                            {delayUnit} days after previous step
                            {!verdict.delay.allowed && ' — locked (already sent)'}
                          </span>
                        </div>
                      )}
                      {idx === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Sends when launched, within the send window.
                        </p>
                      )}

                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Subject</Label>
                        <Input
                          value={step.subject}
                          onChange={(e) => updateStep(step.key, { subject: e.target.value })}
                          placeholder={subjectPlaceholder}
                          disabled={disabled}
                        />
                        {idx > 0 && step.subject.trim() === '' && (
                          <p className="text-[11px] text-muted-foreground">
                            Blank subject = this email is sent as a reply in step 1&apos;s thread.
                          </p>
                        )}
                        {/* Threading is frozen once sent: the words can change,
                            but blank↔set (reply vs new thread) cannot. */}
                        {!verdict.subject_presence.allowed && (
                          <p className="text-[11px] text-amber-600 dark:text-amber-400">
                            This step has been sent — it must keep{' '}
                            {step.originalHadSubject
                              ? 'a subject (it starts its own thread)'
                              : 'a blank subject (it replies in step 1’s thread)'}
                            . The wording is still editable.
                          </p>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Body</Label>
                        <Textarea
                          ref={(el) => {
                            if (el) bodyRefs.current.set(step.key, el)
                            else bodyRefs.current.delete(step.key)
                          }}
                          value={step.body}
                          onChange={(e) => updateStep(step.key, { body: e.target.value })}
                          rows={8}
                          className="font-mono text-xs"
                          disabled={disabled}
                        />
                        {/* Merge-token helper row */}
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          {MERGE_TOKENS.map((token) => (
                            <button
                              key={token}
                              type="button"
                              onClick={() => insertToken(step.key, token)}
                              disabled={disabled}
                              className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              {token}
                            </button>
                          ))}
                          <span className="text-[11px] text-muted-foreground">
                            Tip: {'{{first_name|there}}'} falls back to &ldquo;there&rdquo; when
                            the field is empty.
                          </span>
                        </div>
                      </div>

                      {/* Preview */}
                      <div className="space-y-1.5">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() =>
                            setPreviewKeys((prev) => {
                              const next = new Set(prev)
                              if (next.has(step.key)) next.delete(step.key)
                              else next.add(step.key)
                              return next
                            })
                          }
                        >
                          {showPreview ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                          {showPreview ? 'Hide preview' : 'Preview with sample data'}
                        </button>
                        {showPreview && preview && (
                          <div className="rounded-md border bg-muted/30 p-3 text-xs">
                            <p className="font-medium">
                              {preview.subject || (
                                <span className="italic text-muted-foreground">(no subject)</span>
                              )}
                            </p>
                            <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                              {preview.body}
                            </p>
                            {preview.unresolved.length > 0 && (
                              <p className="mt-2 text-red-600 dark:text-red-400">
                                Unresolved: {preview.unresolved.map(unresolvedTokenLabel).join(', ')}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={addStep}
              disabled={disabled}
            >
              <Plus className="h-3.5 w-3.5" />
              Add step
            </Button>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
