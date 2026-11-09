/**
 * What Native Intelligence does with a verified Slack event (docs/plans/slack-connect.md §2,
 * §4 pieces 2 and 4). The events route verifies the forwarded request,
 * dedupes it and acks Slack, then hands the parsed event here (after the
 * response).
 *
 * Who is speaking is decided here, at intake, from what Slack verified (the
 * team, the user id) and what Native Intelligence holds (the installation row, the
 * person's link), never from the message's words:
 *
 *   - a link code in a DM: links that Slack user to the code's Native Intelligence user,
 *     and binds an unbound Slack team to the code's workspace when the code
 *     is a Native Intelligence admin's AND the sender is an admin or owner of the Slack
 *     workspace (./link-code.ts). Wrong codes are capped per Slack user and
 *     team (store.ts linkAttemptsBlocked), so a code can't be guessed;
 *   - a DM from a linked person in the team: the person (caller.ts
 *     channelCaller: 'person'), handed to `onPersonDm` (piece b runs it as
 *     a turn in their home thread);
 *   - a linked person's @mention in a channel thread: the person too, handed
 *     to `onPersonMention` (piece d: their OWN conversation for that thread,
 *     answered in the thread). A teammate who mentions it in the same
 *     thread gets their own: nobody drives someone else's agent;
 *   - an unlinked member's DM, when it is a guest's (guest access: someone
 *     the owner added with Slack among their channels, or their invite
 *     code): handed to `onUnlinkedDm` (src/lib/guests/slack.ts), which runs
 *     it as their own agent's turn or binds them, and answers them itself;
 *   - anyone else (unlinked, or a Slack Connect outsider): one reply saying
 *     how to link (in a channel, one only they see), and no tools. A link
 *     code is only ever read from a DM, never from a channel.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appOrigin, SLACK_SETTINGS_PATH } from './config'
import type { SlackInbound } from './events'
import { linkCodeInMessage } from './link-code'
import {
  INSTALLING_ROLES,
  LINKING_ROLES,
  bindInstallation,
  getInstallation,
  linkAttemptsBlocked,
  linkForSlackUser,
  linkSlackUser,
  markInstallationRevoked,
  memberRole,
  recordFailedLinkAttempt,
  redeemLinkCode,
  type SlackInstallation,
  type SlackUserLink,
} from './store'
import { slackUserName, type SlackApiResult, type SlackAuthTest, type SlackTeamInfo, type SlackUserInfo } from './web-api'

type Svc = SupabaseClient
type Dm = Extract<SlackInbound, { kind: 'dm' }>
type Mention = Extract<SlackInbound, { kind: 'mention' }>

/** The outside calls the handler makes; the route passes the real ones, tests fakes. */
export interface SlackInboundDeps {
  /** Connect: check a team's installation (token + its id), null when Connect has none. */
  verifyInstallation: (teamId: string) => Promise<{ token: string; installationId: string } | null>
  /** Connect: the bot token for an installation id. */
  botToken: (installationId: string) => Promise<string>
  /** Connect: the installation id a team is addressed by before it is bound. */
  installationIdForTeam: (teamId: string) => string
  slack: {
    authTest: (token: string) => Promise<SlackApiResult<SlackAuthTest>>
    teamInfo: (token: string) => Promise<SlackApiResult<SlackTeamInfo>>
    userInfo: (token: string, slackUserId: string) => Promise<SlackApiResult<SlackUserInfo>>
    post: (token: string, message: { channel: string; text: string; thread_ts?: string }) => Promise<SlackApiResult<{ ts?: string }>>
    /** A message only `user` sees (chat.postEphemeral): a channel's notices. */
    ephemeral: (token: string, message: { channel: string; user: string; text: string; thread_ts?: string }) => Promise<SlackApiResult<object>>
  }
  /** A linked person's DM (piece b). Absent: nothing more happens. */
  onPersonDm?: (input: { dm: Dm; installation: SlackInstallation; link: SlackUserLink; token: string }) => Promise<void>
  /**
   * An unlinked member's DM in a live team (a guest's, src/lib/guests/slack.ts):
   * true when it was a guest's and was answered, false to fall through to the
   * "link your account" reply. Absent: every unlinked DM gets that reply.
   */
  onUnlinkedDm?: (input: { dm: Dm; installation: SlackInstallation; token: string }) => Promise<boolean>
  /** A linked person's @mention in a channel thread (piece d). Absent: nothing more happens. */
  onPersonMention?: (input: { mention: Mention; installation: SlackInstallation; link: SlackUserLink }) => Promise<void>
  now?: () => number
}

