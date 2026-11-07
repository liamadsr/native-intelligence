'use client'

/**
 * Landing demo of the live agent working during a call: the capture's card
 * as it sits docked beside the chat while it records (DemoCard), its notes
 * filling in, and the next steps the agent stages appearing inline as the
 * product's own ProposalCard rows (auto-accepted as they land). Out of the
 * Tools pill at its foot rises the Tools card, the product's ToolCallsView
 * (components/capture/live-capture-header.tsx), listing each call the agent
 * makes as it makes it.
 *
 * A scenario is everything conversation-specific: the agent, the call, its
 * tool calls, the notes and the next steps. Pages pass their own (the sales
 * page's works a price objection). Content is FICTIONAL.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Info, MessageSquareText, Package, Wrench } from 'lucide-react'
import { ToolCallsView } from '@/components/capture/live-capture-header'
import { ProposalCard } from '@/components/capture/proposal-card'
import type { AgentActivityEvent } from '@/hooks/use-recording'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { cn } from '@/lib/utils'
import { DemoCard, DemoSky, DemoTabs } from './demo-card'

export interface LiveAgentScenario {
  agentName: string
  /** The capture's title. */
  title?: string
  /** What the two people say (the transcript count grows with it). */
  conversation: { speaker: string; text: string; isLocal: boolean }[]
  /** The agent's calls, in order: a label and what it looked up or did. */
  toolCalls: { label: string; detail: string }[]
  /** Kept for the speakers on the call (the HUD shows Voice ID while it records). */
  speakerPills: { name: string; isLocal: boolean }[]
  /** The notes the agent writes as the call goes. */
  notes?: string[]
  /** The next steps it stages, each after the tool call at `afterCall`. */
  proposals?: { title: string; kind?: 'action' | 'decision'; afterCall: number }[]
}

const PROJECT_MANAGER_SCENARIO: LiveAgentScenario = {
  agentName: 'Project Manager',
  title: 'API redesign check-in',
  conversation: [
    { speaker: 'Sarah', text: 'So where are we on the API redesign?', isLocal: false },
    { speaker: 'You', text: 'We scoped it out last week. I think we can start on it this sprint.', isLocal: true },
    { speaker: 'Sarah', text: 'Great. Let’s move it to active then. Who’s taking point?', isLocal: false },
    { speaker: 'You', text: 'I’ll take it. Marcus can help with the auth endpoints.', isLocal: true },
    { speaker: 'Sarah', text: 'Perfect. Can we get a first draft of the new schema by Thursday?', isLocal: false },
    { speaker: 'You', text: 'Yeah, I’ll create the ticket and get started today.', isLocal: true },
  ],
  toolCalls: [
    { label: 'Search projects', detail: 'query: "API redesign"' },
    { label: 'Get project', detail: 'project: API Redesign (ENG-142)' },
    { label: 'Propose change', detail: 'status: Planned → Active' },
    { label: 'Search contacts', detail: 'query: "Marcus"' },
    { label: 'Propose change', detail: 'Create action: Draft new API schema' },
  ],
  speakerPills: [
    { name: 'alex rivera', isLocal: true },
    { name: 'sarah chen', isLocal: false },
  ],
  notes: [
    'API Redesign starts this sprint; Alex takes point.',
    'Marcus helps with the auth endpoints.',
    'First draft of the new schema due Thursday.',
  ],
  proposals: [
    { title: 'Move API Redesign from Planned to Active', kind: 'action', afterCall: 2 },
    { title: 'Draft the new API schema by Thursday', kind: 'action', afterCall: 4 },
  ],
}

const STAMP = '2026-10-22T15:00:00.000Z'
const ME = 'member-alex'
const MEMBERS = [{ id: ME, display_name: 'Alex Rivera', avatar_url: null }]
const noopAsync = async () => {}
const STEP_MS = 1500
const START_MS = 1200
const HOLD_MS = 4200

function proposal(i: number, p: { title: string; kind?: 'action' | 'decision' }): ProposedChange {
  return {
    id: `live-${i}`, workspace_id: 'demo', capture_id: 'demo', change_type: 'create', entity_type: p.kind === 'decision' ? 'decision' : 'action',
    entity_id: null, display_text: p.title, title: p.title, description: null, priority: null, due_date: null, status_from: null, status_to: null,
    assignee_name: p.kind === 'decision' ? null : 'Alex Rivera', assignee_member_id: p.kind === 'decision' ? null : ME, assignee_contact_id: null,
    team_id: null, project_id: null, labels: null, email_to_name: null, email_to_address: null, email_subject: null, email_context: null,
    extra: null, anchor_text: null, sort_order: i, confidence: 0.94, trigger_quote: null, reasoning: null, stakes: null, open_questions: null,
    status: 'applied', auto_accepted: true, applied_at: STAMP, applied_by: null, result_entity_id: `live-${i}-made`, error_message: null,
    created_at: STAMP, updated_at: STAMP,
  }
}

