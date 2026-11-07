'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

import { ThinkingOrb } from 'thinking-orbs'
import { usePostHog } from 'posthog-js/react'
import { useResearchCompanion } from './use-research-companion'
import { hardNavigate, DOCUMENT_SCOPE_HEADERS } from './hard-navigate'
import { PrimeStep, WorkingStep } from './onboarding-steps'
import { getEdition } from '@/lib/editions'
import { PermissionsStep, type PermissionsOutcome } from './permissions-step'
import {
  SourceStep,
  MeetingsStep,
  type OnboardingAnswers,
} from './question-steps'
import { isDesktopApp } from '@/lib/platform'
import { tauriBridge } from '@/lib/tauri-bridge'

/** Set once a Mac's first onboarding has turned Auto-record on. */
const AUTO_RECORD_DEFAULT_KEY = 'dial8:auto-record-default-applied'

// ─── Types ───────────────────────────────────────────────────

/** Durable onboarding-research state, persisted under
 *  member.onboarding_progress.research (see use-research-companion.ts — this is
 *  the wizard's LOCAL copy of that shape, kept in sync with the hook by hand).
 *
 *  'starting'/'error' are the kickoff route's claim-lifecycle states: 'starting'
 *  is a pre-session claim placeholder, 'error' a terminal-but-re-claimable
 *  failed start. Neither carries a brief. */
export interface DurableResearch {
  sessionId?: string
  status?: 'starting' | 'running' | 'done' | 'skipped' | 'error'
  startedAt?: string
  finishedAt?: string
  brief?: string
  companyFound?: boolean
  /** Written by finish_research once the agent has seeded starter content. The
   *  wizard no longer renders this (READY is gone) — it now surfaces in the
   *  dashboard's first-run brief banner — but the durable shape is unchanged. */
  seededSummary?: {
    projectName: string
    actionCount: number
    workspaceRenamed?: string
  }
}

interface OnboardingData {
  member: {
    id: string
    displayName: string
    onboardingCompletedAt: string | null
    // Step flags are booleans; `research` and `answers` are the structured
    // sub-objects (agent state and the question-step answer bag respectively).
    onboardingProgress: Record<string, boolean> & {
      research?: DurableResearch
      answers?: OnboardingAnswers
    }
  }
  connectedAccounts: { id: string; provider: string }[]
  /**
   * `edition` is the persona this workspace was attributed to at signup (the
   * landing page the user came from). Optional on the wire so an older cached
   * response, or a GET that predates this field, degrades to `full` rather than
   * throwing — the same fail-open contract the manifest guarantees everywhere.
   */
  workspace: { id: string; edition?: string }
  /** Supabase user id; optional so an older cached response still loads. */
  userId?: string
  userEmail: string | null
  userName: string | null
  avatarUrl: string | null
}

// The wizard is a run of quick, all-optional question beats (SOURCE → MEETINGS
// — Circleback-style, one question per screen), then PRIME (who are you), then
// PERMISSIONS (desktop shell only — mic + system audio, Circleback-style
// sequential cards), then WORKING (the agent builds your workspace). There is
// no READY step; arriving in the real dashboard IS the payoff, and the
// dashboard's first-run brief banner delivers the note.
//
// PERMISSIONS deliberately sits between prime and working: prime's Continue
// fires the research kickoff, so the agent researches in the background WHILE
// the user grants permissions — the grants hide the research latency instead
// of adding their own. It renders ONLY inside the Tauri shell: on web there
// is nothing to grant (the browser mic prompt happens at getUserMedia time),
// so resume skips the step entirely — its durable flag is written by desktop
// flows alone, and a web member's missing flag must never strand them on an
// invisible step.
//
// CAPTURE (desktop vs. browser) was cut 2026-08-12: desktop is the only
// capture route we advertise, so the question had one real answer. The step
// component survives in question-steps.tsx for when the meeting-bot option
// ships. A member who answered it mid-flow keeps `capture: true` + their
// answer in durable state; resume simply no longer visits it.
type Step = 'source' | 'meetings' | 'prime' | 'permissions' | 'working'

const STEPS: Step[] = ['source', 'meetings', 'prime', 'permissions', 'working']

/** The question steps that precede prime, in order. Resume walks these flags
 *  front-to-back, so a reload lands on the first unanswered question. */
const QUESTION_STEPS = ['source', 'meetings'] as const satisfies readonly Step[]

