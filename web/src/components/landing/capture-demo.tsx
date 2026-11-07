'use client'

/**
 * Landing demo of a capture's notes as they open in the chat: the capture's
 * card (DemoCard: its window, its Overview / Agents tabs), its title, the
 * notes in the editor's prose, and the proposals the meeting agent staged,
 * inline where they came up. Each proposal is the product's own ProposalCard
 * (components/capture/proposal-card.tsx) on a fixture row; the card's foot is
 * the capture's agent and its Transcripts pill.
 *
 * Variants, one per pitch:
 *   - `discussion` (default): key discussion points, each with the action it
 *     produced, accepted one after the other;
 *   - `actions`: the meeting's action items, accepted down the list;
 *   - `notes`: a finished set of notes with decisions the live agent
 *     auto-accepted (the meeting-notes page's "Meticulous, organized notes").
 * Content is FICTIONAL.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Info, MessageSquareText } from 'lucide-react'
import { ProposalCard } from '@/components/capture/proposal-card'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { cn } from '@/lib/utils'
import { DemoCard, DemoSky, DemoTabs } from './demo-card'

export type CaptureDemoVariant = 'discussion' | 'actions' | 'notes'

const STAMP = '2026-10-22T15:00:00.000Z'
const ME = 'member-alex'
const MEMBERS = [
  { id: ME, display_name: 'Alex Rivera', avatar_url: null },
  { id: 'member-marcus', display_name: 'Marcus Tran', avatar_url: null },
  { id: 'member-priya', display_name: 'Priya Mehta', avatar_url: null },
]
const PROJECTS = [
  { id: 'project-api', name: 'API Redesign' },
  { id: 'project-auth', name: 'Auth Migration' },
]

function change(id: string, over: Partial<ProposedChange>): ProposedChange {
  return {
    id, workspace_id: 'demo', capture_id: 'demo', change_type: 'create', entity_type: 'action', entity_id: null,
    display_text: over.title ?? '', title: null, description: null, priority: null, due_date: null, status_from: null, status_to: null,
    assignee_name: null, assignee_member_id: null, assignee_contact_id: null, team_id: null, project_id: null, labels: null,
    email_to_name: null, email_to_address: null, email_subject: null, email_context: null, extra: null, anchor_text: null, sort_order: 0,
    confidence: 0.92, trigger_quote: null, reasoning: null, stakes: null, open_questions: null, status: 'pending',
    applied_at: null, applied_by: null, result_entity_id: null, error_message: null, created_at: STAMP, updated_at: STAMP,
    ...over,
  }
}

const ACTION_SCHEMA = change('a-schema', { title: 'Draft the v2 API schema and share it for review', assignee_name: 'Alex Rivera', assignee_member_id: ME, project_id: 'project-api', priority: 'high', due_date: '2026-10-28' })
const ACTION_JWT = change('a-jwt', { title: 'Compare JWT libraries for the auth migration', assignee_name: 'Marcus Tran', assignee_member_id: 'member-marcus', project_id: 'project-auth', priority: 'medium', due_date: '2026-10-30' })
const ACTION_LIMITS = change('a-limits', { title: 'Set per-customer rate limits before the beta', assignee_name: 'Priya Mehta', assignee_member_id: 'member-priya', project_id: 'project-api', priority: 'high', due_date: '2026-10-29' })
const ACTION_RECAP = change('a-recap', { change_type: 'send_email', entity_type: 'external', title: 'Email the APIM team our open questions', email_to_name: 'APIM team' })

const DECISION_WAVEFORM = change('d-wave', { entity_type: 'decision', title: 'Replace the pulsing red dot with a quiet waveform pill', status: 'applied', auto_accepted: true, result_entity_id: 'decision-1' })
const DECISION_LAYOUT = change('d-layout', { entity_type: 'decision', title: 'Ship the single-column layout first; side-by-side waits', status: 'applied', auto_accepted: true, result_entity_id: 'decision-2' })

const TITLES: Record<CaptureDemoVariant, string> = {
  discussion: 'API Planning Standup',
  actions: 'API Planning Standup',
  notes: 'Meeting App Design Sync',
}

/** The script: which proposals the variant shows, accepted in order on a loop. */
const ACCEPTS: Record<CaptureDemoVariant, string[]> = {
  discussion: [ACTION_SCHEMA.id, ACTION_LIMITS.id, ACTION_JWT.id],
  actions: [ACTION_SCHEMA.id, ACTION_JWT.id, ACTION_LIMITS.id],
  notes: [],
}

const noopAsync = async () => {}

