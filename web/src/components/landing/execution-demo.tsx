'use client'

/**
 * Landing demo of an action an agent takes on: the action's record as it
 * opens in the chat (DemoCard), drawn the way the action's panel draws it
 * (app/account/(dashboard)/views/action-detail-panel.tsx): the Details /
 * Agents tabs, and the Properties rail (status, priority, assignee, due date,
 * project, pull request). On the Agents tab the coding agent works through
 * its plan, the product's PlanChecklist (components/work/plan-checklist.tsx),
 * and reports back in a chat reply (ChatMessageList, as a run's chat draws
 * it); the status walks Todo → In Progress → In Review and the pull request
 * links itself. Content is FICTIONAL.
 */
import { useEffect, useMemo, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { Bot, Calendar, Circle, Flag, FolderOpen, GitPullRequest, User } from 'lucide-react'
import { ChatMessageList } from '@/app/account/(dashboard)/chat/chat-message-list'
import { MessageInteractionsContext, type MessageInteractions } from '@/app/account/(dashboard)/chat/message-interactions'
import { PlanChecklist } from '@/components/work/plan-checklist'
import type { PlanStep } from '@/lib/work/plan'
import { cn } from '@/lib/utils'
import { DemoCard, DemoSky, DemoTabs } from './demo-card'

const PLAN = [
  'Read the action, its meeting and the API Redesign project',
  'Read the v1 routes and schemas',
  'Draft the v2 schema with versioned routes',
  'Add request and response types, and tests',
  'Open a pull request for review',
]

const REPLY =
  'Opened **#482** on acme/api-v2: the v2 schema with URL-based versions, typed requests and responses, and 14 new tests. Marcus is on it for review.'

const STATUSES = [
  { name: 'Todo', color: '#3b82f6' },
  { name: 'In Progress', color: '#f59e0b' },
  { name: 'In Review', color: '#a855f7' },
]

const INTERACTIONS: MessageInteractions = { reply: () => {}, react: () => {}, reactions: null }
const STEP_MS = 1400

export function ExecutionDemo() {
  // 0: just assigned; 1..PLAN.length: that many steps started; past it: done and reported.
  const [step, setStep] = useState(0)
  const last = PLAN.length + 1
  useEffect(() => {
    const delay = step === 0 ? 1600 : step >= last ? 5200 : STEP_MS
    const t = setTimeout(() => setStep((s) => (s >= last ? 0 : s + 1)), delay)
    return () => clearTimeout(t)
  }, [step, last])

  const steps: PlanStep[] = PLAN.map((text, i) => ({
    text,
    status: i < step - 1 || step >= last ? 'done' : i === step - 1 ? 'in_progress' : 'pending',
  }))
  const done = step >= last
  const status = done ? STATUSES[2] : step > 0 ? STATUSES[1] : STATUSES[0]
  const messages = useMemo<UIMessage[]>(
    () => (done ? [{ id: 'run-reply', role: 'assistant', parts: [{ type: 'text', text: REPLY }] } as UIMessage] : []),
    [done],
  )

  return (
    <DemoSky className="p-3 sm:p-4">
      <div className="[zoom:0.8]">
        <DemoCard title="Draft the v2 API schema and share it for review" className="h-[600px]">
          <DemoTabs active="Agents" tabs={[{ label: 'Details' }, { label: 'Agents' }]} />
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 space-y-4 px-6 pb-6 pt-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted">
                  <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
                <span className="font-medium">Coding agent</span>
                <span className="text-muted-foreground">
                  {step === 0 ? 'starting…' : done ? 'finished' : 'working'}
                </span>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/50 p-3">
                <p className="mb-2 text-[11px] font-medium text-muted-foreground">Plan</p>
                <PlanChecklist steps={steps} live={!done} />
              </div>
              <div className={cn('transition-opacity duration-500', done ? 'opacity-100' : 'opacity-0')}>
                <MessageInteractionsContext.Provider value={INTERACTIONS}>
                  <ChatMessageList messages={messages} latestUserMessageId={null} userAvatarUrl={null} userInitials="AR" />
                </MessageInteractionsContext.Provider>
              </div>
            </div>

            <aside className="hidden w-56 shrink-0 border-l border-border/60 p-3 pt-4 sm:block">
              <Row icon={<Circle className="h-4 w-4 shrink-0 transition-colors duration-500" style={{ color: status.color }} fill={status.color} />}>
                {status.name}
              </Row>
              <Row icon={<Flag className="h-4 w-4 shrink-0 text-orange-500" />}>High</Row>
              <Row icon={<User className="h-4 w-4 shrink-0 text-muted-foreground" />}>Alex Rivera</Row>
              <Row icon={<Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />}>Oct 28, 2026</Row>
              <Row icon={<FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />}>API Redesign</Row>
              <Row icon={<GitPullRequest className="h-4 w-4 shrink-0 text-muted-foreground" />} muted={!done}>
                {done ? '#482 · acme/api-v2' : 'Link pull request'}
              </Row>
            </aside>
          </div>
        </DemoCard>
      </div>
    </DemoSky>
  )
}

function Row({ icon, children, muted }: { icon: React.ReactNode; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className={cn('flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm', muted && 'text-muted-foreground')}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}
