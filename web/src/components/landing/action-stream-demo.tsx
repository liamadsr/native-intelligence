'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AttentionCard } from '@/components/attention/attention-card'
import type { AttentionItem } from '@/hooks/use-attention-items'

// ── Types ──

export interface StreamAction {
  id: string
  text: string
  project: string
  assignee: string
  priority: 'High' | 'Medium' | 'Low'
  dueDate: string
  /**
   * Where the task came from, as the card's "from … · …" line reads it:
   * `via` is who staged it, `title` the meeting, thread or channel. Defaults
   * to the meeting agent on the API planning standup.
   */
  source?: { via: string; title: string }
}

// Pool of actions that "stream in" as if captured live from a meeting. Variety
// across assignees, projects, priorities and due dates so the stack feels alive.
const ACTION_POOL: StreamAction[] = [
  { id: 'a1', text: 'Draft the v2 API schema and share with the team for review', project: 'API Redesign', assignee: 'alex r.', priority: 'High', dueDate: 'Apr 18' },
  { id: 'a2', text: 'Research JWT libraries and write up an auth migration comparison', project: 'Auth Migration', assignee: 'marcus t.', priority: 'Medium', dueDate: 'Apr 21' },
  { id: 'a3', text: 'Set per-customer rate limits before the beta launch', project: 'Platform v2', assignee: 'priya m.', priority: 'High', dueDate: 'Apr 19' },
  { id: 'a4', text: 'Write the onboarding flow spec from Monday’s design review', project: 'Onboarding', assignee: 'sarah c.', priority: 'Medium', dueDate: 'Apr 24' },
  { id: 'a5', text: 'Send the recap email to the APIM team with our open questions', project: 'API Redesign', assignee: 'jordan k.', priority: 'Low', dueDate: 'Apr 17' },
  { id: 'a6', text: 'Spin up the staging environment for the migration dry-run', project: 'DevOps', assignee: 'marcus t.', priority: 'Medium', dueDate: 'Apr 22' },
  { id: 'a7', text: 'Create the dashboard redesign brief from Sarah’s call notes', project: 'Platform v2', assignee: 'alex r.', priority: 'Low', dueDate: 'Apr 25' },
]

const MAX_VISIBLE = 4 // how many cards stay stacked before the oldest drops off

// Per-position visual treatment. Index 0 = newest (top of the stack).
//
// The taper is done entirely with `scale` (a GPU transform) — not `width` —
// so cards never reflow/rewrap as they move down a position. That keeps the
// motion buttery smooth: cards just glide and shrink, nothing jitters.
//
// Newest is full-size and fully opaque so the eye locks onto the top. Each card
// below is uniformly smaller and dimmer, forming an inverted triangle. The last
// card is almost invisible — a distant ghost trailing off into the hero.
const STACK_SCALE = [1, 0.94, 0.88, 0.82]
const STACK_OPACITY = [1, 0.85, 0.4, 0.08]

// Each card is absolutely positioned at a fixed vertical slot. A constant step
// per index gives a perfectly even rhythm, and a card moving from slot N→N+1
// simply glides down by one step — no list reflow, no jitter.
const SLOT_STEP = 112 // px between the top of one card slot and the next

// ── A single streamed-in card ──
// The product's own AttentionCard (components/attention/attention-card.tsx):
// the card the agent puts in front of you to accept, as an `action_card` on a
// fixture item. `index` is its position in the visible stack (0 = newest).

const MEMBERS = [
  { id: 'm-alex', display_name: 'Alex Rivera', avatar_url: null },
  { id: 'm-marcus', display_name: 'Marcus Tran', avatar_url: null },
  { id: 'm-priya', display_name: 'Priya Mehta', avatar_url: null },
  { id: 'm-sarah', display_name: 'Sarah Chen', avatar_url: null },
  { id: 'm-jordan', display_name: 'Jordan Kim', avatar_url: null },
]
function projectsOf(pool: readonly StreamAction[]) {
  return [...new Set(pool.map((a) => a.project))].map((name) => ({ id: `p-${name}`, name }))
}
const MEMBER_BY_NAME: Record<string, string> = {
  'alex r.': 'm-alex',
  'marcus t.': 'm-marcus',
  'priya m.': 'm-priya',
  'sarah c.': 'm-sarah',
  'jordan k.': 'm-jordan',
}
const DUE: Record<string, string> = {
  'Apr 17': '2026-04-17', 'Apr 18': '2026-04-18', 'Apr 19': '2026-04-19', 'Apr 21': '2026-04-21',
  'Apr 22': '2026-04-22', 'Apr 24': '2026-04-24', 'Apr 25': '2026-04-25',
}
const STAMP = '2026-04-14T15:00:00.000Z'
const noop = () => {}
const noopAsync = async () => ({ ok: true })