/** What happened, for the route's one log line (never the message's words). */
export type SlackInboundOutcome =
  | 'linked'
  | 'bound_and_linked'
  | 'code_rejected'
  | 'unknown_sender'
  | 'outsider'
  | 'unbound_team'
  | 'revoked_team'
  | 'person_dm'
  | 'guest_dm'
  | 'person_mention'
  | 'shared_channel'
  | 'uninstalled'
  | 'ignored'
  | 'failed'

const settingsLink = () => `${appOrigin()}${SLACK_SETTINGS_PATH}`

export const SLACK_REPLIES = {
  unknownSender: () =>
    `I don't know who you are in Native Intelligence yet. Open Native Intelligence, go to Settings > Connectors > Slack, press "Link my account" and send me the code it shows: ${settingsLink()}`,
  outsider: () => "I only answer people in this Slack workspace who've linked their Native Intelligence account.",
  sharedChannel: () => "I don't answer in channels shared with another company: your Native Intelligence agent would be answering where they read it. Message me directly instead.",
  unboundTeam: () =>
    `This Slack workspace isn't connected to Native Intelligence yet. A Native Intelligence admin connects it: open Settings > Connectors > Slack in Native Intelligence and send me the code shown there. ${settingsLink()}`,
  codeRejected: () => `That code didn't work: it's used, expired or mistyped. Make a new one in Native Intelligence: ${settingsLink()}`,
  tooManyCodes: () => 'Too many wrong codes. Try again in an hour.',
  needsSlackAdmin: () =>
    "Only an admin or owner of this Slack workspace can connect it to Native Intelligence. Ask one of them to send me their code from Native Intelligence's Settings > Connectors > Slack.",
  notMember: () => "That code's Native Intelligence account can't link Slack in its workspace. Ask an admin of the workspace.",
  needsAdmin: () => "This Slack workspace isn't connected to Native Intelligence yet, and only a Native Intelligence workspace admin can connect it. Ask an admin to send me their code first.",
  otherWorkspace: () => 'This Slack workspace is already connected to a different Native Intelligence workspace, so I can\'t link that code here.',
  notInstalled: () => `I can't reach this Slack workspace through the Native Intelligence app. Add the app again from Native Intelligence: ${settingsLink()}`,
  failed: () => 'Something went wrong on my side. Try again in a minute.',
  linked: () => 'Done: this Slack account is linked to your Native Intelligence account. Message me here any time.',
  boundAndLinked: (team: string) =>
    `Done: ${team ? `${team} is` : 'this Slack workspace is'} connected to your Native Intelligence workspace, and this Slack account is linked to yours. Teammates can link theirs from Settings > Connectors > Slack in Native Intelligence.`,
} as const

/** Handle one verified, first-delivery event. Never throws. */
export async function handleSlackInbound(svc: Svc, inbound: SlackInbound, deps: SlackInboundDeps): Promise<SlackInboundOutcome> {
  try {
    switch (inbound.kind) {
      case 'dm':
        return await handleDm(svc, inbound, deps)
      case 'mention':
        return await handleMention(svc, inbound, deps)
      case 'uninstalled':
        await markInstallationRevoked(svc, inbound.teamId)
        return 'uninstalled'
      default:
        // Challenges are answered by the route.
        return 'ignored'
    }
  } catch (error) {
    console.error('[slack/inbound] failed', { kind: inbound.kind, error: error instanceof Error ? error.message : String(error) })
    return 'failed'
  }
}

