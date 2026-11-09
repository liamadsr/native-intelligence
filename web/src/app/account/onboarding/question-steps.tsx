'use client'

/**
 * The pre-prime onboarding question steps (source → meetings) —
 * Circleback-style: one question per screen, chip answers, Continue never
 * disabled. Every answer is OPTIONAL; the value of these screens is signal,
 * not gatekeeping, so skipping through is always allowed.
 *
 * CaptureStep is defined here but NOT in the live flow: desktop is currently
 * the only capture route we want to advertise, so the question is moot. It
 * returns to the flow when the meeting-bot option ships (desktop vs. bot).
 *
 * The wizard (onboarding-wizard.tsx) owns orchestration and all durable
 * writes — these components are presentation + local gesture only, mirroring
 * the PrimeStep/WorkingStep split in onboarding-steps.tsx. Answers persist
 * under member.onboarding_progress.answers and the meeting/capture ones are
 * folded into the research kickoff so the agent knows how this person works.
 */

import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Check, Laptop, Loader2, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { clsx } from 'clsx'

/** Durable answer bag, persisted under member.onboarding_progress.answers. */
export interface OnboardingAnswers {
  source?: string
  sourceDetail?: string
  meetingPlatforms?: string[]
  capturePreference?: 'desktop' | 'web'
}

// ─── Shared pieces ───────────────────────────────────────────

function Chip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-full border px-3.5 py-1.5 text-sm transition-colors',
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-foreground/15 text-muted-foreground hover:border-foreground/30 hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
}

/**
 * Common scaffold: title, subtitle, the question body, and the Continue/Back
 * row. Continue is never disabled (answers are optional); `submitting` only
 * guards double-fire while the wizard persists.
 */
function QuestionShell({
  title,
  subtitle,
  children,
  onContinue,
  onBack,
  submitting,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
  onContinue: () => void
  onBack?: () => void
  submitting: boolean
}) {
  return (
    <div className="flex flex-col">
      {onBack && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          type="button"
          onClick={onBack}
          className="mb-6 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </motion.button>
      )}
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-3xl font-bold tracking-tight"
      >
        {title}
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-2 text-muted-foreground"
      >
        {subtitle}
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-8"
      >
        {children}
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="mt-10"
      >
        <Button onClick={onContinue} disabled={submitting} className="w-full" size="lg">
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Continue
          {!submitting && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
      </motion.div>
    </div>
  )
}

// ─── Step: Source ("How did you hear about us?") ─────────────

const SOURCE_OPTIONS = [
  'Social media',
  'YouTube',
  'Search engine',
  'AI chat',
  'Friend',
  'Colleague',
  'Podcast',
  'Product Hunt',
  'Other',
] as const

/** Conditional follow-up chips per source — mirrors the attribution detail a
 *  bare source can't give (which platform / which engine / which assistant). */
const SOURCE_DETAILS: Partial<Record<(typeof SOURCE_OPTIONS)[number], { label: string; options: string[] }>> = {
  'Social media': {
    label: 'Which platform?',
    options: ['X (Twitter)', 'LinkedIn', 'Instagram', 'Threads', 'Reddit', 'Facebook', 'TikTok', 'Other'],
  },
  'Search engine': {
    label: 'Which search engine?',
    options: ['Google', 'Bing', 'DuckDuckGo', 'Other'],
  },
  'AI chat': {
    label: 'Which AI chat?',
    options: ['ChatGPT', 'Claude', 'Perplexity', 'Gemini', 'Copilot', 'Other'],
  },
} as const

