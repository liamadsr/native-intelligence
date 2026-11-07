'use client'

/**
 * Working on, on a bot's page (docs/plans/bots-v4.md, "A bot's page"): its
 * queued and running work, newest first, each tree whole: what it handed on
 * sits under the run it was part of ("Waiting on Writer" while it waits), and
 * a handoff of its own sits under the other bot's run. Stop where the run can
 * be stopped (agent runs, prospecting runs, eval runs: stopRouteOf), on the
 * run that was started (its handoffs stop with it), as on the Agents page;
 * the shell's Stop sends the row's own workspace (useAgentWork `stop`).
 * A run parked on a question is here too (P13: it asks in the chat, never
 * in For you), marked "Needs your answer"; it opens beside its run's chat.
 */
import type { EntityChip } from '@/lib/work/touch-summary'
import { stopRouteOf } from '@/lib/work/agent-work-lanes'
import type { WorkTree } from '@/lib/work/tree'
import type { WorkItem } from '@/lib/work/types'
import { TreeRows, WorkRow, runningStamp, sectionTone } from '@/components/work/work-rows'
import { BotPageCard, BotPageEmpty } from './bot-page-card'
import type { BotPageOpen } from './use-bot-page-open'

export function WorkingOn({
  name,
  trees,
  chips,
  open,
  onStop,
  stopping,
}: {
  name: string
  trees: readonly WorkTree[]
  chips: Record<string, EntityChip[]>
  open: BotPageOpen
  onStop: (item: WorkItem) => Promise<void> | void
  stopping: ReadonlySet<string>
}) {
  return (
    <BotPageCard section="working-on" title="Working on" hint="Queued, running or asking, newest first" count={trees.length} bounded>
      {trees.length === 0 ? (
        <BotPageEmpty>{name} isn’t working on anything right now.</BotPageEmpty>
      ) : (
        <ul data-bot-page-working-on="" className="space-y-1.5">
          {trees.map((tree) => (
            <TreeRows
              key={tree.item.id}
              tree={tree}
              row={(it, nest) => {
                const page = open.pageOf(it)
                return (
                  <WorkRow
                    key={it.id}
                    item={it}
                    tone={sectionTone(it)}
                    stamp={it.status === 'needs_input' ? 'Needs your answer' : runningStamp(it)}
                    workspaceName={null}
                    onOpen={() => open.row(it)}
                    openTitle={page ? `Open on ${page}’s page` : undefined}
                    onStop={nest.depth === 0 && stopRouteOf(it) ? () => void onStop(it) : undefined}
                    stopping={stopping.has(it.id)}
                    chips={chips[it.id]}
                    onOpenEntity={(c) => open.entity(it, c)}
                    nest={nest}
                  />
                )
              }}
            />
          ))}
        </ul>
      )}
    </BotPageCard>
  )
}
