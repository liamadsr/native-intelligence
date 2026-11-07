/**
 * The real outside calls behind ./inbound.ts (Connect for tokens, the Slack
 * Web API for everything else). Tests pass fakes instead.
 */
import 'server-only'
import { installationIdForTeam, slackBotToken, verifySlackInstallation } from './connect'
import type { SlackInboundDeps } from './inbound'
import type { SlackTurnSlack } from './turn'
import { postSlackMessage, slackApi, type SlackApiResult, type SlackAuthTest, type SlackTeamInfo, type SlackUserInfo } from './web-api'

export function slackInboundDeps(extra: Partial<SlackInboundDeps> = {}): SlackInboundDeps {
  return {
    verifyInstallation: verifySlackInstallation,
    botToken: slackBotToken,
    installationIdForTeam,
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

/**
 * The person's DM with the bot in an installation's team (conversations.open
 * with their linked Slack user): where a turn's reply goes (./turn.ts
 * replyOrigin). Null when it can't be opened. Never throws.
 */
export async function openSlackDm(installationId: string, slackUserId: string): Promise<string | null> {
  let token: string
  try {
    token = await slackBotToken(installationId)
  } catch {
    return null
  }
  const opened = await slackApi<{ channel?: { id?: string } }>('conversations.open', token, { users: slackUserId })
  return opened.ok && typeof opened.channel?.id === 'string' ? opened.channel.id : null
}

/**
 * The Slack calls a turn makes for one installation (./turn.ts). The bot
 * token comes from Connect per call (cached in process); no token is
 * `{ ok: false, error: 'no_token' }`, never a throw.
 */
export function slackTurnSlack(installationId: string): SlackTurnSlack {
  const withToken = async <T extends object>(call: (token: string) => Promise<SlackApiResult<T>>): Promise<SlackApiResult<T>> => {
    let token: string
    try {
      token = await slackBotToken(installationId)
    } catch {
      return { ok: false, error: 'no_token' }
    }
    return call(token)
  }
  return {
    post: (message) => withToken((token) => postSlackMessage(token, message)),
    ephemeral: (message) => withToken((token) => slackApi<object>('chat.postEphemeral', token, message, { json: true })),
    react: (channel, ts, name) => withToken((token) => slackApi<object>('reactions.add', token, { channel, timestamp: ts, name })),
    unreact: (channel, ts, name) => withToken((token) => slackApi<object>('reactions.remove', token, { channel, timestamp: ts, name })),
  }
}
