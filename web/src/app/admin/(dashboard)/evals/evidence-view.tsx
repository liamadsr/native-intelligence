import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  isNudgeReason,
  NUDGE_REASON_LABELS,
  type ChatTurnEvidence,
  type DraftDismissedEvidence,
  type DraftRewriteEvidence,
  type LoopRunEvidence,
} from '@/lib/evals/flywheel/types'
import type { AdminEvalCandidate } from './labels'

/**
 * A candidate's evidence, drawn by kind: a chat turn (the request, the reply's
 * opening, the tool path with the failed steps marked, the skills it loaded),
 * a failed background job (its error, the flow's failed actions, the log's
 * end), a draft rewrite (a score and pointers only: Dial8 stores no mail, so
 * there is no text to show; the reviewer reads the thread live) or a
 * dismissed draft (its reason and pointers, likewise).
 */
export function EvidenceView({ row }: { row: AdminEvalCandidate }) {
  const evidence = row.evidence as Partial<{ kind: string }>
  return (
    <div className="space-y-4">
      {evidence.kind === 'chat_turn' ? (
        <ChatTurn evidence={row.evidence as ChatTurnEvidence} />
      ) : evidence.kind === 'loop_run' ? (
        <LoopRun evidence={row.evidence as LoopRunEvidence} />
      ) : evidence.kind === 'draft_rewrite' ? (
        <DraftRewrite evidence={row.evidence as DraftRewriteEvidence} />
      ) : evidence.kind === 'draft_dismissed' ? (
        <DraftDismissed evidence={row.evidence as DraftDismissedEvidence} />
      ) : (
        <p className="text-sm text-muted-foreground">No evidence recorded.</p>
      )}
      {row.reason ? (
        <Section title="Their reason">
          <p className="whitespace-pre-wrap text-sm">{row.reason}</p>
        </Section>
      ) : null}
    </div>
  )
}