export function SourceStep({
  onContinue,
  submitting,
}: {
  onContinue: (values: { source: string; sourceDetail: string }) => void
  submitting: boolean
}) {
  const [source, setSource] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [otherText, setOtherText] = useState('')

  const followUp = source ? SOURCE_DETAILS[source as (typeof SOURCE_OPTIONS)[number]] : undefined
  // 'Other' + free text sends the typed value; a bare 'Other' sends nothing —
  // same convention as PrimeStep's role field.
  const resolvedDetail =
    detail === 'Other' ? otherText.trim() : (detail ?? '')

  return (
    <QuestionShell
      title="How did you hear about us?"
      subtitle="We'd love to know how you discovered Native Intelligence."
      submitting={submitting}
      onContinue={() =>
        onContinue({ source: source ?? '', sourceDetail: resolvedDetail })
      }
    >
      <div className="flex flex-wrap gap-2">
        {SOURCE_OPTIONS.map((option) => (
          <Chip
            key={option}
            label={option}
            active={source === option}
            onClick={() => {
              setSource(source === option ? null : option)
              setDetail(null)
              setOtherText('')
            }}
          />
        ))}
      </div>

      {followUp && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="overflow-hidden"
        >
          <p className="mt-6 mb-2 text-sm font-medium">{followUp.label}</p>
          <div className="flex flex-wrap gap-2">
            {followUp.options.map((option) => (
              <Chip
                key={option}
                label={option}
                active={detail === option}
                onClick={() => setDetail(detail === option ? null : option)}
              />
            ))}
          </div>
          {detail === 'Other' && (
            <Input
              autoFocus
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder="Tell us more…"
              className="mt-3 h-10"
              maxLength={100}
            />
          )}
        </motion.div>
      )}
    </QuestionShell>
  )
}

// ─── Step: Meetings ("Where do your meetings happen?") ───────

const MEETING_OPTIONS = [
  'Google Meet',
  'Zoom',
  'Microsoft Teams',
  'Slack huddles',
  'Webex',
  'Phone calls',
  'In-person',
  'Other',
] as const

export function MeetingsStep({
  onContinue,
  onBack,
  submitting,
}: {
  onContinue: (values: { meetingPlatforms: string[] }) => void
  onBack: () => void
  submitting: boolean
}) {
  const [selected, setSelected] = useState<string[]>([])

  const toggle = (option: string) =>
    setSelected((current) =>
      current.includes(option)
        ? current.filter((item) => item !== option)
        : [...current, option]
    )

  return (
    <QuestionShell
      title="Where do your meetings happen?"
      subtitle="Native Intelligence works everywhere. Pick all that apply and we'll recommend the best setup."
      submitting={submitting}
      onContinue={() => onContinue({ meetingPlatforms: selected })}
      onBack={onBack}
    >
      <div className="flex flex-wrap gap-2">
        {MEETING_OPTIONS.map((option) => (
          <Chip
            key={option}
            label={option}
            active={selected.includes(option)}
            onClick={() => toggle(option)}
          />
        ))}
      </div>
    </QuestionShell>
  )
}

// ─── Step: Capture ("How do you want to record?") ────────────

const CAPTURE_OPTIONS: {
  value: 'desktop' | 'web'
  title: string
  body: string
  icon: React.ComponentType<{ className?: string }>
  recommended?: boolean
}[] = [
  {
    value: 'desktop',
    title: 'Record with the desktop app',
    body: 'Native Intelligence records right from your computer — nothing joins your call, and it works with every meeting platform.',
    icon: Laptop,
    recommended: true,
  },
  {
    value: 'web',
    title: 'Record in the browser',
    body: 'Capture meetings with your microphone straight from the web app. No install needed.',
    icon: Mic,
  },
]

export function CaptureStep({
  onContinue,
  onBack,
  submitting,
}: {
  onContinue: (values: { capturePreference: 'desktop' | 'web' }) => void
  onBack: () => void
  submitting: boolean
}) {
  const [choice, setChoice] = useState<'desktop' | 'web'>('desktop')

  return (
    <QuestionShell
      title="How should Native Intelligence capture your meetings?"
      subtitle="Choose your default. You can always change it later."
      submitting={submitting}
      onContinue={() => onContinue({ capturePreference: choice })}
      onBack={onBack}
    >
      <div className="space-y-3 text-left">
        {CAPTURE_OPTIONS.map((option) => {
          const active = choice === option.value
          const Icon = option.icon
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setChoice(option.value)}
              aria-pressed={active}
              className={clsx(
                'flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition-colors',
                active
                  ? 'border-foreground/60 bg-secondary/60'
                  : 'border-border hover:border-foreground/30'
              )}
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 font-medium text-foreground">
                  {option.title}
                  {option.recommended && (
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Recommended
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {option.body}
                </span>
              </span>
              <span
                className={clsx(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                  active
                    ? 'border-foreground bg-foreground'
                    : 'border-foreground/25'
                )}
              >
                {active && <Check className="h-3 w-3 text-background" />}
              </span>
            </button>
          )
        })}
      </div>
    </QuestionShell>
  )
}
