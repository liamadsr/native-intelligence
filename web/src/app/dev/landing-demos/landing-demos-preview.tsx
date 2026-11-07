'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense, type ReactNode } from 'react'
import { ActionStreamDemo } from '@/components/landing/action-stream-demo'
import { CaptureDemo } from '@/components/landing/capture-demo'
import { ChatDemo } from '@/components/landing/chat-demo'
import { ContextPackageDemo } from '@/components/landing/context-package-demo'
import { CrmAutologDemo } from '@/components/landing/crm-autolog-demo'
import { ExecutionDemo } from '@/components/landing/execution-demo'
import { HudTipsDemo } from '@/components/landing/hud-tips-demo'
import { IntegrationsDemo } from '@/components/landing/integrations-demo'
import { IntelligenceLoopDemo } from '@/components/landing/intelligence-loop-demo'
import { LiveAgentDemo } from '@/components/landing/live-agent-demo'
import { NotesDocDemo } from '@/components/landing/notes-doc-demo'
import { SpeakerIdDemo } from '@/components/landing/speaker-id-demo'
import { MarketingSky } from '@/components/sky/marketing-sky'

const DEMOS: { id: string; node: ReactNode }[] = [
  { id: 'hud-tips', node: <HudTipsDemo /> },
  { id: 'intelligence-loop', node: <IntelligenceLoopDemo /> },
  { id: 'context-package', node: <ContextPackageDemo /> },
  { id: 'chat', node: <ChatDemo /> },
  { id: 'chat-sales', node: <ChatDemo exchanges={[{ ask: 'What did we promise Acme on pricing in last week’s call?', answer: 'On Thursday’s call with Dana Whitfield you offered:\n\n- **12% off list** on a two-year term, signed by Nov 15\n- **Free onboarding** for the first 40 seats\n- A **pilot kickoff** within two weeks\n\nThe SOC 2 report you promised hasn’t gone out yet.' }]} /> },
  { id: 'live-agent', node: <LiveAgentDemo /> },
  { id: 'live-agent-sales', node: <LiveAgentDemo scenario={{ agentName: 'Sales Agent', title: 'Acme Corp · Discovery call', conversation: [], speakerPills: [], toolCalls: [{ label: 'Playbook', detail: 'Price objection → lead with ROI, not discount' }, { label: 'Nudge', detail: 'Ask which tools they’re comparing' }, { label: 'Search docs', detail: 'query: "SOC 2 report"' }, { label: 'Get account', detail: 'Acme Corp — 40 seats, Evaluation' }, { label: 'Propose change', detail: 'Next step: schedule pilot kickoff' }], notes: ['Price is the deciding factor; comparing us with BridgeCRM.', 'Legal needs SOC 2 before signing. We’re Type II.', 'A 40-seat team, live in two weeks with onboarding.'], proposals: [{ title: 'Send Dana the SOC 2 Type II report', kind: 'action', afterCall: 2 }, { title: 'Lead with ROI on price; no discount before the pilot', kind: 'decision', afterCall: 3 }, { title: 'Schedule the pilot kickoff with Acme', kind: 'action', afterCall: 4 }] }} /> },
  { id: 'crm-autolog', node: <CrmAutologDemo /> },
  { id: 'capture', node: <CaptureDemo /> },
  { id: 'capture-actions', node: <CaptureDemo variant="actions" /> },
  { id: 'notes-doc', node: <NotesDocDemo /> },
  { id: 'speaker-id', node: <SpeakerIdDemo /> },
  { id: 'action-stream', node: <ActionStreamDemo /> },
  { id: 'execution', node: <ExecutionDemo /> },
  { id: 'integrations', node: <IntegrationsDemo /> },
]

function Demos() {
  const only = useSearchParams().get('only')
  return (
    <>
    <MarketingSky />
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10">
      {DEMOS.filter((d) => !only || d.id === only).map((d) => (
        <section key={d.id} id={d.id} className="rounded-3xl border border-border bg-secondary/50 p-6 sm:p-10">
          <p className="mb-4 font-mono text-xs text-muted-foreground">{d.id}</p>
          <div className="grid items-center gap-8 lg:grid-cols-2">
            <div className="min-w-0">{d.node}</div>
            <div />
          </div>
        </section>
      ))}
    </main>
    </>
  )
}

export default function LandingDemosPreview() {
  return (
    <Suspense>
      <Demos />
    </Suspense>
  )
}
