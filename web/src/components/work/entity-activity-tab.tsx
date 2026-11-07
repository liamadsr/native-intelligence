'use client'

/**
 * The entity tab (plan Part 2, rows 10 and 12): every agent interaction with one
 * action, capture, project, contact, document, company, initiative or email
 * thread, as it happens.
 *
 *   - First, the cards waiting on you about this entity (the rail's own cards,
 *     from the attention hook, filtered by what each card is about), each with
 *     its one-tap action.
 *   - Then one row per work item that touched it, newest first: who (the
 *     teammate, or the lane's mark), what it did here ("created 1 · read 3";
 *     a read-only row is muted: "looked at"), when, the item's title and where
 *     it stands. A row opens the work item on its bot's page (else on a
 *     card of its own).
 *   - Work no bot the viewer can reach holds is the workspace's Assistant's
 *     (lib/work/bot-owner.ts), here as on the bots: named for it, and opening
 *     on its page.
 *   - Runs by other members are counted, not shown: the ledger's SELECT is
 *     owner-only (entity-activity.ts).
 *   - A handoff (row 14) keeps its own row, credited to the teammate who did
 *     it, grouped with the rest of its tree under the title of the work it was
 *     part of.
 */
import { useMemo, useState } from 'react'
import { CornerDownRight, Eye, Loader2, PenLine, Users } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useEntityActivity } from '@/hooks/use-entity-activity'
import { useAttentionItems, type AttentionItem } from '@/hooks/use-attention-items'
import { cardEntityRef } from '@/lib/flows/card-entity'
import { cardOwnerKeys, isAttempt, ownerOf, teammateKey } from '@/lib/work/agent-work-lanes'
import { itemLine, isPausedFailure, relativeTime } from '@/lib/work/presentation'
import { isReadOnly, summarizeVerbs, toolLabel } from '@/lib/work/touch-summary'
import { WORK_ROLE_LABELS, isWorkRole } from '@/lib/work/roles'
import { groupEntityActivity, type EntityActivityRow, type EntityActivityType } from '@/lib/work/entity-activity'
import type { WorkItem } from '@/lib/work/types'
import { OwnerMark } from './work-owner-mark'
import { StatusIcon } from './work-item-detail-panel'
import { AttemptedChip } from '@/components/attention/review-card'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'
import { useBotOwners } from './agent-work-provider'
import { assistantIdOf, withBotOwner, withCardOwner, type BotOwners } from '@/lib/work/bot-owner'

let mountSeq = 0

/** A card is about this entity when it names it, or (for a capture) came from it. */
export function cardIsAbout(item: Pick<AttentionItem, 'kind' | 'payload'>, entityType: EntityActivityType, entityId: string): boolean {
  const ref = cardEntityRef(item.kind, (item.payload ?? {}) as Record<string, unknown>)
  const id = entityId.toLowerCase()
  if (ref.entityId === id && (!ref.entityType || ref.entityType === entityType)) return true
  return entityType === 'capture' && ref.captureId === id
}

export function EntityActivityTab({
  entityType,
  entityId,
  onOpenWorkItem,
}: {
  entityType: EntityActivityType
  entityId: string
  onOpenWorkItem: (item: WorkItem) => void
}) {
  const activity = useEntityActivity(entityType, entityId)
  // Each row named with its bot (the owner rule): one no reachable bot holds is its workspace's Assistant's.
  const owners = useBotOwners()
  const ownedRows = useMemo(
    () => activity.rows?.map((r) => {
      const item = withBotOwner(r.work_item, owners)
      return item === r.work_item ? r : { ...r, work_item: item }
    }) ?? null,
    [activity.rows, owners],
  )
  const [channel] = useState(() => `entity-activity-cards-${++mountSeq}`)
  const attention = useAttentionItems({ channel, announce: false })
  const cards = useMemo(
    () => attention.items.filter((c) => c.status === 'pending' && cardIsAbout(c, entityType, entityId)),
    [attention.items, entityType, entityId],
  )

  if (activity.rows === null && !activity.failed) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading agent activity…
      </div>
    )
  }

  const rows = ownedRows ?? []
  const groups = groupEntityActivity(rows)
  const nothing = rows.length === 0 && cards.length === 0 && activity.hidden === 0

  return (
    <section aria-label="Agent activity" className="space-y-4 py-2">
      {activity.failed && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Could not load this item’s agent activity.{' '}
          <button type="button" className="underline" onClick={() => void activity.refresh()}>
            Try again
          </button>
        </p>
      )}

      {cards.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Waiting on you</h3>
          <ul className="space-y-1.5">
            {cards.map((c) => (
              <CardRow key={c.id} card={c} attention={attention} />
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="space-y-1.5" aria-label="Agent interactions">
          {groups.map((g) =>
            g.root ? (
              <li key={`tree:${g.root.id}`} className="space-y-1" aria-label={`Part of ${g.root.title}`}>
                <p className="flex min-w-0 items-center gap-1 px-1 text-[10px] text-muted-foreground">
                  <CornerDownRight className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">
                    Part of <span className="font-medium text-foreground/80">{g.root.title}</span>
                  </span>
                </p>
                <ul className="space-y-1.5 pl-3">
                  {g.rows.map((r) => (
                    <ActivityRow key={r.work_item_id} row={r} onOpen={() => onOpenWorkItem(r.work_item)} />
                  ))}
                </ul>
              </li>
            ) : (
              g.rows.map((r) => <ActivityRow key={r.work_item_id} row={r} onOpen={() => onOpenWorkItem(r.work_item)} />)
            ),
          )}
        </ul>
      )}

      {activity.hidden > 0 && (
        <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground" title="Only the person whose run it was can open it.">
          <Users className="h-3 w-3" />
          {activity.hidden === 1 ? '1 more run' : `${activity.hidden} more runs`} by other members touched this.
        </p>
      )}

      {nothing && !activity.failed && (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">No agent has worked on this yet.</p>
      )}
    </section>
  )
}

