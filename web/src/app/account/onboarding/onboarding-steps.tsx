'use client'

/**
 * The two onboarding wizard steps (prime → working), extracted from
 * onboarding-wizard.tsx so the wizard shell stays readable. The wizard owns
 * step orchestration + all durable writes; these are presentation + local
 * gesture only.
 *
 * "Arrival": the moment the user finishes PRIME, an eve research agent starts
 * building their workspace. WORKING is the live window into that work — and it's
 * the last screen: when research goes terminal (or the user skips, or the cap
 * hits) the wizard stamps completion and drops the user into the real dashboard,
 * where the first-run brief banner delivers the payoff. DesktopDownloadTile is
 * kept here because the dashboard banner reuses it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowRight,
  Check,
  Disc,
  Download,
  ListChecks,
  Loader2,
  Sparkles,
  Target,
} from 'lucide-react'
import { OrbLoader } from '@/components/ui/loader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isDesktopApp } from '@/lib/platform'
import { ActivityIcon } from './research-companion'
import type { ResearchCompanion } from './use-research-companion'

// ─── Step: Prime ─────────────────────────────────────────────
//
// The one thing the wizard asks of the user before the agent runs: who they
// are and what they're working on. Both are OPTIONAL — Continue is never
// disabled — because the agent works fine with nothing, and a friction-free
// start beats a complete form. Whatever is entered is folded into the
// researcher's brief so its first pass is aimed at the right work.

/** Role chips — MULTI-select (people wear several hats; pick all that apply).
 *  'Other' reveals a free-text field whose value is appended to the picks. */
const ROLE_OPTIONS = [
  'Founder',
  'Engineering',
  'Product',
  'Design',
  'Sales',
  'Marketing',
  'Customer Success',
  'Operations',
  'Recruiting',
  'Other',
] as const