async function handleDm(svc: Svc, dm: Dm, deps: SlackInboundDeps): Promise<SlackInboundOutcome> {
  const installation = await getInstallation(svc, dm.teamId)
  const live = installation?.status === 'active' ? installation : null
  // The bot's own messages never reach here as a person's (bot_id), but a
  // bot user id that matches the sender is skipped too.
  if (live?.bot_user_id && live.bot_user_id === dm.slackUserId) return 'ignored'

  const reply = async (text: string, token?: string | null) => {
    const t = token ?? (await tokenFor(dm.teamId, live, deps))
    if (!t) return
    const sent = await deps.slack.post(t, { channel: dm.channel, text })
    if (!sent.ok) console.warn('[slack/inbound] reply failed', { teamId: dm.teamId, error: sent.error })
  }

  // A Slack Connect outsider (another team's user in a shared DM) never links and never speaks as anyone.
  if (dm.userTeamId !== dm.teamId) {
    await reply(SLACK_REPLIES.outsider())
    return 'outsider'
  }

  const code = linkCodeInMessage(dm.text)
  if (code) return redeemCode(svc, dm, code, installation, deps, reply)

  if (!live) {
    await reply(SLACK_REPLIES.unboundTeam())
    return installation ? 'revoked_team' : 'unbound_team'
  }
  const link = await linkForSlackUser(svc, dm.teamId, dm.slackUserId)
  if (!link) {
    // A guest's DM (or their invite code) is answered by the guests' own intake.
    if (deps.onUnlinkedDm) {
      const token = await tokenFor(dm.teamId, live, deps)
      if (token && (await deps.onUnlinkedDm({ dm, installation: live, token }))) return 'guest_dm'
    }
    await reply(SLACK_REPLIES.unknownSender())
    return 'unknown_sender'
  }
  if (!deps.onPersonDm) return 'person_dm'
  const token = await tokenFor(dm.teamId, live, deps)
  if (!token) return 'failed'
  await deps.onPersonDm({ dm, installation: live, link, token })
  return 'person_dm'
}

/**
 * An @mention in a channel thread. Never a link code (a channel is public):
 * only a linked person in a live team is handed on; everyone else gets one
 * ephemeral line, so the channel isn't spammed with notices.
 */
async function handleMention(svc: Svc, mention: Mention, deps: SlackInboundDeps): Promise<SlackInboundOutcome> {
  const installation = await getInstallation(svc, mention.teamId)
  const live = installation?.status === 'active' ? installation : null
  if (live?.bot_user_id && live.bot_user_id === mention.slackUserId) return 'ignored'

  const whisper = async (text: string) => {
    const token = await tokenFor(mention.teamId, live, deps)
    if (!token) return
    const sent = await deps.slack.ephemeral(token, { channel: mention.channel, user: mention.slackUserId, text, thread_ts: mention.threadTs })
    if (!sent.ok) console.warn('[slack/inbound] notice failed', { teamId: mention.teamId, error: sent.error })
  }

  if (mention.userTeamId !== mention.teamId) {
    await whisper(SLACK_REPLIES.outsider())
    return 'outsider'
  }
  // A Slack Connect channel: another company reads the thread. The person's
  // own agent never answers there (their private details could be in it).
  if (mention.sharedExternally) {
    await whisper(SLACK_REPLIES.sharedChannel())
    return 'shared_channel'
  }
  if (!live) {
    await whisper(SLACK_REPLIES.unboundTeam())
    return installation ? 'revoked_team' : 'unbound_team'
  }
  const link = await linkForSlackUser(svc, mention.teamId, mention.slackUserId)
  if (!link) {
    await whisper(SLACK_REPLIES.unknownSender())
    return 'unknown_sender'
  }
  if (deps.onPersonMention) await deps.onPersonMention({ mention, installation: live, link })
  return 'person_mention'
}