function ActivityRow({ row, onOpen }: { row: EntityActivityRow; onOpen: () => void }) {
  const item = row.work_item
  const owner = ownerOf(item)
  const who = owner.type === 'teammate' ? owner.name : owner.label
  const roleLabel = item.teammate && !item.teammate.is_system && isWorkRole(item.teammate.role) ? WORK_ROLE_LABELS[item.teammate.role] : null
  // A role teammate is named for its role (migration 284): say it once.
  const role = roleLabel && roleLabel !== who ? roleLabel : null
  const readOnly = isReadOnly(row.verbs)
  const paused = isPausedFailure(item)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={row.tools.length > 0 ? `Tools: ${row.tools.map(toolLabel).join(', ')}` : undefined}
        className={cn(
          'flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-muted/50',
          readOnly ? 'border-border/40 bg-transparent' : 'border-border/60 bg-card/50',
        )}
      >
        <OwnerMark owner={owner} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="truncate font-medium text-foreground">{who}</span>
            {role && <span className="shrink-0 text-muted-foreground">· {role}</span>}
            <span
              className={cn(
                'flex shrink-0 items-center gap-1',
                readOnly ? 'text-muted-foreground' : 'font-medium text-primary',
              )}
            >
              · {readOnly ? <Eye className="h-3 w-3" /> : <PenLine className="h-3 w-3" />}
              {summarizeVerbs(row.verbs)}
            </span>
            <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground">{relativeTime(row.last_at)}</span>
          </div>
          <p className={cn('mt-0.5 truncate text-xs', readOnly ? 'text-muted-foreground' : 'text-foreground')}>{item.title}</p>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <StatusIcon status={item.status} paused={paused} className="h-3 w-3" />
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {paused ? 'paused: AI usage limit' : itemLine(item)}
            </span>
            {isAttempt(item) && <AttemptedChip className="ml-1" />}
          </div>
        </div>
      </button>
    </li>
  )
}

/**
 * What a card that needs somewhere to go says, by whose it is (the owner rule,
 * lib/work/bot-owner.ts): the Assistant's (no raiser, or one that's gone or
 * out of reach), another bot's, or, in a workspace with no Assistant known
 * and no raiser, nobody's.
 */
export function needsTargetToast(card: Pick<AttentionItem, 'workspace_id' | 'source_flow_run_id' | 'payload'>, owners: BotOwners): string {
  const key = cardOwnerKeys(withCardOwner(card, owners), [])[0]
  const assistant = assistantIdOf(owners, card.workspace_id)
  if (key && assistant && key === teammateKey(assistant)) return 'It’s with the Assistant: pick where this goes in For you or on its page'
  if (key) return 'Pick where this goes in For you or on its agent’s page'
  return 'This card needs somewhere to go before it can be added'
}

function CardRow({ card, attention }: { card: AttentionItem; attention: ReturnType<typeof useAttentionItems> }) {
  const owners = useBotOwners()
  const [busy, setBusy] = useState(false)
  const isWork = card.kind === 'work_proposal'
  const act = async (verb: 'primary' | 'dismiss') => {
    setBusy(true)
    try {
      if (verb === 'dismiss') {
        await attention.dismiss(card.id)
        return
      }
      const res = isWork ? await attention.start(card.id) : await attention.accept(card.id)
      // A card names the bot that raised it (bots v3 1a); one that names none is its workspace's Assistant's (lib/work/bot-owner.ts).
      if (!res.ok && 'needsTarget' in res && res.needsTarget) {
        toast(needsTargetToast(card, owners))
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{card.title}</p>
        {card.why && <p className="mt-0.5 line-clamp-2 text-[11px] text-amber-700/90 dark:text-amber-400/90">{card.why}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('primary')}
          className="rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background disabled:opacity-60"
        >
          {isWork ? 'Start' : 'Accept'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('dismiss')}
          className="rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-60"
        >
          Dismiss
        </button>
      </div>
    </li>
  )
}

/**
 * The tab as the detail panels mount it: a row opens the work item where any
 * item opens (bots-v4.md Phase 2, useOpenWorkItem): on its teammate's bot's
 * page, else on a card of its own, in its own workspace.
 */
export function EntityActivitySection({ entityType, entityId }: { entityType: EntityActivityType; entityId: string }) {
  const openWorkItem = useOpenWorkItem()
  return (
    <EntityActivityTab
      entityType={entityType}
      entityId={entityId}
      onOpenWorkItem={(item) =>
        openWorkItem(item.id, [], { workspaceId: item.workspace_id, title: item.title, teammateId: item.ai_team_member_id ?? null })
      }
    />
  )
}