// A research status is terminal (for wizard purposes) once the agent can do no
// more work: it finished, skipped, or its start failed. 'starting'/'running'
// are still in-flight. Exported for the step-resume unit test.
export function isTerminalResearch(status: DurableResearch['status']): boolean {
  return status === 'done' || status === 'skipped' || status === 'error'
}

/**
 * Sentinel returned by resumeStepIndex for a member whose work is already done
 * from their durable state — they primed and research has gone terminal (or
 * never ran). There is no READY step to land on anymore, so the wizard reads
 * this and advances straight to the dashboard (stamping completion) instead of
 * rendering a step. Guarding a persisted 'ready' this way means a user mid-
 * onboarding when this deploys resolves to "complete", never a crash.
 */
export const COMPLETE_INDEX = STEPS.length

/**
 * Where a returning/reloading member lands, from their durable state alone.
 *
 *   • unanswered question steps remain              → first unanswered question
 *   • questions done, no prime yet                  → prime
 *   • primed, desktop shell, permissions unhandled  → permissions (never on web)
 *   • primed, research still working                → working (reattach the stream)
 *   • primed, research terminal/absent              → COMPLETE_INDEX (dashboard)
 *
 * `desktop` is a RUNTIME parameter, not durable state: the same member can
 * onboard from the browser one day and the desktop app the next, and the
 * permissions step must follow the surface they're on right now. Web members
 * never accumulate a `permissions` flag — passing desktop=false skips the
 * step so its absent flag can't strand them.
 *
 * The permissions check outranks the research checks: a primed desktop member
 * who still owes grants lands on permissions even when research already went
 * terminal — that gate is the step's whole point, and WORKING auto-advances
 * on its already-terminal status right after. Research still in flight simply
 * keeps streaming in the background (the companion is attached) while the
 * permissions cards are up.
 *
 * The question flags are only consulted while prime is incomplete: a primed
 * member never resumes backwards into the questionnaire, including members who
 * primed before the question steps existed (their flags are absent, but
 * `prime: true` short-circuits past them).
 *
 * A reload mid-research must resume ON working with the companion reattached —
 * the hook rehydrates from the same `research` blob, so the checklist picks up
 * where it left off. (onboardingCompletedAt short-circuits to the dashboard
 * before we ever get here.) A finished/absent run has nothing left to show in
 * the wizard, so it resolves to COMPLETE_INDEX and the shell navigates out.
 */
export function resumeStepIndex(
  progress: OnboardingData['member']['onboardingProgress'],
  desktop = false,
): number {
  const primed = progress.prime === true
  if (!primed) {
    for (const step of QUESTION_STEPS) {
      if (progress[step] !== true) return STEPS.indexOf(step)
    }
    return STEPS.indexOf('prime')
  }
  if (desktop && progress.permissions !== true) {
    return STEPS.indexOf('permissions')
  }
  const research = progress.research
  if (research && !isTerminalResearch(research.status)) {
    return STEPS.indexOf('working')
  }
  return COMPLETE_INDEX
}

// ─── Loader shell ────────────────────────────────────────────
//
// Splits the wizard in two so the research companion's `initial` rehydration is
// actually consumable. `useResearchCompanion` seeds all of its durable state
// (status/brief/companyFound/seededSummary/sessionId/terminal) ONLY in its
// useState/useRef initializers, which React runs once on the hook's first
// render. If the hook lived on this shell it would mount with `initial: null`
// (the GET hasn't resolved yet) and never re-consume the durable blob when it
// lands — so a reload after research finished would flash a fresh kickoff POST
// + stream instead of the instant brief. Mounting WizardBody only AFTER the GET
// resolves means the hook's true first render already has `initial` in hand.

