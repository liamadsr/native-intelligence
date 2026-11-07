'use client'

/**
 * Done lately, on a bot's page (docs/plans/bots-v4.md, "A bot's page"): the
 * runs it started in the last 14 days that have settled, newest first. The 14
 * days are by when a run started (`created_at`, useBotWork), so a run that
 * started earlier and settled inside them isn't here. Each says how it ended
 * (reviewed, dismissed, expired unreviewed; failed; "paused: AI usage limit";
 * skipped or canceled), "Attempted" for an unattended attempt, and the records
 * it touched; what it handed on folds under the run it was part of ("2
 * handoffs"). A handoff names the bot that did it and opens on that bot's
 * page; a run of its own opens on this page (Phase 2).
 */
import type { EntityChip } from '@/lib/work/touch-summary'
import { relativeTime, settledAt } from '@/lib/work/presentation'
import type { WorkTree } from '@/lib/work/tree'
import { TreeRows, WorkRow, runningStamp, sectionTone } from '@/components/work/work-rows'
import { BotPageCard, BotPageEmpty } from './bot-page-card'
import type { BotPageOpen } from './use-bot-page-open'

export function DoneLately({
  name,
  trees,
  chips,
  open,
}: {
  name: string
  trees: readonly WorkTree[]
  chips: Record<string, EntityChip[]>
  open: BotPageOpen
}) {
  return (
    <BotPageCard section="done-lately" title="Done lately" hint="Started in the last 14 days, newest first" bounded>
      {trees.length === 0 ? (
        <BotPageEmpty>Nothing {name} started in the last 14 days has finished.</BotPageEmpty>
      ) : (
        <ul data-bot-page-done-lately="" className="space-y-1.5">
          {trees.map((tree) => (
            <TreeRows
              key={tree.item.id}
              tree={tree}
              collapsible
              row={(it, nest) => {
                const page = open.pageOf(it)
                return (
                  <WorkRow
                    key={it.id}
                    item={it}
                    tone={sectionTone(it)}
                    stamp={nest.depth === 0 ? relativeTime(settledAt(it)) : runningStamp(it)}
                    workspaceName={null}
                    onOpen={() => open.row(it)}
                    openTitle={page ? `Open on ${page}’s page` : undefined}
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