/** The bot token to answer a team with: its row's installation, else the id it would have. Null when Connect has none. */
async function tokenFor(teamId: string, live: SlackInstallation | null, deps: SlackInboundDeps): Promise<string | null> {
  try {
    return await deps.botToken(live?.connect_installation_id ?? deps.installationIdForTeam(teamId))
  } catch (error) {
    console.warn('[slack/inbound] no bot token', { teamId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

async function redeemCode(
  svc: Svc,
  dm: Dm,
  code: string,
  installation: SlackInstallation | null,
  deps: SlackInboundDeps,
  reply: (text: string, token?: string | null) => Promise<void>,
): Promise<SlackInboundOutcome> {
  // Past the guess cap, the code isn't even tried (nor spent).
  if (await linkAttemptsBlocked(svc, dm.teamId, dm.slackUserId, deps.now?.())) {
    await reply(SLACK_REPLIES.tooManyCodes())
    return 'code_rejected'
  }
  // Spent whatever happens next: a code answers once.
  const owner = await redeemLinkCode(svc, code, deps.now?.())
  if (!owner) {
    await recordFailedLinkAttempt(svc, dm.teamId, dm.slackUserId).catch(() => {})
    await reply(SLACK_REPLIES.codeRejected())
    return 'code_rejected'
  }
  const role = await memberRole(svc, owner.workspaceId, owner.userId)
  if (!role || !LINKING_ROLES.has(role)) {
    await reply(SLACK_REPLIES.notMember())
    return 'code_rejected'
  }

  // The token to read the sender with (and, for a new team, the proof that
  // Connect holds an installation for exactly this team).
  let token: string | null
  let verifiedInstallationId: string | null = null
  const live = installation?.status === 'active' ? installation : null
  if (live) {
    if (live.workspace_id !== owner.workspaceId) {
      await reply(SLACK_REPLIES.otherWorkspace())
      return 'code_rejected'
    }
    token = await tokenFor(dm.teamId, live, deps)
  } else {
    // The team is new (or was disconnected): only an admin's code binds it.
    if (!INSTALLING_ROLES.has(role)) {
      await reply(SLACK_REPLIES.needsAdmin())
      return 'code_rejected'
    }
    const verified = await deps.verifyInstallation(dm.teamId)
    if (!verified) {
      await reply(SLACK_REPLIES.notInstalled())
      return 'code_rejected'
    }
    token = verified.token
    verifiedInstallationId = verified.installationId
  }
  if (!token) return 'failed'

  // The sender, as Slack knows them: a stranger (Slack Connect), another
  // team's user, a bot or a deactivated account never links (nor binds).
  const user = await deps.slack.userInfo(token, dm.slackUserId)
  if (!user.ok) {
    await reply(SLACK_REPLIES.failed(), token)
    return 'failed'
  }
  if (user.user?.is_stranger || (user.user?.team_id && user.user.team_id !== dm.teamId) || user.user?.is_bot || user.user?.deleted) {
    await reply(SLACK_REPLIES.outsider(), token)
    return 'outsider'
  }

  let teamName = live?.team_name ?? ''
  if (!live) {
    // Tying a Slack workspace to a Native Intelligence workspace is an admin act on both
    // sides: a Native Intelligence admin's code, sent by an admin or owner of the Slack
    // workspace. Any member could otherwise bind their company's Slack to a
    // workspace of their own.
    if (!user.user?.is_admin && !user.user?.is_owner && !user.user?.is_primary_owner) {
      await reply(SLACK_REPLIES.needsSlackAdmin(), token)
      return 'code_rejected'
    }
    const [auth, team] = await Promise.all([deps.slack.authTest(token), deps.slack.teamInfo(token)])
    // The token must be this team's own: never bind a team on another team's word.
    if (!auth.ok || auth.team_id !== dm.teamId) {
      await reply(SLACK_REPLIES.notInstalled(), token)
      return 'failed'
    }
    teamName = (team.ok ? team.team?.name : undefined) ?? auth.team ?? ''
    const bind = await bindInstallation(svc, {
      teamId: dm.teamId,
      teamName,
      teamDomain: (team.ok ? team.team?.domain : undefined) ?? '',
      enterpriseId: validEnterprise((team.ok ? team.team?.enterprise_id : undefined) ?? auth.enterprise_id),
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      installationId: verifiedInstallationId ?? deps.installationIdForTeam(dm.teamId),
      botUserId: typeof auth.user_id === 'string' && /^[UW][A-Z0-9]{2,30}$/.test(auth.user_id) ? auth.user_id : null,
    })
    if (!bind.ok) {
      await reply(bind.reason === 'other_workspace' ? SLACK_REPLIES.otherWorkspace() : SLACK_REPLIES.failed(), token)
      return bind.reason === 'other_workspace' ? 'code_rejected' : 'failed'
    }
  }

  const linked = await linkSlackUser(svc, { teamId: dm.teamId, slackUserId: dm.slackUserId, userId: owner.userId, slackUserName: slackUserName(user.user) })
  if (!linked) {
    await reply(SLACK_REPLIES.failed(), token)
    return 'failed'
  }
  if (!live) {
    await reply(SLACK_REPLIES.boundAndLinked(teamName), token)
    return 'bound_and_linked'
  }
  await reply(SLACK_REPLIES.linked(), token)
  return 'linked'
}

function validEnterprise(value: unknown): string | null {
  return typeof value === 'string' && /^E[A-Z0-9]{2,30}$/.test(value) ? value : null
}