function ChatTurn({ evidence }: { evidence: ChatTurnEvidence }) {
  const steps = Array.isArray(evidence.steps) ? evidence.steps : []
  const loads = Array.isArray(evidence.loads) ? evidence.loads : []
  return (
    <>
      <Section title="Request">
        <TextBlock>{evidence.request || '—'}</TextBlock>
      </Section>
      {evidence.reply ? (
        <Section title="Reply (opening)">
          <TextBlock>{evidence.reply}</TextBlock>
        </Section>
      ) : null}
      <Section title={`Tool steps (${steps.length})`}>
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tool calls.</p>
        ) : (
          <ol className="space-y-1.5">
            {steps.map((step, i) => (
              <li
                key={i}
                data-step-ok={step.ok ? 'true' : 'false'}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-xs',
                  step.ok ? 'border-border' : 'border-rose-500/30 bg-rose-500/5',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
                  <span className="font-mono font-medium">{step.name}</span>
                  {step.ok ? (
                    <span className="text-emerald-600 dark:text-emerald-400">ok</span>
                  ) : (
                    <span className="font-medium text-rose-600 dark:text-rose-400">failed</span>
                  )}
                  {step.code ? <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{step.code}</span> : null}
                </div>
                {step.error ? <p className="mt-1 whitespace-pre-wrap text-rose-700 dark:text-rose-300">{step.error}</p> : null}
                {step.input ? (
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                    {step.input}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title="Skills loaded">
        {loads.length ? <Chips items={loads} /> : <p className="text-sm text-muted-foreground">None.</p>}
      </Section>
      <Facts
        facts={[
          ['Message', evidence.messageId],
          ['At', evidence.at],
          ['Nudge kind', evidence.nudge_kind],
          ['Capture', evidence.capture_id],
          ['Nudge at', evidence.nudge_at],
          ['Meeting goal', evidence.meeting_goal_id],
          ['Nudge reason', isNudgeReason(evidence.nudge_reason) ? NUDGE_REASON_LABELS[evidence.nudge_reason] : undefined],
        ]}
      />
    </>
  )
}

function LoopRun({ evidence }: { evidence: LoopRunEvidence }) {
  const flowErrors = Array.isArray(evidence.flowErrors) ? evidence.flowErrors : []
  return (
    <>
      <Section title="Job">
        <Facts
          facts={[
            ['Kind', evidence.jobKind],
            ['Title', evidence.title],
            ['Skill', evidence.skill],
            ['At', evidence.at],
          ]}
        />
      </Section>
      {evidence.error ? (
        <Section title="Error">
          <TextBlock tone="error">{evidence.error}</TextBlock>
        </Section>
      ) : null}
      {flowErrors.length ? (
        <Section title="Flow errors">
          <ul className="space-y-1.5">
            {flowErrors.map((f, i) => (
              <li key={i} className="rounded-md border border-rose-500/30 bg-rose-500/5 px-2.5 py-1.5 text-xs">
                <span className="font-mono font-medium">{f.action}</span>
                <p className="mt-0.5 whitespace-pre-wrap text-rose-700 dark:text-rose-300">{f.error}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {evidence.logTail ? (
        <Section title="Log tail">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2.5 font-mono text-[11px]">
            {evidence.logTail}
          </pre>
        </Section>
      ) : null}
      <Facts
        facts={[
          ['Flow', evidence.flowId],
          ['Flow run', evidence.flowRunId],
          ['Agent run', evidence.agentRunId],
          ['Capture', evidence.captureId],
        ]}
      />
    </>
  )
}

function DraftRewrite({ evidence }: { evidence: DraftRewriteEvidence }) {
  const pct = typeof evidence.similarity === 'number' ? `${Math.round(evidence.similarity * 100)}%` : '—'
  return (
    <>
      <Section title="Rewrite">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Words kept" value={pct} />
          <Stat label="Draft words" value={evidence.wordsBefore ?? '—'} />
          <Stat label="Sent words" value={evidence.wordsAfter ?? '—'} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          No text is kept: Dial8 stores no mail. Read the thread live from its pointers.
        </p>
      </Section>
      <Facts
        facts={[
          ['Origin', evidence.origin],
          ['Thread', evidence.providerThreadId],
          ['Account', evidence.accountId],
          ['Contact', evidence.contactId],
          ['At', evidence.at],
        ]}
      />
    </>
  )
}

/** A dismissal reason as the reviewer reads it. */
const DISMISS_REASON_LABEL: Record<DraftDismissedEvidence['reason'], string> = {
  no_reply_needed: 'No reply needed',
  outdated: 'Outdated',
  duplicate: 'Duplicate',
  bad_draft: 'Bad draft',
  other: 'Other',
}

function DraftDismissed({ evidence }: { evidence: DraftDismissedEvidence }) {
  return (
    <>
      <Section title="Dismissed">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Reason" value={DISMISS_REASON_LABEL[evidence.reason] ?? evidence.reason ?? '—'} />
          <Stat label="By" value={evidence.by === 'person' ? 'The person' : 'The agent'} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          No text is kept: Dial8 stores no mail. Read the thread live from its pointers.
        </p>
      </Section>
      <Facts
        facts={[
          ['Origin', evidence.origin],
          ['Recipient domain', evidence.recipientDomain],
          ['Thread', evidence.providerThreadId],
          ['Account', evidence.accountId],
          ['At', evidence.at],
        ]}
      />
    </>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function TextBlock({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return (
    <p
      className={cn(
        'whitespace-pre-wrap break-words rounded-md border px-3 py-2 text-sm',
        tone === 'error' ? 'border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300' : 'bg-muted/40',
      )}
    >
      {children}
    </p>
  )
}

export function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <span key={`${item}-${i}`} className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">
          {item}
        </span>
      ))}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

export function Facts({ facts }: { facts: Array<[string, string | number | null | undefined]> }) {
  const shown = facts.filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!shown.length) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-all font-mono">{String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}
