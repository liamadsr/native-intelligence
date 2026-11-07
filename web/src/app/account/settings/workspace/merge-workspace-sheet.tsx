'use client'

/**
 * Merge another workspace into this one (docs/plans/merge-workspaces.md,
 * "Preflight and UI"): a sheet off the workspace settings' Danger Zone, for
 * the owner of this workspace. Its header always shows the direction — FROM
 * the workspace picked, INTO this one (the one the person is in) — and the
 * three steps (choose, review, merge).
 *
 *   1. pick     — the workspaces the person also owns (fetched here: the
 *                 settings route has no workspace cache);
 *   2. review   — the preflight: why it cannot start (a recording, a running
 *                 job, drift) with a way to check again, who joins, each
 *                 team's own-or-fold choice (the only decision; every change
 *                 re-plans, and a failed re-plan puts the choice back to what
 *                 the plan will use), labels, integrations, where the two
 *                 overlap, then the workspace's name typed to confirm;
 *   3. merging  — one long request; the sheet has no close button and
 *                 ignores Escape and outside clicks, the window will not
 *                 reload for a deploy, and leaving the page asks first;
 *   4. done     — what came over, then finishWorkspaceMerge lands this
 *                 window in the merged workspace.
 *
 * Errors stay inline (the standalone settings route has no toaster). The
 * routes pin the destination to this workspace, so a stale cookie or another
 * tab's switch is refused rather than merged into. An answer that never
 * arrives (the connection dropped) is checked against the workspace list: a
 * source that is gone was merged, and the window lands in the destination
 * rather than offering a retry that would answer "not found".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, CheckCircle2, GitMerge, Loader2, Lock, Package, Plug, Users, UsersRound, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { registerReloadBlocker } from '@/lib/deploy-reload'
import { cn } from '@/lib/utils'
import { finishWorkspaceMerge } from '@/lib/workspace-merge/after-merge'
import { choiceValue, choicesOf, parseChoice, planFromChoices, type TeamChoice } from '@/lib/workspace-merge/plan'
import type { MergeApiError, MergeBlocker, MergeResponse, PreflightResult } from '@/lib/workspace-merge/types'
import {
  collisionLines,
  confirmNameMatches,
  describeBlockers,
  integrationLines,
  mergeCountItems,
  mergeCountsLine,
  peopleLines,
  teamLine,
} from '@/lib/workspace-merge/wording'

interface WorkspaceRow {
  id: string
  name: string
  slug: string | null
  role: string
}

interface TeamRow {
  id: string
  name: string
  issue_prefix: string
  is_private?: boolean
}

type Step = 'pick' | 'review' | 'merging' | 'done'

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string; details?: unknown }

async function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = (await res.json().catch(() => ({}))) as T & MergeApiError
    if (!res.ok) return { ok: false, status: res.status, error: data.error || 'Request failed', code: data.code, details: data.details }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Request failed' }
  }
}

async function loadWorkspaces(): Promise<WorkspaceRow[] | null> {
  try {
    const r = await fetch('/api/account/workspace/list')
    if (!r.ok) return null
    const data = (await r.json()) as { workspaces?: WorkspaceRow[] }
    return data.workspaces ?? []
  } catch {
    return null
  }
}

async function loadTeams(): Promise<TeamRow[] | null> {
  try {
    const r = await fetch('/api/account/teams')
    if (!r.ok) return null
    const data = (await r.json()) as { teams?: TeamRow[] }
    return data.teams ?? []
  } catch {
    return null
  }
}

function reasonOf(details: unknown): string | null {
  const r = (details as { reason?: unknown } | null)?.reason
  return typeof r === 'string' && r.length > 0 ? r : null
}

function blockersOf(details: unknown): MergeBlocker[] | null {
  const b = (details as { blockers?: unknown } | null)?.blockers
  return Array.isArray(b) ? (b as MergeBlocker[]) : null
}

/** The message to show: the plan error's reason names the slug or prefix; anything else speaks for itself. */
function messageOf(res: Extract<ApiResult<unknown>, { ok: false }>): string {
  const reason = res.code === 'PLAN_INVALID' ? reasonOf(res.details) : null
  return reason ? `${res.error} (${reason}).` : res.error
}

/** The merge's answer never arrived, or came from something in front of the app: the merge may still have committed. */
function answerLost(res: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  if (res.status === 0) return true
  if (!res.code && (res.status === 502 || res.status === 503 || res.status === 504)) return true
  return res.code === 'NOT_FOUND'
}