function useAcceptLoop(order: string[]): Set<string> {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (order.length === 0) return
    const delay = count === 0 ? 2400 : count >= order.length ? 4200 : 1600
    const t = setTimeout(() => setCount((c) => (c >= order.length ? 0 : c + 1)), delay)
    return () => clearTimeout(t)
  }, [count, order.length])
  return useMemo(() => new Set(order.slice(0, count)), [order, count])
}

export function CaptureDemo({ variant = 'discussion' }: { variant?: CaptureDemoVariant }) {
  const accepted = useAcceptLoop(ACCEPTS[variant])
  const card = (c: ProposedChange) => {
    const shown = accepted.has(c.id) ? { ...c, status: 'applied' as const, result_entity_id: `${c.id}-made`, applied_at: STAMP } : c
    return (
      <div key={c.id} className="not-prose my-1">
        <ProposalCard
          change={shown}
          onApply={noopAsync}
          onDismiss={noopAsync}
          onEdit={noopAsync}
          members={MEMBERS}
          projects={PROJECTS}
          currentMemberId={ME}
        />
      </div>
    )
  }

  return (
    <DemoSky className="p-3 sm:p-4">
      <div className="[zoom:0.8]">
        <DemoCard title={TITLES[variant]} className="h-[620px]">
          <DemoTabs active="Overview" tabs={[{ label: 'Overview' }, { label: 'Agents' }]} />
          <div className="min-h-0 flex-1 overflow-hidden px-8 [mask-image:linear-gradient(to_bottom,#000_calc(100%-40px),transparent)]">
            <h1 className="pt-4 pb-1 text-2xl font-semibold leading-snug">{TITLES[variant]}</h1>
            <div className="prose prose-sm max-w-full dark:prose-invert prose-headings:font-semibold prose-h2:mb-2 prose-h2:mt-5 prose-h3:mb-1 prose-h3:mt-4 prose-p:my-2 prose-ul:my-2 [overflow-wrap:anywhere]">
              {variant === 'notes' ? (
                <>
                  <h2>Summary</h2>
                  <p>
                    Design review of the capture bar, the notes layout and the first run. The team settled on a calmer recording
                    treatment, and anything without final designs by Friday moves to the next cycle.
                  </p>
                  <h2>Design decisions</h2>
                  <h3>Capture bar</h3>
                  {card(DECISION_WAVEFORM)}
                  <h3>Notes layout</h3>
                  <ul>
                    <li>The summary stays pinned above the transcript.</li>
                    <li>Action items sit inline where they came up, not in a separate tab.</li>
                  </ul>
                  {card(DECISION_LAYOUT)}
                </>
              ) : variant === 'actions' ? (
                <>
                  <h2>Summary</h2>
                  <p>The v2 API goes to beta behind a flag. Auth and rate limits have to land first.</p>
                  <h2>Action items</h2>
                  {[ACTION_SCHEMA, ACTION_JWT, ACTION_LIMITS, ACTION_RECAP].map(card)}
                </>
              ) : (
                <>
                  <h2>Key discussion points</h2>
                  <ul>
                    <li>
                      <strong>API versioning</strong>: URL-based versions (v1, v2), not headers.
                    </li>
                  </ul>
                  {card(ACTION_SCHEMA)}
                  <ul>
                    <li>
                      <strong>Rate limiting</strong>: per-customer limits before the beta, on a sliding window.
                    </li>
                  </ul>
                  {card(ACTION_LIMITS)}
                  <ul>
                    <li>
                      <strong>Auth migration</strong>: move to short-lived JWTs before v2 ships.
                    </li>
                  </ul>
                  {card(ACTION_JWT)}
                </>
              )}
            </div>
          </div>
          <CaptureFoot transcripts={variant === 'notes' ? 64 : 41} />
        </DemoCard>
      </div>
    </DemoSky>
  )
}

/** The capture card's foot: its agent on the left, the Transcripts pill on the right (`pinned` while its card is out). */
export function CaptureFoot({ transcripts, pinned = false }: { transcripts: number; pinned?: boolean }): ReactNode {
  return (
    <div className="shrink-0 border-t border-border/50 px-3 pb-2 pt-1.5">
      <div className="flex items-center gap-1.5">
        <span className="flex h-9 min-w-0 items-center gap-1.5 text-sm">
          <span className="truncate">Meeting Notes</span>
          <span className="shrink-0 text-muted-foreground">agent</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </span>
        <span className="flex h-7 w-5 items-center justify-center text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
        </span>
        <span className={cn('ml-auto flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px]', pinned ? 'bg-muted text-sidebar-foreground' : 'text-sidebar-foreground/70')}>
          <MessageSquareText className="h-3.5 w-3.5" />
          Transcripts
          <span className="tabular-nums opacity-60">{transcripts}</span>
        </span>
      </div>
    </div>
  )
}