export function OnboardingWizard() {
  const [data, setData] = useState<OnboardingData | null>(null)
  const [loading, setLoading] = useState(true)

  // Fetch onboarding data. Redirects out on error or an already-completed
  // member; otherwise hands the loaded blob to WizardBody, which owns the
  // companion + step state from its own first render.
  //
  // Every exit here is a hardNavigate, never router.replace: these paths fire
  // with NO user gesture, so if the client router served /account from a stale
  // cache entry that still redirects back here, a soft navigation would loop
  // silently forever (the production /account ↔ /account/onboarding ping-pong).
  // A document navigation forces the server to re-read completion state, which
  // terminates any such cycle in one hop.
  useEffect(() => {
    // Unmount guard: hardNavigate is a window-level navigation, so a GET still
    // in flight when this shell unmounts (user soft-navigated away) must not
    // yank them off whatever page they moved to.
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/account/onboarding', {
          headers: DOCUMENT_SCOPE_HEADERS,
        })
        if (cancelled) return
        if (!res.ok) {
          hardNavigate('/account')
          return
        }
        const d: OnboardingData = await res.json()
        if (cancelled) return

        // Already completed — go to dashboard
        if (d.member.onboardingCompletedAt) {
          hardNavigate('/account')
          return
        }

        setData(d)
      } catch {
        if (!cancelled) hardNavigate('/account')
      } finally {
        setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading || !data) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <ThinkingOrb state="breathing" size={64} theme="auto" />
      </div>
    )
  }

  // Key on the member id so a re-fetch that swaps identity remounts cleanly.
  // Within a single member, WizardBody stays mounted (its own terminal refresh
  // updates data in place without remounting).
  return <WizardBody key={data.member.id} initialData={data} />
}

// ─── Main Wizard body (mounts only once data is loaded) ──────