interface DoneSummary {
  rowsBefore: Record<string, number>
  /** null when the answer was lost and the record was not read: the counts are unknown. */
  membersTold: number | null
  recovered: boolean
}

export interface MergeWorkspaceSheetProps {
  open: boolean
  onClose: () => void
  /** This workspace: the destination. */
  destination: { id: string; name: string }
  /** How long the "done" summary stays before the window lands in the merged workspace. */
  navigateDelayMs?: number
}

export function MergeWorkspaceSheet({ open, onClose, destination, navigateDelayMs = 1500 }: MergeWorkspaceSheetProps) {
  const recording = useOptionalRecordingStable()?.isRecording ?? false

  const [step, setStep] = useState<Step>('pick')
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[] | null>(null)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [teamsFailed, setTeamsFailed] = useState(false)
  const [listError, setListError] = useState('')
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [choices, setChoices] = useState<Record<string, TeamChoice>>({})
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState('')
  const [typed, setTyped] = useState('')
  const [done, setDone] = useState<DoneSummary | null>(null)
  /** When the merge was sent, and the clock the merging view reads (display only). */
  const [mergeStartedAt, setMergeStartedAt] = useState(0)
  const [clock, setClock] = useState(0)
  const planRun = useRef(0)
  const stepRef = useRef<Step>('pick')
  useEffect(() => {
    stepRef.current = step
  }, [step])

  // Fresh on every open AND close: an answer still in flight when the sheet
  // closed is dropped (the run counter moves on), nothing of it shows on reopen.
  useEffect(() => {
    planRun.current += 1
    setStep('pick')
    setWorkspaces(null)
    setTeams([])
    setTeamsFailed(false)
    setListError('')
    setSourceId(null)
    setPreflight(null)
    setChoices({})
    setPlanning(false)
    setError('')
    setTyped('')
    setDone(null)
    if (!open) return
    let cancelled = false
    ;(async () => {
      const [ws, tm] = await Promise.all([loadWorkspaces(), loadTeams()])
      if (cancelled) return
      if (!ws) setListError('Could not load your workspaces.')
      setWorkspaces(ws ?? [])
      setTeams(tm ?? [])
      setTeamsFailed(!tm)
    })()
    return () => {
      cancelled = true
    }
  }, [open, destination.id])

  // A deploy must not reload this window while the merge runs or lands, and
  // leaving the page mid-merge warns (the request keeps running server-side).
  useEffect(() => {
    if (step !== 'merging' && step !== 'done') return
    return registerReloadBlocker(() => stepRef.current === 'merging' || stepRef.current === 'done')
  }, [step])
  useEffect(() => {
    if (step !== 'merging') return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [step])

  useEffect(() => {
    if (step !== 'merging') return
    const id = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [step])

  const candidates = useMemo(
    () => (workspaces ?? []).filter((w) => w.role === 'owner' && w.id !== destination.id),
    [workspaces, destination.id],
  )

  const refreshTeams = useCallback(async () => {
    const tm = await loadTeams()
    setTeams(tm ?? [])
    setTeamsFailed(!tm)
  }, [])

  /**
   * Run (or re-run) the preflight. `nextChoices` null = the server's defaults.
   * On failure the dropdowns go back to what the current plan will use, so
   * the merge never runs with a choice the server did not accept.
   */
  const runPreflight = useCallback(
    async (source: string, nextChoices: Record<string, TeamChoice> | null, opts: { keepError?: boolean } = {}) => {
      const run = ++planRun.current
      setPlanning(true)
      if (!opts.keepError) setError('')
      const body: Record<string, unknown> = { source_workspace_id: source, destination_workspace_id: destination.id }
      if (nextChoices && preflight) body.plan = planFromChoices(preflight.teams, nextChoices)
      const res = await postJson<PreflightResult>('/api/account/workspace/merge/preflight', body)
      if (run !== planRun.current) return
      setPlanning(false)
      if (!res.ok) {
        setError(messageOf(res))
        if (preflight) setChoices(choicesOf(preflight.teams))
        else setStep('pick')
        return
      }
      setPreflight(res.data)
      setChoices(choicesOf(res.data.teams))
      setStep('review')
    },
    [destination.id, preflight],
  )

  const pick = (id: string) => {
    setSourceId(id)
    setStep('review')
    void runPreflight(id, null)
  }

  const choose = (teamId: string, value: string) => {
    if (!sourceId) return
    const next = { ...choices, [teamId]: parseChoice(value) }
    setChoices(next)
    void runPreflight(sourceId, next)
  }

  const canMerge = Boolean(
    preflight && preflight.ok && sourceId && !planning && !recording && confirmNameMatches(preflight.source.name, typed),
  )

  const land = (summary: DoneSummary, source: string) => {
    setDone(summary)
    setStep('done')
    window.setTimeout(() => finishWorkspaceMerge(source, destination.id), navigateDelayMs)
  }

  const merge = async () => {
    if (!preflight || !sourceId || !canMerge) return
    const startedAt = Date.now()
    setMergeStartedAt(startedAt)
    setClock(startedAt)
    setStep('merging')
    setError('')
    const res = await postJson<MergeResponse>('/api/account/workspace/merge', {
      source_workspace_id: sourceId,
      destination_workspace_id: destination.id,
      plan: preflight.plan,
      confirm_name: typed,
    })
    if (res.ok) {
      land({ rowsBefore: res.data.merge.rows_before ?? {}, membersTold: res.data.members_told ?? 0, recovered: Boolean(res.data.merge.recovered) }, sourceId)
      return
    }
    if (res.code === 'MERGE_BLOCKED') {
      const blockers = blockersOf(res.details)
      if (blockers) setPreflight({ ...preflight, ok: false, blockers })
      setStep('review')
      setError(res.error)
      return
    }
    if (res.code === 'PLAN_INVALID') {
      // The plan went stale (a team came or went): say why, and plan again from the server's defaults.
      setStep('review')
      setError(messageOf(res))
      void refreshTeams()
      void runPreflight(sourceId, null, { keepError: true })
      return
    }
    if (answerLost(res)) {
      // The merge may have committed without us hearing: the source being gone is the proof.
      const list = await loadWorkspaces()
      if (list && !list.some((w) => w.id === sourceId)) {
        land({ rowsBefore: {}, membersTold: null, recovered: true }, sourceId)
        return
      }
    }
    setStep('review')
    setError(res.error)
  }

  const busy = step === 'merging' || step === 'done'
  const blockerLines = preflight && !preflight.ok ? describeBlockers(preflight.blockers) : []
  const countItems = preflight ? mergeCountItems(preflight.counts) : []
  const people = preflight ? peopleLines(preflight.people) : []
  const integrations = preflight ? integrationLines(preflight.integrations) : []
  const overlaps = preflight ? collisionLines(preflight.collisions) : []
  const doneCounts = done ? mergeCountsLine(done.rowsBefore) : ''
  const sourceName = preflight?.source.name ?? candidates.find((w) => w.id === sourceId)?.name ?? null

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <SheetContent
        side="right"
        // The sheet's own close button is replaced by the header's, which is gone while the merge runs.
        className="flex h-full w-full max-w-[560px] flex-col gap-0 border-l border-border p-0 sm:max-w-[560px] [&>button:first-of-type]:hidden"
      >
        <SheetHeader className="shrink-0 space-y-4 border-b border-border px-5 py-4 text-left">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="text-sm font-semibold">Merge workspaces</SheetTitle>
              <SheetDescription className="mt-0.5 text-xs">
                Everything in the workspace you pick moves into {destination.name}, the workspace you are in now.
              </SheetDescription>
            </div>
            {!busy && (
              <button
                type="button"
                data-testid="merge-close"
                aria-label="Close"
                onClick={onClose}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Direction from={step === 'pick' ? null : sourceName} into={destination.name} step={step} />
          <Steps step={step} />
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {step === 'pick' && (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Which workspace should move into {destination.name}?</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Only workspaces you own are listed.</p>
              </div>
              {workspaces === null ? (
                <div className="space-y-2">
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {listError || 'You are not the owner of another workspace, so there is nothing to merge in. Only workspaces you own can be merged here.'}
                </p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {candidates.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      data-source-id={w.id}
                      onClick={() => pick(w.id)}
                      className="group flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/40"
                    >
                      <WorkspaceMark name={w.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{w.name}</span>
                        {w.slug && <span className="block truncate text-xs text-muted-foreground">{w.slug}</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
                        Review
                        <ArrowRight className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === 'review' && !preflight && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking what the merge would do…
            </div>
          )}

          {preflight && step === 'review' && (
            <div className="space-y-6">
              {blockerLines.length > 0 && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-medium text-destructive">
                      <AlertTriangle className="h-4 w-4" />
                      The merge cannot start yet
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="check-again"
                      disabled={planning || busy}
                      onClick={() => sourceId && void runPreflight(sourceId, choices)}
                    >
                      {planning && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                      Check again
                    </Button>
                  </div>
                  <ul className="mt-2 space-y-1 text-foreground/90">
                    {blockerLines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              )}

              <Section icon={Package} title="What moves over">
                {countItems.length > 0 ? (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {countItems.map((c) => (
                        <div key={c.table} data-testid="merge-count" className="rounded-lg border px-3 py-2">
                          <p className="text-base font-semibold tabular-nums">{c.n.toLocaleString('en-US')}</p>
                          <p className="text-xs text-muted-foreground">{c.label}</p>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">…and everything attached to them.</p>
                  </>
                ) : (
                  <p className="text-sm">An empty workspace.</p>
                )}
              </Section>

              {people.length > 0 && (
                <Section icon={Users} title="People">
                  <Lines lines={people} />
                </Section>
              )}

              <Section
                icon={UsersRound}
                title="Teams"
                aside={
                  planning && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Re-planning…
                    </span>
                  )
                }
              >
                <div className="divide-y rounded-lg border">
                  {preflight.teams.map((t) => {
                    const choice = choices[t.source_team_id] ?? { mode: 'own' }
                    const target = choice.mode === 'fold' ? teams.find((d) => d.id === choice.destination_team_id) : null
                    const opensUp = Boolean(t.is_private && target && !target.is_private)
                    return (
                      <div key={t.source_team_id} className="space-y-1.5 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-1.5 text-sm">
                            <span className="truncate font-medium">{t.source_name}</span>
                            {t.is_private && (
                              <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
                                Private
                              </Badge>
                            )}
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t.source_prefix} · {t.actions} {t.actions === 1 ? 'action' : 'actions'} · {t.members} {t.members === 1 ? 'member' : 'members'}
                            </span>
                          </div>
                          <select
                            aria-label={`Where ${t.source_name} goes`}
                            data-team-id={t.source_team_id}
                            value={choiceValue(choice)}
                            disabled={planning || busy}
                            onChange={(e) => choose(t.source_team_id, e.target.value)}
                            className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <option value="own">Its own team</option>
                            {teams.map((d) => (
                              <option key={d.id} value={`fold:${d.id}`}>
                                Fold into {d.name} ({d.issue_prefix})
                              </option>
                            ))}
                          </select>
                        </div>
                        <p className="text-xs text-muted-foreground">{teamLine(t)}</p>
                        {opensUp && (
                          <p className="text-xs text-destructive">
                            This team is private: folding it into {target?.name} opens its work to that team’s members.
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
                {teamsFailed && (
                  <p className="mt-2 text-xs text-destructive">Could not load this workspace’s teams, so teams can only arrive as their own.</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {preflight.labels.matched > 0 || preflight.labels.created > 0
                    ? `Labels: ${preflight.labels.matched} match by name, ${preflight.labels.created} ${preflight.labels.created === 1 ? 'is' : 'are'} created here.`
                    : 'No labels to carry over.'}
                </p>
              </Section>

              {integrations.length > 0 && (
                <Section icon={Plug} title="Integrations">
                  <Lines lines={integrations} />
                </Section>
              )}

              {overlaps.length > 0 && (
                <Section icon={GitMerge} title="Already in both workspaces">
                  <Lines lines={overlaps} />
                </Section>
              )}

              <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-sm font-medium">
                  Merge {preflight.source.name} into {destination.name}
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  <li>A snapshot of {preflight.source.name} is saved before anything moves.</li>
                  <li>
                    {preflight.source.name} is removed once everything is in {destination.name}.
                  </li>
                  <li>This cannot be undone from the app.</li>
                </ul>
                <label className="mt-4 block text-xs text-muted-foreground" htmlFor="merge-confirm-name">
                  Type <strong className="text-foreground">{preflight.source.name}</strong> to confirm
                </label>
                <Input
                  id="merge-confirm-name"
                  className="mt-1.5 bg-background"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={preflight.source.name}
                  aria-label="Type the workspace's name to confirm"
                  disabled={busy}
                  autoComplete="off"
                />
                {recording && <p className="mt-2 text-xs text-destructive">Stop the recording first; the merge reloads this window.</p>}
              </section>
            </div>
          )}

          {step === 'merging' && (
            <div className="flex flex-col items-center px-2 py-10 text-center" aria-live="polite" data-testid="merging">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="mt-5 text-base font-semibold">
                Merging {sourceName} into {destination.name}
              </p>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
                A snapshot is saved first, then {sourceName}’s people, teams and work move into {destination.name} as you reviewed.
              </p>
              <p role="timer" className="mt-5 text-xs tabular-nums text-muted-foreground">
                {formatElapsed(clock - mergeStartedAt)} elapsed · large workspaces can take a few minutes
              </p>
              {recording && <p className="mt-3 text-xs text-destructive">Stop the recording now; this window reloads when the merge finishes.</p>}
              <div className="mt-8 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                This window stays open until the merge finishes.
              </div>
            </div>
          )}

          {step === 'done' && done && (
            <div className="flex flex-col items-center px-2 py-10 text-center" aria-live="polite">
              <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
              <p className="mt-5 text-base font-semibold">Merged into {destination.name}</p>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
                {doneCounts ? `${doneCounts} came over.` : 'Everything came over.'}{' '}
                {done.membersTold !== null && done.membersTold > 0 && `${done.membersTold} ${done.membersTold === 1 ? 'person was' : 'people were'} told.`}
              </p>
              <p className="mt-5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Opening {destination.name}…
              </p>
            </div>
          )}
        </div>

        {!busy && (
          <div className="shrink-0 space-y-2 border-t border-border px-5 py-3">
            {/* In the footer, not the review: a merge that fails comes back to a review scrolled to its top. */}
            {step === 'review' && error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" data-testid="merge-cancel" onClick={onClose}>
                {step === 'pick' ? 'Close' : 'Cancel'}
              </Button>
              {preflight && (
                <Button variant="destructive" size="sm" data-testid="merge-confirm" disabled={!canMerge} onClick={merge} className="min-w-0 max-w-[70%]">
                  <span className="truncate">
                    Merge {preflight.source.name} into {destination.name}
                  </span>
                </Button>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** "0:07", "2:31": how long the merge has been running. */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function WorkspaceMark({ name }: { name: string | null }) {
  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold',
        name ? 'bg-muted text-foreground' : 'border border-dashed text-muted-foreground',
      )}
    >
      {(name && Array.from(name.trim())[0]?.toUpperCase()) || '?'}
    </span>
  )
}

/** FROM the workspace picked (emptied, then removed) INTO this one, where the person is. */
function Direction({ from, into, step }: { from: string | null; into: string; step: Step }) {
  const fromHint = step === 'done' ? 'Merged and removed' : from ? 'Emptied, then removed' : 'Choose it below'
  const intoHint = step === 'done' ? 'Everything is here now' : 'Everything lands here'
  return (
    <div className="grid grid-cols-1 items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-2" data-testid="merge-direction">
      <div className={cn('flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2.5', !from && 'border-dashed', step === 'done' && 'opacity-60')}>
        <WorkspaceMark name={from} />
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From</p>
          <p className={cn('truncate text-sm font-medium', !from && 'text-muted-foreground')}>{from ?? 'A workspace you own'}</p>
          <p className="truncate text-[11px] text-muted-foreground">{fromHint}</p>
        </div>
      </div>
      {/* Stacked on a phone, the arrow points down. */}
      <ArrowRight
        className={cn('h-4 w-4 shrink-0 rotate-90 justify-self-center text-muted-foreground sm:rotate-0', step === 'merging' && 'animate-pulse text-foreground')}
        aria-hidden
      />
      <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-foreground/25 bg-muted/40 px-3 py-2.5">
        <WorkspaceMark name={into} />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Into
            <span className="whitespace-nowrap rounded bg-foreground px-1 py-px text-[9px] font-medium normal-case tracking-normal text-background">You are here</span>
          </p>
          <p className="truncate text-sm font-medium">{into}</p>
          <p className="truncate text-[11px] text-muted-foreground">{intoHint}</p>
        </div>
      </div>
    </div>
  )
}

const STEPS = ['Choose', 'Review', 'Merge'] as const

function Steps({ step }: { step: Step }) {
  const current = step === 'pick' ? 0 : step === 'review' ? 1 : 2
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
      {STEPS.map((label, i) => {
        const complete = step === 'done' || i < current
        const active = !complete && i === current
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            {i > 0 && <span className={cn('h-px w-6', complete || active ? 'bg-foreground/40' : 'bg-border')} />}
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums',
                complete ? 'border-foreground bg-foreground text-background' : active ? 'border-foreground text-foreground' : 'border-border text-muted-foreground',
              )}
            >
              {complete ? <Check className="h-3 w-3" /> : active && step === 'merging' ? <Loader2 className="h-3 w-3 animate-spin" /> : i + 1}
            </span>
            <span className={cn(complete || active ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Section({
  icon: Icon,
  title,
  aside,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </p>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  )
}