export function PrimeStep({
  firstName,
  onContinue,
  submitting,
  defaultRoles = [],
}: {
  firstName: string
  /**
   * Fires with the trimmed values; caps applied by the route, not here.
   *
   * `role` stays the comma-joined string the researcher brief has always read.
   * `roles` is the SAME picks unflattened, for the researcher brief —
   * re-splitting the joined string would be lossy against a free-text 'Other'
   * value containing a comma. Neither turns any feature on or off: every
   * workspace has every feature (lib/editions/manifest.ts, invariant 5).
   */
  onContinue: (values: { role: string; roles: string[]; focus: string }) => void
  submitting: boolean
  /**
   * Role chips selected on first render, from the workspace edition's
   * `onboardingDefaultRoles` (a `/sales` signup arrives with "Sales" already
   * ticked). Purely an initial value — the user deselects freely, and an empty
   * array (the default, and what the `full` edition supplies) is the blank
   * slate this step has always shown.
   *
   * Filtered against ROLE_OPTIONS so a manifest entry that names a role this
   * step doesn't offer can't seed an unrenderable, un-deselectable selection.
   */
  defaultRoles?: readonly string[]
}) {
  const [selectedRoles, setSelectedRoles] = useState<string[]>(() =>
    defaultRoles.filter((role) => (ROLE_OPTIONS as readonly string[]).includes(role))
  )
  const [otherRole, setOtherRole] = useState('')
  const [focus, setFocus] = useState('')

  const isOther = selectedRoles.includes('Other')
  // Picks + whatever was typed under 'Other'; a bare 'Other' selection with no
  // text contributes nothing (never the literal word "Other"). Kept as an array
  // AND as the joined string: the brief wants both the sentence and the exact
  // chips.
  const resolvedRoles = [
    ...selectedRoles.filter((role) => role !== 'Other'),
    ...(isOther && otherRole.trim() ? [otherRole.trim()] : []),
  ]
  const resolvedRole = resolvedRoles.join(', ')

  const toggleRole = (role: string) =>
    setSelectedRoles((current) =>
      current.includes(role)
        ? current.filter((item) => item !== role)
        : [...current, role]
    )

  const handleContinue = () => {
    if (submitting) return
    onContinue({ role: resolvedRole, roles: resolvedRoles, focus: focus.trim() })
  }

  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', duration: 0.6 }}
      >
        <img
          src="/brand/ni-mark.png"
          alt="Native Intelligence"
          className="h-12 w-12 brightness-0 dark:invert"
        />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-6 text-3xl font-bold tracking-tight"
      >
        Welcome, {firstName}
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-2 max-w-sm text-muted-foreground"
      >
        Tell me a little about you and I&apos;ll get your workspace ready.
      </motion.p>

      {/* Role chips */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="mt-8 w-full max-w-sm"
      >
        <label className="mb-2 block text-left text-sm font-medium">
          What do you do?
          <span className="ml-1.5 font-normal text-muted-foreground">
            (pick all that apply)
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          {ROLE_OPTIONS.map((role) => {
            const active = selectedRoles.includes(role)
            return (
              <button
                key={role}
                type="button"
                onClick={() => toggleRole(role)}
                aria-pressed={active}
                className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                  active
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/15 text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                }`}
              >
                {role}
              </button>
            )
          })}
        </div>

        {isOther && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="overflow-hidden"
          >
            <Input
              autoFocus
              value={otherRole}
              onChange={(e) => setOtherRole(e.target.value)}
              placeholder="e.g. Designer, Founder & CTO…"
              className="mt-3 h-10"
              maxLength={100}
            />
          </motion.div>
        )}
      </motion.div>

      {/* Focus line */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="mt-6 w-full max-w-sm"
      >
        <label className="mb-2 block text-left text-sm font-medium">
          What are you working on right now?
          <span className="ml-1.5 font-normal text-muted-foreground">
            (optional)
          </span>
        </label>
        <Input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="e.g. Shipping our v2 launch"
          className="h-11 text-base"
          maxLength={500}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleContinue()
          }}
        />
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6 }}
        className="mt-8 w-full max-w-sm"
      >
        <Button
          onClick={handleContinue}
          disabled={submitting}
          className="w-full"
          size="lg"
        >
          {submitting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Continue
          {!submitting && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          The moment you continue, an agent starts building your workspace.
        </p>
      </motion.div>
    </div>
  )
}

// ─── Step: Working ───────────────────────────────────────────
//
// The wow beat: a full-screen window into the research agent while it builds the
// workspace. Three pre-labeled GHOST rows give the wait its shape before any
// event lands; as real activity streams in, each ghost crossfades into its live
// counterpart (spinner while active, check when settled). This is the trust
// moment — the user watches the agent do the setup they were promised, then the
// card eases out and the dashboard takes over.

/**
 * Skip appears LATE (15s) now, not at 2.5s: the whole point is the user watches
 * the workspace get built. It's a late safety valve, not an early exit, and it
 * is HONEST — it routes through the same completion path as terminal + cap.
 */
const SKIP_LINK_DELAY_MS = 15_000
/** Hard cap: never leave the user staring at a working screen past this. */
const WORKING_MAX_MS = 25_000

/** The pre-labeled ghost plan, mirroring WORKING_PHASES from the companion hook. */
const GHOST_PLAN = [
  { label: 'Reading about your company', kind: 'web_search' },
  { label: 'Setting up a starter project', kind: 'save_starter_content' },
  { label: 'Drafting your first actions', kind: 'finish_research' },
] as const

export function WorkingStep({
  companion,
  onComplete,
}: {
  companion: ResearchCompanion
  /**
   * The ONE completion path — stamps onboarding_completed_at and navigates to
   * the dashboard. Shared by all three triggers (terminal research, the 25s cap,
   * the skip link); this component guards double-fire and runs the exit motion,
   * then awaits this exactly once.
   */
  onComplete: () => void | Promise<void>
}) {
  const { status, activities, activePhase, companyName } = companion
  const [showSkip, setShowSkip] = useState(false)
  // Two-phase exit: `settling` runs the terminal settle beat (rows → checks,
  // ring eases to a stop); `exiting` scales/fades the card before we navigate.
  const [settling, setSettling] = useState(false)
  const [exiting, setExiting] = useState(false)
  const advancedRef = useRef(false)

  // Run the exit motion, then hand off to the single completion path exactly
  // once. `terminal` distinguishes the graceful research-finished path (settle
  // beat first) from an abrupt skip/cap (straight to the exit fade).
  const advance = useCallback(
    (opts: { terminal: boolean }) => {
      if (advancedRef.current) return
      advancedRef.current = true

      const runExit = () => {
        setExiting(true)
        // Match the card's scale/fade duration (~0.35s) before navigating.
        setTimeout(() => {
          void onComplete()
        }, 350)
      }

      if (opts.terminal) {
        // Terminal settle beat: let the rows finish settling to checks and the
        // ring ease to a stop (~0.15s), then run the exit.
        setSettling(true)
        setTimeout(runExit, 150)
      } else {
        runExit()
      }
    },
    [onComplete],
  )

  // A terminal research status ('done'/'skipped'/'failed') advances via the
  // graceful settle path. 'failed' is deliberately silent — a dead spinner is
  // never acceptable, and the dashboard banner degrades to "no brief" on its own.
  useEffect(() => {
    if (status === 'done' || status === 'skipped' || status === 'failed') {
      advance({ terminal: true })
    }
  }, [status, advance])

  // Reveal the skip link late, and enforce the hard cap. Both take the abrupt
  // (non-terminal) path — no settle beat, just the exit fade.
  useEffect(() => {
    const skipTimer = setTimeout(() => setShowSkip(true), SKIP_LINK_DELAY_MS)
    const capTimer = setTimeout(() => advance({ terminal: false }), WORKING_MAX_MS)
    return () => {
      clearTimeout(skipTimer)
      clearTimeout(capTimer)
    }
  }, [advance])

  // Auto-scroll the activity list to the newest row as it grows.
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activities.length])

  const hasEvents = activities.length > 0
  // Once settling/terminal, everything reads as done (no lingering spinner).
  const allSettled =
    settling || status === 'done' || status === 'skipped' || status === 'failed'

  // Headline swaps to the company name the moment one lands — never guessed, so
  // it stays generic if no name ever arrives.
  const headline = companyName
    ? `Setting up ${companyName}`
    : 'Setting up your workspace'

  return (
    <motion.div
      animate={exiting ? { scale: 0.96, opacity: 0 } : { scale: 1, opacity: 1 }}
      transition={{ duration: 0.35, ease: 'easeInOut' }}
      className="flex flex-col items-center text-center"
    >
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="relative flex h-14 w-14 items-center justify-center rounded-full bg-muted"
      >
        {/* The rotating ring eases to a stop on the terminal settle beat. While
            working it loops through a full turn; once settled it glides to a
            fixed resting angle (a distinct target, so Framer actually eases it to
            a stop rather than seeing an unchanged value and doing nothing). */}
        <motion.div
          animate={{ rotate: allSettled ? 360 : [0, 360] }}
          transition={
            allSettled
              ? { duration: 0.6, ease: 'easeOut' }
              : { duration: 8, repeat: Infinity, ease: 'linear' }
          }
          className="absolute inset-0 rounded-full border-2 border-dashed border-foreground/15"
        />
        <OrbLoader state="working" size="sm" />
      </motion.div>

      <div className="mt-6 flex h-8 items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.h1
            key={headline}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
            className="text-2xl font-bold tracking-tight"
          >
            {headline}
          </motion.h1>
        </AnimatePresence>
      </div>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="mt-2 max-w-sm text-muted-foreground"
      >
        I&apos;m getting to know your work so everything&apos;s ready when you
        arrive. This only takes a moment.
      </motion.p>

      {/* The ghost plan → live checklist. The three ghost rows alone give the
          wait its shape before any event arrives. */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35 }}
        className="onboarding-working-list relative mt-8 w-full max-w-sm rounded-xl border bg-card p-4 text-left"
      >
        <div
          ref={listRef}
          className="max-h-[46vh] space-y-2.5 overflow-y-auto"
        >
          {/* Ghost plan — always present; each row crossfades to live once its
              phase begins. `settled` when a later phase has started (or research
              is terminal), `active` while it's the current phase. */}
          <ul className="space-y-2.5">
            {GHOST_PLAN.map((row, phase) => {
              const reached = activePhase !== null && activePhase >= phase
              const rowSettled = allSettled || (activePhase !== null && activePhase > phase)
              const rowActive = !allSettled && activePhase === phase
              return (
                <li
                  key={row.label}
                  className="flex items-center gap-2.5 text-sm"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <AnimatePresence mode="wait" initial={false}>
                      {rowSettled ? (
                        <motion.span
                          key="check"
                          initial={{ opacity: 0, scale: 0.6 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.2 }}
                        >
                          <Check className="h-4 w-4 text-foreground" />
                        </motion.span>
                      ) : rowActive ? (
                        <motion.span
                          key="spin"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.2 }}
                        >
                          <ThinkingOrb state="working" size={20} theme="auto" />
                        </motion.span>
                      ) : (
                        // Ghost: hollow, dashed indicator before its phase starts.
                        <motion.span
                          key="ghost"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="h-3 w-3 rounded-full border border-dashed border-muted-foreground/40"
                        />
                      )}
                    </AnimatePresence>
                  </span>
                  <span
                    className={`min-w-0 truncate transition-colors duration-200 ${
                      reached ? 'text-foreground' : 'text-muted-foreground/60'
                    }`}
                  >
                    {row.label}
                  </span>
                </li>
              )
            })}
          </ul>

          {/* Live activity rows stream in beneath the plan, newest at the bottom,
              each a settled check with its real friendly label + tool icon. */}
          {hasEvents && (
            <ul className="space-y-2.5 border-t border-border/50 pt-2.5">
              <AnimatePresence initial={false}>
                {activities.map((activity, i) => {
                  const isLast = i === activities.length - 1
                  const current = isLast && status === 'running' && !allSettled
                  return (
                    <motion.li
                      key={activity.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2 }}
                      className="flex items-center gap-2.5 text-sm"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {current ? (
                          <ThinkingOrb state="working" size={20} theme="auto" />
                        ) : (
                          <Check className="h-4 w-4 text-foreground" />
                        )}
                      </span>
                      <span
                        className={`flex min-w-0 items-center gap-1.5 ${
                          current ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        <ActivityIcon kind={activity.kind} />
                        <span className="truncate">{activity.label}</span>
                      </span>
                    </motion.li>
                  )
                })}
              </AnimatePresence>
            </ul>
          )}
        </div>
        {/* Bottom fade mask over the scroll container. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-xl bg-gradient-to-t from-card to-transparent" />
      </motion.div>

      {/* Late safety valve — a trust line + honest skip, both fading in at 15s.
          The skip routes through the SAME completion path as terminal/cap. */}
      <AnimatePresence>
        {showSkip && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-6 flex flex-col items-center gap-1.5"
          >
            <p className="text-xs text-muted-foreground">
              You can leave anytime — I&apos;ll keep building your workspace.
            </p>
            <button
              onClick={() => advance({ terminal: false })}
              className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              Skip — take me to my workspace
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ─── Desktop-app download tile ───────────────────────────────
//
// Folded in from the old dedicated "app" step; the READY step is gone but this
// stays — the dashboard's first-run brief banner reuses it as a dismissible
// download chip. Auto-hides when we're already inside the desktop app, where
// capture is native and the download tile would be noise.

export function DesktopDownloadTile() {
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    setIsDesktop(isDesktopApp())
  }, [])

  // Already on desktop → nothing to download.
  if (isDesktop) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.45 }}
      className="mt-6 w-full max-w-sm rounded-xl border bg-card p-6 text-left"
    >
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
          <img
            src="/brand/ni-mark.png"
            alt="Native Intelligence"
            className="h-8 w-8 brightness-0 dark:invert"
          />
        </div>
        <div className="text-left">
          <div className="font-semibold">Native Intelligence for macOS</div>
          <div className="text-sm text-muted-foreground">
            Auto-capture meetings, extract actions
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3 text-center">
        {[
          { Icon: Disc, label: 'Capture' },
          { Icon: ListChecks, label: 'Extract' },
          { Icon: Target, label: 'Drive outcomes' },
        ].map(({ Icon, label }) => (
          <div key={label} className="rounded-lg bg-muted/50 py-2.5 text-xs">
            <div className="flex justify-center">
              <Icon className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-1 text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>

      <a
        href="/api/download"
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-foreground py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        <Download className="h-4 w-4" />
        Download for macOS
      </a>
    </motion.div>
  )
}
