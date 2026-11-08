'use client'

/**
 * Settings → Preferences → Assistant: the person's own agent, on every
 * platform. Its name (./assistant-name-section.tsx) and the model it runs on
 * (./agent-model-section.tsx), one card.
 */
import { AgentModelSection } from './agent-model-section'
import { AssistantNameSection } from './assistant-name-section'

export function AssistantSection() {
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium text-muted-foreground">Assistant</h3>
      <div className="rounded-xl border border-border bg-card">
        <AssistantNameSection />
        <div className="mx-5 border-t border-dashed border-border" />
        <AgentModelSection />
      </div>
    </div>
  )
}