function itemFor(action: StreamAction): AttentionItem {
  return {
    id: action.id,
    workspace_id: 'demo',
    member_id: 'm-alex',
    kind: 'action_card',
    title: action.text,
    why: null,
    payload: {
      change_type: 'create',
      entity_type: 'action',
      title: action.text,
      priority: action.priority.toLowerCase(),
      due_date: DUE[action.dueDate] ?? null,
      project_id: `p-${action.project}`,
      assignee_member_id: MEMBER_BY_NAME[action.assignee] ?? null,
      skill_name: action.source?.via ?? null,
      capture_title: action.source?.title ?? 'API Planning Standup',
    },
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: STAMP,
  }
}

function ActionCard({ action, index, projects }: { action: StreamAction; index: number; projects: { id: string; name: string }[] }) {
  const scale = STACK_SCALE[index] ?? STACK_SCALE[STACK_SCALE.length - 1]
  const opacity = STACK_OPACITY[index] ?? 0
  const y = index * SLOT_STEP
  const item = useMemo(() => itemFor(action), [action])
  return (
    <motion.div
      layout={false}
      initial={{ opacity: 0, y: -24, scale: 1 }}
      animate={{ opacity, y, scale }}
      exit={{ opacity: 0, y: y + 24, scale: scale * 0.96 }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      style={{ zIndex: MAX_VISIBLE - index, transformOrigin: 'top center' }}
      className="absolute inset-x-0 top-0"
    >
      <AttentionCard
        item={item}
        editable={false}
        members={MEMBERS}
        aiMembers={[]}
        projects={projects}
        onEdit={noop}
        onAccept={noopAsync}
        onStart={noopAsync}
        onDismiss={async () => {}}
        surface="chat"
      />
    </motion.div>
  )
}

// ── Main component ──

/**
 * `pool` replaces the default engineering-team actions: the cards that stream
 * in, in order, looping. Projects are read off the pool itself; members are
 * fixed, so a custom pool names the same five assignees (alex r., marcus t., priya
 * m., sarah c., jordan k.) and due dates from Apr 17 to Apr 25.
 */
export function ActionStreamDemo({ pool = ACTION_POOL }: { pool?: readonly StreamAction[] } = {}) {
  // `visible` holds the currently stacked cards, newest first.
  const [visible, setVisible] = useState<StreamAction[]>([])
  const poolIdx = useRef(0)
  const projects = useMemo(() => projectsOf(pool), [pool])

  useEffect(() => {
    let mounted = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const pushNext = () => {
      if (!mounted) return
      const next = pool[poolIdx.current % pool.length]
      poolIdx.current++
      // Prepend the new card; trim the oldest once we exceed the max.
      setVisible((prev) => {
        const withNew = [{ ...next, id: `${next.id}-${poolIdx.current}` }, ...prev]
        return withNew.slice(0, MAX_VISIBLE)
      })
      timer = setTimeout(pushNext, 2600)
    }

    // Seed the first card shortly after mount, then stream the rest in.
    timer = setTimeout(pushNext, 500)

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && mounted && !timer) {
        timer = setTimeout(pushNext, 800)
      } else if (document.visibilityState !== 'visible') {
        if (timer) { clearTimeout(timer); timer = null }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      mounted = false
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [pool])

  return (
    // transform-gpu promotes this to its own compositing layer so the streaming
    // card animations don't invalidate the fixed navbar's backdrop-filter region.
    <div inert aria-hidden className="pointer-events-none mx-auto w-full max-w-xl transform-gpu select-none">
      {/* Fixed-height stage so the hero never reflows as cards stream in. Cards
          are absolutely positioned into fixed slots within this footprint, so a
          new arrival just glides everything down one slot — no list reflow. */}
      <div className="relative h-[460px]">
        <AnimatePresence initial={false}>
          {visible.map((action, i) => (
            <ActionCard key={action.id} action={action} index={i} projects={projects} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
