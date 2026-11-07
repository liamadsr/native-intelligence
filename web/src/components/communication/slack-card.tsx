'use client'

/**
 * The agent panel's Slack tab: the Phone tab's card (reach-card.tsx), for
 * Slack (Liam, 2026-10-24: "make sure the slack page looks good too"). The
 * connector's own state and actions (useSlackConnector) are its settings
 * page's, so a change in either shows in the other.
 *
 *   not linked   "Message {name} in Slack", Get my code →, and how to add
 *                Dial8 to Slack if it isn't there
 *   the code     the code to send Dial8 in Slack, to copy; Open Dial8 in
 *                Slack; works once, for 15 minutes · New code
 *   linked       "Message {name} in Slack", who you are there; Open Dial8
 *                in Slack; each Slack workspace at the foot, with Unlink (and
 *                Disconnect, for whoever manages this workspace)
 *
 * No "DM me when it needs my OK" switch here: the agent reaches you when it
 * needs you (Liam: "not something we ask permission for").
 */
import { ArrowRight, ArrowUpRight, Check, Copy, Loader2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useSlackConnector } from '@/app/account/settings/connectors/slack-connector-view'
import { cn } from '@/lib/utils'
import { REACH_LINK, REACH_PILL, REACH_PRIMARY, ReachCard, ReachFoot, ReachHeading, ReachLead } from './reach-card'

export function SlackCard({ name }: { name: string }) {
  const { state, loading, installing, linkCode, codeTeam, makingCode, busyTeam, confirmTeam, setConfirmTeam, copied, error, fetchState, installations, makeCode, install, unlink, disconnect, copyCode, connected, slackHref } =
    useSlackConnector()
  const mine = installations.filter((team) => team.myLink)
  const unlinked = installations.filter((team) => !team.myLink)
  const teamName = (team: { teamName: string; teamDomain: string; teamId: string }) => team.teamName || team.teamDomain || team.teamId

  const openInSlack = slackHref && (
    <a href={slackHref} target="_blank" rel="noreferrer" className={REACH_PRIMARY} data-slack-open="">
      Open Dial8 in Slack
      <ArrowUpRight aria-hidden className="size-4" />
    </a>
  )

  return (
    <ReachCard data-slack-card="">
      {loading ? (
        <Loader2 aria-label="Loading" className="mx-auto my-16 size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
      ) : !state ? (
        <>
          <ReachHeading>Slack</ReachHeading>
          <ReachLead>
            Couldn&apos;t load Slack.{' '}
            <button type="button" onClick={() => void fetchState()} className={REACH_LINK}>
              Try again
            </button>
          </ReachLead>
        </>
      ) : !state.configured ? (
        <>
          <ReachHeading>Message {name} in Slack</ReachHeading>
          <ReachLead>Slack isn&apos;t set up on this Dial8 yet.</ReachLead>
        </>
      ) : linkCode ? (
        <section data-slack-step="code">
          <ReachHeading>Send this code to Dial8</ReachHeading>
          <ReachLead>In Slack, open Dial8 and send it this code as a message.</ReachLead>
          <button type="button" onClick={() => void copyCode()} aria-label={copied ? 'Copied' : 'Copy code'} className={cn(REACH_PILL, 'mt-6 h-14 font-mono text-xl tracking-[0.3em]')} data-slack-code="">
            {linkCode.code}
            {copied ? <Check aria-hidden className="size-4 text-emerald-500" /> : <Copy aria-hidden className="size-4 text-muted-foreground" />}
          </button>
          {openInSlack && <div className="mt-3">{openInSlack}</div>}
          <p className="mt-4 text-xs text-muted-foreground">
            Works once, for 15 minutes ·{' '}
            <button type="button" onClick={() => void makeCode(codeTeam)} disabled={makingCode} className={REACH_LINK}>
              New code
            </button>
          </p>
        </section>
      ) : mine.length > 0 ? (
        <section data-slack-step="linked">
          <ReachHeading>Message {name} in Slack</ReachHeading>
          <ReachLead>
            You&apos;re <span className="font-medium text-foreground">@{mine[0].myLink!.slackUserName || 'linked'}</span> in {teamName(mine[0])}. DM Dial8, or
            @mention it in a thread.
          </ReachLead>
          {openInSlack && <div className="mt-6">{openInSlack}</div>}
          <ReachFoot>
            {installations.map((team) => (
              <p key={team.teamId} data-slack-team={team.teamId}>
                <span className="text-foreground">{teamName(team)}</span>
                <span aria-hidden className="mx-2">·</span>
                {team.myLink ? (
                  <button type="button" onClick={() => void unlink(team.teamId)} disabled={busyTeam === team.teamId} aria-label={`Unlink me from ${teamName(team)}`} className={REACH_LINK}>
                    Unlink
                  </button>
                ) : (
                  state.canLink && (
                    <button type="button" onClick={() => void makeCode(team.teamId)} disabled={makingCode} aria-label={`Link my account in ${teamName(team)}`} className={REACH_LINK}>
                      Link my account
                    </button>
                  )
                )}
                {state.canInstall && (
                  <>
                    <span aria-hidden className="mx-2">·</span>
                    <button
                      type="button"
                      onClick={() => setConfirmTeam({ teamId: team.teamId, teamName: teamName(team) })}
                      disabled={busyTeam === team.teamId}
                      aria-label={`Disconnect ${teamName(team)}`}
                      className={cn(REACH_LINK, 'hover:text-destructive')}
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </p>
            ))}
          </ReachFoot>
        </section>
      ) : (
        <section data-slack-step="setup">
          <ReachHeading>Message {name} in Slack</ReachHeading>
          {connected || state.canInstall ? (
            <>
              <ReachLead>
                {connected && unlinked[0] ? <>Link your account in {teamName(unlinked[0])}&apos;s Slack with a one-time code.</> : 'Link your Slack account with a one-time code.'}
              </ReachLead>
              <button
                type="button"
                onClick={() => void makeCode(connected ? unlinked[0]?.teamId ?? null : null)}
                disabled={makingCode || (connected && !state.canLink)}
                className={cn(REACH_PRIMARY, 'mt-6')}
                data-slack-get-code=""
              >
                {makingCode ? (
                  <Loader2 aria-label="Making a code" className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <>
                    Get my code
                    <ArrowRight aria-hidden className="size-4" />
                  </>
                )}
              </button>
              {!connected && (
                <p className="mt-4 text-balance text-xs text-muted-foreground">
                  Dial8 not in your Slack yet?{' '}
                  {state.selfInstallOpen ? (
                    <button type="button" onClick={() => void install()} disabled={installing} className={REACH_LINK}>
                      Add it to Slack
                    </button>
                  ) : (
                    <>
                      Email{' '}
                      <a href="mailto:liam@dial8.ai" className={REACH_LINK}>
                        liam@dial8.ai
                      </a>{' '}
                      and we&apos;ll add it.
                    </>
                  )}
                </p>
              )}
            </>
          ) : (
            <ReachLead>Someone who manages this Dial8 workspace sets up Slack first. Then you can link your account here.</ReachLead>
          )}
        </section>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}

      {confirmTeam && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmTeam(null)}
          title={`Disconnect ${confirmTeam.teamName}?`}
          description="Dial8 stops answering in that Slack workspace, for everyone. Adding it again brings back everyone's links."
          confirmLabel="Disconnect"
          busy={busyTeam === confirmTeam.teamId}
          onConfirm={() => void disconnect(confirmTeam.teamId)}
        />
      )}
    </ReachCard>
  )
}
