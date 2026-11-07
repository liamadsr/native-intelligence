'use client'

/**
 * About, on a bot's page (docs/plans/bots-v4.md, "A bot's page"): what it is
 * (a system teammate's job, a role, or what a work bot speaks for: "The bot
 * for Weekly brief": teammate-blurb.ts, the roster's words), the custom agent
 * it's built on, the skills it always checks, what it may do on its own (a
 * teammate in a role, or on a custom agent: Settings → Autonomy's words),
 * "Attempts paused" with Resume for owners and admins of its workspace, the AI
 * limit when that's what stopped it, and Customize, which opens the one agent
 * editor on this bot (agent-editor-seam.tsx). Not on the agent's own page
 * (the workspace's Assistant: one face, always-on-agent §2c): its look is the
 * one look everywhere and its name the person's assistant name (Settings →
 * Preferences), so it has nothing of its own to customize.
 */
import { useMemo, useState } from 'react'
import { PauseCircle, PlayCircle, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import { teammateAutonomyLine } from '@/lib/work/autonomy-line'
import { WORK_ROLE_LABELS } from '@/lib/work/roles'
import type { TeammateAbout } from '@/lib/work/teammate-about'
import { teammateBlurb } from '@/lib/work/teammate-blurb'
import { isAgentTeammate } from '@/lib/bots/agent-face'
import { agentEditorTarget, useAgentEditor } from './agent-editor-seam'
import { BotPageCard } from './bot-page-card'

const ROLE_LABELS: Record<string, string> = WORK_ROLE_LABELS

export function About({
  teammate,
  about,
  mayResume,
  onResume,
  aiLimit,
}: {
  /** Its roster entry, with its role's breaker (useBotWork's). */
  teammate: RosterTeammate
  about: TeammateAbout
  /** You're an owner or admin of its workspace. */
  mayResume: boolean
  /** Resume its role's attempts; false when that failed. */
  onResume: (workspaceId: string, role: string) => Promise<boolean>
  /** The AI usage limit stopped its last run lately (bot-page.ts stoppedByAiLimit). */
  aiLimit: boolean
}) {
  const target = useMemo(() => agentEditorTarget(teammate, about), [teammate, about])
  const editor = useAgentEditor(target)
  const [resuming, setResuming] = useState(false)
  const paused = teammate.breaker?.paused ? teammate.breaker.window : null
  const role = teammate.role
  const roleLabel = role ? (ROLE_LABELS[role] ?? role) : null
  // A loop's work bot checks its loops' skills, not its own.
  const showSkills = target.kind !== 'loop'
  // Only a teammate on a team has a mode of its own: a work bot proposes, a system teammate runs its job.
  const showAutonomy = !teammate.fronts_only && !teammate.is_system
  // The agent's face and name are one everywhere (one face): nothing to customize.
  const customizable = !isAgentTeammate(teammate)

  return (
    <BotPageCard section="about" title="About" hint="Who it is, and what it may do">
      {/* The card is its box: no frame of its own, inset to the header's line. */}
      <div data-bot-page-about="" className="space-y-2.5 px-1.5 pb-1">
        <div className="space-y-0.5">
          <p data-bot-page-what="" className="text-xs text-foreground">
            {teammateBlurb(teammate)}
          </p>
          {about.agent && !teammate.fronts_only && (
            <p data-bot-page-agent="" className="text-[11px] text-muted-foreground">
              Built on {about.agent.name}
            </p>
          )}
        </div>
        {(showSkills || showAutonomy) && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
            {showSkills && (
              <>
                <dt className="text-muted-foreground">Skills</dt>
                <dd data-bot-page-skills="" className="min-w-0 text-foreground">
                  {about.skills.length > 0 ? about.skills.map((s) => s.name).join(', ') : 'None yet'}
                </dd>
              </>
            )}
            {showAutonomy && (
              <>
                <dt className="text-muted-foreground">Autonomy</dt>
                <dd data-bot-page-autonomy="" className="min-w-0 text-foreground">
                  {teammateAutonomyLine(teammate)}
                </dd>
              </>
            )}
          </dl>
        )}
        {paused !== null && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              data-bot-page-paused=""
              title={`Its last ${paused} attempts were all dismissed, so it stopped attempting. It tries again after a quiet week.`}
              className="flex h-5 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
            >
              <PauseCircle className="h-3 w-3 shrink-0" />
              Attempts paused
            </span>
            {mayResume && role && (
              <button
                type="button"
                data-bot-page-resume=""
                disabled={resuming}
                onClick={async () => {
                  setResuming(true)
                  try {
                    await onResume(teammate.workspace_id, role)
                  } finally {
                    setResuming(false)
                  }
                }}
                title="Count only this role’s attempts from now on, so it attempts again on its next item"
                className="inline-flex h-6 items-center gap-1 rounded-full border border-amber-500/40 px-2 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 dark:text-amber-400"
              >
                <PlayCircle className="h-3 w-3 shrink-0" />
                {resuming ? 'Resuming…' : `Resume ${roleLabel}`}
              </button>
            )}
          </div>
        )}
        {aiLimit && (
          <p data-bot-page-ai-limit="" className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
            Paused: your plan’s AI limit was reached.
          </p>
        )}
        {customizable && (
          <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" data-bot-page-customize="" onClick={editor.open}>
            <Settings2 className="h-3.5 w-3.5" />
            Customize
          </Button>
        )}
        {customizable && editor.editor}
      </div>
    </BotPageCard>
  )
}
