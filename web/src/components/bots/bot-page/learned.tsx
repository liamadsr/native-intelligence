'use client'

/**
 * What I've learned, on an area face's page (one-agent plan, Part 3: "An
 * area's page also shows its memory"; Phase S3): what Native Intelligence has learned about
 * you in the face's area, yours and the workspace's, with S2's own viewer
 * (WhatNiLearned, `area`): edit, delete, accept or add a line there. One
 * card of the work column (bot-page-card.tsx).
 *
 * The memory read is the workspace on screen's, so a face in another
 * workspace says where its memory is instead, as Conversations does.
 *
 * One face (always-on-agent §2c): the area faces have no pages of their own
 * now, so the agent's page shows the same per area (AgentLearned): one area
 * at a time, picked from a compact row of the areas with background work
 * (Captures, Mail, Prospecting, Evals, CRM).
 */
import { useState } from 'react'
import { WhatNiLearned } from '@/components/memory/what-ni-learned'
import { useWorkspaceId, useWorkspaces } from '@/app/account/workspace-switcher'
import { PACKS, type AreaKey } from '@/lib/packs/registry'
import { AREA_FACE_KEYS } from '@/lib/work/work-area'
import { cn } from '@/lib/utils'
import { BotPageCard, BotPageEmpty } from './bot-page-card'

export function Learned({ area, name, workspaceId }: { area: AreaKey; name: string; workspaceId: string | null }) {
  const currentId = useWorkspaceId()
  const { workspaces } = useWorkspaces()
  const here = !workspaceId || !currentId || workspaceId === currentId
  const areaName = PACKS[area].name
  return (
    <BotPageCard section="learned" title="What I’ve learned" hint={`About you, in ${areaName}`}>
      {here ? (
        <div data-bot-page-learned={area} className="pb-1">
          <WhatNiLearned area={area} />
        </div>
      ) : (
        <BotPageEmpty>
          {name} works in {workspaces.find((w) => w.id === workspaceId)?.name ?? 'its workspace'}. Switch there to see what Native Intelligence has learned about you in {areaName}.
        </BotPageEmpty>
      )}
    </BotPageCard>
  )
}

/**
 * What I've learned, on the agent's page (one face): what Native Intelligence has learned
 * about you in one area at a time, the areas as a compact row of chips (a
 * radio group), the first picked to start. The same viewer as an area page
 * had (WhatNiLearned, `area`).
 */
export function AgentLearned({ name, workspaceId }: { name: string; workspaceId: string | null }) {
  const currentId = useWorkspaceId()
  const { workspaces } = useWorkspaces()
  const [area, setArea] = useState<AreaKey>(AREA_FACE_KEYS[0])
  const here = !workspaceId || !currentId || workspaceId === currentId
  return (
    <BotPageCard section="learned" title="What I’ve learned" hint="About you, area by area">
      {here ? (
        <div data-bot-page-learned={area} className="space-y-2 pb-1">
          <div role="radiogroup" aria-label="Area" data-bot-page-learned-areas="" className="flex flex-wrap gap-1 px-1.5">
            {AREA_FACE_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={area === key}
                data-bot-page-learned-area={key}
                onClick={() => setArea(key)}
                className={cn(
                  'inline-flex h-6 items-center rounded-full border px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  area === key ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {PACKS[key].name}
              </button>
            ))}
          </div>
          <WhatNiLearned key={area} area={area} />
        </div>
      ) : (
        <BotPageEmpty>
          {name} works in {workspaces.find((w) => w.id === workspaceId)?.name ?? 'its workspace'}. Switch there to see what Native Intelligence has learned about you.
        </BotPageEmpty>
      )}
    </BotPageCard>
  )
}
