'use client'

/**
 * One of the app's real screens in a page's column: the app itself in a frame
 * over the picture of that screen (./demo-frame.tsx), with the window's edge
 * the landing pages give it. What each screen is, said for someone who cannot
 * see it, is here, so every page says the same.
 */
import { cn } from '@/lib/utils'
import { DemoFrame } from './demo-frame'
import type { DemoScreen } from './demo-screens'

export type AppScreenName = Extract<DemoScreen, 'chat' | 'list' | 'notes' | 'transcript' | 'contact'>

const LABELS: Record<AppScreenName, string> = {
  chat: 'The chat in the app: asked what was agreed with a customer, the agent lists the decisions and names the call they were made on',
  list: 'The task list in the app: each task with its identifier, labels, project, priority and due date',
  notes: 'A finished meeting’s notes in the app: the overview, the goals and what was discussed',
  transcript: 'A meeting in the app with its transcript open, each line under the name of the person who said it',
  contact: 'A customer’s record in the app: notes, recent activity and what the workspace knows about them',
}

export function AppScreen({ screen, className }: { screen: AppScreenName; className?: string }) {
  return <DemoFrame screen={screen} label={LABELS[screen]} className={cn('rounded-2xl shadow-2xl ring-1 ring-foreground/10', className)} />
}