export function LiveAgentDemo({ scenario = PROJECT_MANAGER_SCENARIO }: { scenario?: LiveAgentScenario }) {
  const calls = scenario.toolCalls
  // How many tool calls have run (0: the call just started).
  const [step, setStep] = useState(0)
  useEffect(() => {
    const delay = step === 0 ? START_MS : step >= calls.length ? HOLD_MS : STEP_MS
    const t = setTimeout(() => setStep((s) => (s >= calls.length ? 0 : s + 1)), delay)
    return () => clearTimeout(t)
  }, [step, calls.length])

  const events = useMemo<AgentActivityEvent[]>(
    () =>
      calls.slice(0, step).map((c, i) => ({
        id: `call-${i}`,
        toolName: c.label,
        args: { [c.detail.split(':')[0]?.trim() || 'input']: c.detail.includes(':') ? c.detail.slice(c.detail.indexOf(':') + 1).trim() : c.detail },
        state: 'result' as const,
        timestamp: i,
      })),
    [calls, step],
  )
  const notes = scenario.notes ?? []
  const notesShown = Math.min(notes.length, Math.ceil((step / Math.max(1, calls.length)) * notes.length))
  const proposals = (scenario.proposals ?? []).map((p, i) => ({ change: proposal(i, p), shown: step > p.afterCall }))
  const lines = Math.round(((step + 1) / (calls.length + 1)) * scenario.conversation.length) + 12

  return (
    <DemoSky className="p-3 sm:p-4">
      <div className="[zoom:0.76]">
        <DemoCard title={scenario.title ?? 'Live capture'} className="h-[690px]">
          <DemoTabs active="Overview" tabs={[{ label: 'Overview' }, { label: 'Agents' }]} />
          <div className="relative min-h-0 flex-1 overflow-hidden px-8">
            <h1 className="pt-4 pb-1 text-2xl font-semibold leading-snug">{scenario.title ?? 'Live capture'}</h1>
            <div className="prose prose-sm max-w-full dark:prose-invert prose-headings:font-semibold prose-h2:mb-2 prose-h2:mt-5 prose-p:my-2 prose-ul:my-2">
              <h2>Notes</h2>
              <ul className="min-h-[4.5rem]">
                {notes.map((n, i) => (
                  <li key={n} className={cn('transition-opacity duration-500', i < notesShown ? 'opacity-100' : 'opacity-0')}>
                    {n}
                  </li>
                ))}
              </ul>
              <h2>Next steps</h2>
              {proposals.map(({ change, shown }) => (
                <div
                  key={change.id}
                  className={cn('not-prose my-1 transition-all duration-500', shown ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0')}
                >
                  <ProposalCard change={change} onApply={noopAsync} onDismiss={noopAsync} onEdit={noopAsync} members={MEMBERS} currentMemberId={ME} projects={[]} />
                </div>
              ))}
            </div>

            {/* The Tools card, risen out of its pill at the card's foot. */}
            <div className="absolute bottom-2 right-3 hidden h-[168px] w-[270px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_10px_40px_-10px_rgb(0_0_0/0.35),0_2px_8px_rgb(0_0_0/0.08)] ring-1 ring-black/5 sm:flex dark:bg-black dark:ring-white/10">
              <ToolCallsView events={events} title="Tools" />
            </div>
          </div>

          {/* The capture's controls while it records: the live agent, its packages, Transcripts and Tools. */}
          <div className="shrink-0 border-t border-border/50 px-3 pb-2 pt-1.5">
            <div className="flex items-center gap-1.5">
              <span className="flex h-9 min-w-0 items-center gap-1.5 text-sm">
                <span className="truncate">{scenario.agentName}</span>
                <span className="shrink-0 text-muted-foreground">agent</span>
                <ChevronDown className="h-4 w-4 opacity-50" />
              </span>
              <span className="flex h-7 w-5 items-center justify-center text-muted-foreground">
                <Info className="h-3.5 w-3.5" />
              </span>
              <span className="hidden h-7 items-center gap-1 rounded-full border border-border px-2 text-[11px] text-muted-foreground sm:inline-flex">
                <Package className="h-3 w-3" />2 packages
              </span>
              <span className="ml-auto flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px] text-sidebar-foreground/70">
                <MessageSquareText className="h-3.5 w-3.5" />
                Transcripts
                <span className="tabular-nums opacity-60">{lines}</span>
              </span>
              <span className="flex h-9 items-center gap-1.5 rounded-full bg-muted px-3 text-[12px] text-sidebar-foreground">
                <Wrench className="h-3.5 w-3.5" />
                Tools
                <span className="tabular-nums opacity-60">{events.length}</span>
              </span>
            </div>
          </div>
        </DemoCard>
      </div>
    </DemoSky>
  )
}