function WizardBody({ initialData }: { initialData: OnboardingData }) {
  const [data] = useState<OnboardingData>(initialData)
  const [saving, setSaving] = useState(false)

  // Resume from durable state on this component's FIRST render — the same render
  // at which the companion below consumes `initial`. A reload after prime lands
  // on working (reattach); a fresh member lands on prime; a finished/absent run
  // resolves to COMPLETE_INDEX and the shell navigates straight to the dashboard.
  const initialProgress = initialData.member.onboardingProgress
  const [currentStep, setCurrentStep] = useState(() =>
    // WizardBody only mounts client-side (after the shell's GET resolves), so
    // the Tauri-shell check is reliable here — never evaluated during SSR.
    resumeStepIndex(initialProgress, isDesktopApp()),
  )

  // True once PRIME is complete OR we rehydrated a member whose prime already
  // ran (a mid-flow reload must reattach the stream even though this session
  // never clicked Continue). Gates the research companion's kickoff so we never
  // start the agent before the user has told us who they are. Seeded from the
  // loaded blob so rehydration re-enables the companion on the first render.
  const [primeComplete, setPrimeComplete] = useState(
    () => initialProgress.prime === true,
  )

  // ── Onboarding research companion ──────────────────────────
  // Consumes the durable research agent: rehydrates any in-flight/finished run
  // from the loaded GET (present on THIS first render — see OnboardingWizard),
  // surfaces friendly live activity + the final brief, and (once enabled) fires
  // the idempotent kickoff. Research must NEVER block or error the wizard — the
  // hook swallows all failures internally. `enabled` is held until prime
  // completes so kickoff carries the user's role/focus priming and never runs
  // early; on a rehydrated reload primeComplete is already true, so the hook
  // re-attaches straight to the durable run without a redundant kickoff POST.
  const companion = useResearchCompanion({
    initial: initialProgress.research ?? null,
    enabled: primeComplete,
  })

  // New desktop users record meetings automatically (Liam, 2026-10-08: the
  // one meeting setting, Auto-record, defaults on; the desktop's own default
  // stays off for anyone who never onboards on it). Once per Mac, so a
  // second workspace's onboarding never overrides a choice made since.
  useEffect(() => {
    if (!isDesktopApp()) return
    try {
      if (window.localStorage.getItem(AUTO_RECORD_DEFAULT_KEY)) return
      window.localStorage.setItem(AUTO_RECORD_DEFAULT_KEY, '1')
    } catch {
      return
    }
    void Promise.resolve()
      .then(() => tauriBridge.setAutoRecord(true))
      .catch(() => {})
  }, [])

  // NOTE: deliberately NO router.prefetch('/account') here. While the wizard is
  // showing, member.onboarding_completed_at is by definition still null, so a
  // prefetch of /account can only ever capture the (dashboard)/layout.tsx
  // redirect BACK to /account/onboarding — a poisoned cache entry, not a warm
  // dashboard. Replaying it after the completion stamp caused the production
  // redirect ping-pong between the two routes. The exit is a hardNavigate
  // (fresh document request), so there is nothing useful to prefetch.

  const saveProgress = useCallback(
    async (patch: Record<string, unknown>, extra?: Record<string, unknown>) => {
      setSaving(true)
      try {
        await fetch('/api/account/onboarding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...DOCUMENT_SCOPE_HEADERS },
          body: JSON.stringify({
            progress: patch,
            ...extra,
          }),
        })
      } catch {
        // continue anyway
      } finally {
        setSaving(false)
      }
    },
    [],
  )

  // ── Question steps (source → meetings → capture) ───────────
  // Accumulated answer bag, rehydrated from durable state so a reload keeps
  // earlier answers. Each Continue persists its step flag AND the FULL bag —
  // the merge RPC shallow-merges top-level keys, so `answers` is overwritten
  // whole and must always be sent complete, never as a fragment.
  const answersRef = useRef<OnboardingAnswers>({
    ...(initialProgress.answers ?? {}),
  })
  const posthog = usePostHog()

  // Identify now, not only once the dashboard loads (dashboard-shell does it
  // too, the same way): someone who gets stuck in onboarding must be findable
  // by email in PostHog, with every event of theirs (onboarding's, and on
  // the desktop the speech models') on their profile.
  useEffect(() => {
    if (!initialData.userId || !initialData.userEmail) return
    posthog?.identify(initialData.userId, {
      email: initialData.userEmail,
      ...(initialData.userName ? { name: initialData.userName } : {}),
    })
  }, [posthog, initialData.userId, initialData.userEmail, initialData.userName])

  // ── Permissions (desktop shell only) ────────────────────────
  // Analytics mirror the question/prime conventions: one event per user
  // outcome as it happens (`onboarding_permission_result` — every Allow /
  // Settings-toggle result, so the funnel shows WHERE grants stall), plus the
  // step-level `onboarding_permissions_done` on advance, with final states
  // $set onto the person profile so "how many desktop users granted mic /
  // system audio during onboarding" is a person-property breakdown, not event
  // archaeology (same pattern as onboarding_source / meeting_platforms /
  // role).
  const handlePermissionResult = useCallback(
    (permission: 'microphone' | 'system_audio', result: string) => {
      posthog?.capture('onboarding_permission_result', { permission, result })
    },
    [posthog],
  )

  // The durable flag records "this step was handled", not "everything
  // granted" — a post-denial skip also advances (the recording-start mic gate
  // still protects capture).
  const handlePermissionsContinue = useCallback(
    (outcome: PermissionsOutcome) => {
      void saveProgress({ permissions: true })
      posthog?.capture('onboarding_permissions_done', {
        microphone: outcome.microphone,
        system_audio: outcome.systemAudio,
        skipped: outcome.skipped,
        $set: {
          onboarding_mic_permission: outcome.microphone,
          onboarding_system_audio_permission: outcome.systemAudio,
        },
      })
      setCurrentStep(STEPS.indexOf('working'))
    },
    [saveProgress, posthog],
  )

  const handleQuestionContinue = useCallback(
    (step: (typeof QUESTION_STEPS)[number], patch: Partial<OnboardingAnswers>) => {
      answersRef.current = { ...answersRef.current, ...patch }
      // Best-effort persist (same contract as prime): a failed write must
      // never block the flow, it only costs resume fidelity.
      void saveProgress({ [step]: true, answers: answersRef.current })
      // Mirror the answers onto the PERSON via $set (not just the event) so
      // "who are our users" questions are answerable with person-property
      // breakdowns/filters in PostHog, not event archaeology.
      const personProps: Record<string, unknown> = {}
      if (patch.source) personProps.onboarding_source = patch.source
      if (patch.sourceDetail) personProps.onboarding_source_detail = patch.sourceDetail
      if (patch.meetingPlatforms?.length) personProps.meeting_platforms = patch.meetingPlatforms
      posthog?.capture('onboarding_question_answered', {
        step,
        ...patch,
        ...(Object.keys(personProps).length > 0 ? { $set: personProps } : {}),
      })
      setCurrentStep(STEPS.indexOf(step) + 1)
    },
    [saveProgress, posthog],
  )

  // Back among the question/prime screens is a purely local gesture — answered
  // flags stay persisted, so it never rewinds durable state.
  const handleBack = useCallback(() => {
    setCurrentStep((index) => Math.max(0, index - 1))
  }, [])

  // ── Prime → Working ────────────────────────────────────────
  // On Continue: persist the prime flag (swallow-on-failure), fire the research
  // kickoff WITH the collected priming, then advance. Kickoff lives HERE (not in
  // a data-load effect) so it carries role/focus and only ever runs once the
  // user has answered. The POST is fire-and-forget; the companion attaches to
  // the run via the durable read + stream — we never await it before advancing.
  const handlePrimeContinue = useCallback(
    async (values: { role: string; roles: string[]; focus: string }) => {
      if (saving) return
      setSaving(true)
      // Mark prime done (best-effort). Doesn't block the kickoff or advance.
      void saveProgress({ prime: true })
      // Role onto the person profile (multi-select joins as "A, B, C") so user
      // segmentation by role works in PostHog. Focus stays event-only — it's
      // free text, useful for reading, not for breakdowns.
      posthog?.capture('onboarding_primed', {
        role: values.role,
        has_focus: Boolean(values.focus),
        ...(values.role ? { $set: { role: values.role } } : {}),
      })
      try {
        // Retry once on a non-ok response: a fresh session (e.g. straight from
        // an email-confirmation link) can hit a transient 401 during token
        // rotation, and the primed kickoff must land BEFORE the companion's
        // idempotent unprimed one — the idempotent path ignores late priming.
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await fetch('/api/account/onboarding/research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...DOCUMENT_SCOPE_HEADERS },
            body: JSON.stringify({
              role: values.role,
              // The same picks unflattened, for the researcher's brief: the
              // joined string can't be re-split without losing a
              // comma-bearing 'Other'.
              roles: values.roles,
              focus: values.focus,
              // Question-step answers ride along so the researcher's brief
              // knows how this person meets. Attribution (source) stays out —
              // it's analytics, not research context. (capturePreference is no
              // longer collected; the route still tolerates it if a resumed
              // member's durable answers carry one.)
              meetingPlatforms: answersRef.current.meetingPlatforms,
            }),
          })
          if (res.ok) break
          if (attempt === 0) await new Promise((r) => setTimeout(r, 600))
        }
      } catch {
        // Kickoff failure must never block onboarding — the companion also
        // degrades to a quiet 'failed', and working auto-advances regardless.
      } finally {
        setSaving(false)
      }
      // Enable the companion (idempotent kickoff / stream attach) and advance —
      // through PERMISSIONS in the desktop shell (unless a previous desktop
      // session already handled it), straight to WORKING on web. The kickoff
      // above has already fired either way, so research runs in the background
      // while the permission cards are up.
      setPrimeComplete(true)
      setCurrentStep(
        STEPS.indexOf(
          isDesktopApp() && initialProgress.permissions !== true
            ? 'permissions'
            : 'working',
        ),
      )
    },
    [saving, saveProgress, posthog, initialProgress],
  )

  // ── The single advance path (Working → dashboard) ──────────
  // Stamp onboarding_completed_at, THEN navigate — but only on a confirmed stamp.
  // This is the ONE completion path, shared by all three WORKING triggers
  // (terminal research, the 25s cap, and the skip link) — WorkingStep guards
  // double-fire and runs its exit animation, then calls this exactly once.
  //
  // We must NOT navigate on a failed stamp: (dashboard)/layout.tsx redirects any
  // member whose onboarding_completed_at is still null straight back here, and a
  // COMPLETE_INDEX resume re-fires this from an effect with no user gesture — so
  // a persistently-failing PATCH + unconditional replace is a silent, unthrottled
  // redirect loop that also hammers the failing endpoint. Instead: retry the
  // PATCH twice, and only replace on success. If both attempts fail, surface a
  // retryable error (breaking the loop) rather than bouncing back and forth.
  const [stampError, setStampError] = useState(false)
  // Marks a completion attempt in flight/handled so the COMPLETE_INDEX resume
  // effect never double-fires this (it keys off currentStep, which we move to
  // COMPLETE_INDEX on failure). The retry button re-arms it explicitly.
  const completedRef = useRef(false)
  const advanceToDashboard = useCallback(async () => {
    completedRef.current = true
    setSaving(true)
    setStampError(false)
    let stamped = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('/api/account/onboarding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...DOCUMENT_SCOPE_HEADERS },
          body: JSON.stringify({ completed: true }),
        })
        if (res.ok) {
          stamped = true
          break
        }
      } catch {
        // fall through to retry
      }
    }
    if (stamped) {
      // hardNavigate (location.replace) so the wizard is not in history AND the
      // arrival is a fresh document request: the server layout re-reads the
      // just-written stamp, so it can never bounce us back here off a stale
      // client-cached redirect. Do NOT swap this for router.replace — that
      // reintroduces the /account ↔ /account/onboarding loop.
      hardNavigate('/account')
      return
    }
    // Stamp never landed. Do NOT navigate (the layout would bounce us right
    // back). Show a manual retry so the user is never trapped mid-loop. Move to
    // COMPLETE_INDEX so the retry UI renders regardless of whether this fired
    // from WORKING's onComplete (its card has already faded out) or the resume
    // effect — the WORKING step never surfaces this error itself.
    setSaving(false)
    setStampError(true)
    setCurrentStep(COMPLETE_INDEX)
  }, [])

  // A member who resolved to COMPLETE_INDEX (primed, research already terminal or
  // absent — including a persisted legacy 'ready') has no wizard step to show;
  // stamp completion and navigate straight through. Guarded by advanceToDashboard
  // via WorkingStep's own double-fire ref would not apply here (that ref lives in
  // WorkingStep, which isn't mounted on this path), so fire once from an effect.
  // Auto-fires exactly ONCE: advanceToDashboard sets completedRef immediately, so
  // its own setCurrentStep(COMPLETE_INDEX) on a failed stamp can't re-trigger
  // this — a failed stamp shows the retry UI instead of looping. The retry button
  // re-arms the ref explicitly.
  useEffect(() => {
    if (currentStep >= COMPLETE_INDEX && !completedRef.current) {
      void advanceToDashboard()
    }
  }, [currentStep, advanceToDashboard])

  const firstName = useMemo(() => {
    return (data.userName ?? data.userEmail ?? 'there').split(' ')[0]
  }, [data])

  const step = STEPS[currentStep]

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      {/* Draggable title bar region for desktop app */}
      <div data-tauri-drag-region className="h-11 shrink-0" />

      {/* Content */}
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-lg">
          <AnimatePresence mode="wait">
            <motion.div
              key={step ?? 'complete'}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.25 }}
            >
              {step === 'permissions' && (
                <PermissionsStep
                  submitting={saving}
                  onContinue={handlePermissionsContinue}
                  onResult={handlePermissionResult}
                />
              )}
              {step === 'source' && (
                <SourceStep
                  submitting={saving}
                  onContinue={({ source, sourceDetail }) =>
                    handleQuestionContinue('source', { source, sourceDetail })
                  }
                />
              )}
              {step === 'meetings' && (
                <MeetingsStep
                  submitting={saving}
                  onBack={handleBack}
                  onContinue={({ meetingPlatforms }) =>
                    handleQuestionContinue('meetings', { meetingPlatforms })
                  }
                />
              )}
              {step === 'prime' && (
                <PrimeStep
                  firstName={firstName}
                  submitting={saving}
                  // The persona's role chips start selected; the user is free to
                  // deselect them. `full` (and any unstamped workspace) supplies
                  // none, which is the blank slate this step has always shown.
                  defaultRoles={getEdition(data.workspace.edition).onboardingDefaultRoles}
                  onContinue={handlePrimeContinue}
                />
              )}
              {step === 'working' && (
                <WorkingStep companion={companion} onComplete={advanceToDashboard} />
              )}
              {/* COMPLETE_INDEX: no step — a quiet spinner while advanceToDashboard
                  stamps completion and navigates. If the stamp fails outright,
                  we stop (navigating would bounce back via the layout redirect)
                  and offer a manual retry instead of a silent redirect loop. */}
              {step === undefined && !stampError && (
                <div className="flex items-center justify-center py-12">
                  <ThinkingOrb state="working" size={64} theme="auto" />
                </div>
              )}
              {step === undefined && stampError && (
                <div className="flex flex-col items-center gap-4 py-12 text-center">
                  <p className="max-w-sm text-sm text-muted-foreground">
                    We couldn&apos;t finish setting up just yet. Your workspace is
                    ready — try again to jump in.
                  </p>
                  <button
                    onClick={() => {
                      completedRef.current = false
                      void advanceToDashboard()
                    }}
                    disabled={saving}
                    className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? (
                      <ThinkingOrb state="working" size={20} theme="auto" />
                    ) : (
                      'Take me to my workspace'
                    )}
                  </button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
