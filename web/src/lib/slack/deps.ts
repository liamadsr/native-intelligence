/**
 * The real outside calls behind ./inbound.ts and ./turn.ts: the stored bot
 * tokens (./bot-token.ts) and the Slack Web API. Tests pass fakes instead.
 * A team's installation is addressed by its Slack team id.
 */
import 'server-only'
import { getServiceClient } from '@/lib/admin'
import { deleteSlackBotToken, forgetSlackBotToken, slackBotToken, verifySlackInstallation } from './bot-token'
import type { SlackInboundDeps } from './inbound'
import type { SlackTurnSlack } from './turn'
import {
  DEAD_TOKEN_ERRORS,
  postSlackMessage,
  slackApi,
  type SlackApiResult,
  type SlackAuthTest,
  type SlackTeamInfo,
  type SlackUserInfo,
} from './web-api'

export function slackInboundDeps(extra: Partial<SlackInboundDeps> = {}): SlackInboundDeps {
  return {
    verifyInstallation: (teamId) => verifySlackInstallation(teamId),
    botToken: (teamId) => slackBotToken(teamId),
    dropToken: (teamId, opts) => deleteSlackBotToken(getServiceClient(), teamId, opts),
    slack: {
      authTest: (token) => slackApi<SlackAuthTest>('auth.test', token, {}),
      teamInfo: (token) => slackApi<SlackTeamInfo>('team.info', token, {}),
      userInfo: (token, user) => slackApi<SlackUserInfo>('users.info', token, { user }),
      post: (token, message) => postSlackMessage(token, message),
      ephemeral: (token, message) => slackApi<object>('chat.postEphemeral', token, message, { json: true }),
    },
    ...extra,
  }
}

/** A call made with a team's token; a token Slack calls dead is dropped from the cache, so the next call reads the row again. */
async function withTeamToken<T extends object>(teamId: string, call: (token: string) => Promise<SlackApiResult<T>>): Promise<SlackApiResult<T>> {
  let token: string
  try {
    token = await slackBotToken(teamId)
  } catch {
    return { ok: false, error: 'no_token' }
  }
  const result = await call(token)
  if (!result.ok && DEAD_TOKEN_ERRORS.has(result.error)) forgetSlackBotToken(teamId)
  return result
}

/**
 * The person's DM with the bot in a team (conversations.open with their
 * linked Slack user): where a turn's reply goes (./turn.ts replyOrigin).
 * Null when it can't be opened. Never throws.
 */
export async function openSlackDm(teamId: string, slackUserId: string): Promise<string | null> {
  const opened = await withTeamToken<{ channel?: { id?: string } }>(teamId, (token) => slackApi('conversations.open', token, { users: slackUserId }))
  return opened.ok && typeof opened.channel?.id === 'string' ? opened.channel.id : null
}

/**
 * The Slack calls a turn makes in one team (./turn.ts). The bot token is read
 * per call (cached briefly in process); no token is
 * `{ ok: false, error: 'no_token' }`, never a throw.
 */
export function slackTurnSlack(teamId: string): SlackTurnSlack {
  return {
    post: (message) => withTeamToken(teamId, (token) => postSlackMessage(token, message)),
    ephemeral: (message) => withTeamToken(teamId, (token) => slackApi<object>('chat.postEphemeral', token, message, { json: true })),
    react: (channel, ts, name) => withTeamToken(teamId, (token) => slackApi<object>('reactions.add', token, { channel, timestamp: ts, name })),
    unreact: (channel, ts, name) => withTeamToken(teamId, (token) => slackApi<object>('reactions.remove', token, { channel, timestamp: ts, name })),
  }
}
