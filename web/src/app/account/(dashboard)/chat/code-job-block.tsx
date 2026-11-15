'use client'

/**
 * A Code tab job, inline in the chat (lib/local-agent/code-tab.ts
 * codeThreadLayout puts it after the person's message that started it): the
 * job's own view, LocalAgentPanel in its inline form (its header with Stop,
 * the agent's text, tool steps, questions and finish, and the later messages
 * the person sent it). The panel's code loads only when a chat has a job to
 * show, so the main chat carries none of it otherwise.
 */
import { Suspense, lazy, memo } from 'react'
import type { PanelSession } from '@/components/local-agent/session-api'

const LocalAgentPanel = lazy(() => import('@/components/local-agent/local-agent-panel').then((m) => ({ default: m.LocalAgentPanel })))

export const CodeJobBlock = memo(function CodeJobBlock({
  sessionId,
  onSession,
}: {
  sessionId: string
  /** Each new read of the job's session (the composer follows its status). */
  onSession?: (session: PanelSession) => void
}) {
  return (
    <div data-code-job={sessionId} className="my-2 rounded-2xl border border-border/70 bg-card/60 p-3 shadow-sm">
      <Suspense fallback={<p className="text-xs text-muted-foreground">Loading…</p>}>
        <LocalAgentPanel sessionId={sessionId} inline onSession={onSession} />
      </Suspense>
    </div>
  )
})
