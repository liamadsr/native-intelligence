/**
 * The few Slack Web API methods Native Intelligence calls, with a team's stored bot
 * token (./bot-token.ts). Plain fetch, no SDK: each method is one POST.
 *
 * Rate limits (docs/plans/slack-connect.md §3): apps outside the Slack
 * Marketplace get very low limits on conversations.history and
 * conversations.replies, so nothing here reads channel history. A turn works
 * from the event payload alone.
 */
import 'server-only'

const SLACK_API = 'https://slack.com/api'
const TIMEOUT_MS = 8_000

export type SlackApiResult<T> = ({ ok: true } & T) | { ok: false; error: string }

/** Slack errors that mean the token is dead (revoked, uninstalled, rotated away). */
export const DEAD_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'app_uninstalled',
])

/**
 * One Web API call. Form-encoded by default (Slack's read methods, like
 * users.info, don't take JSON); `json` for the write methods that carry
 * structures (chat.postMessage's blocks). Never throws: a network failure is
 * `{ ok: false, error: 'request_failed' }`.
 */
export async function slackApi<T extends object = Record<string, never>>(
  method: string,
  token: string,
  body: Record<string, unknown>,
  deps: { fetch?: typeof fetch; json?: boolean } = {},
): Promise<SlackApiResult<T>> {
  try {
    const res = await (deps.fetch ?? fetch)(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': deps.json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
      },
      body: deps.json ? JSON.stringify(body) : formBody(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 429) return { ok: false, error: 'ratelimited' }
    const data = (await res.json().catch(() => null)) as ({ ok?: unknown; error?: unknown } & T) | null
    if (!data || typeof data !== 'object') return { ok: false, error: `http_${res.status}` }
    if (data.ok !== true) return { ok: false, error: typeof data.error === 'string' ? data.error : 'unknown_error' }
    return data as { ok: true } & T
  } catch {
    return { ok: false, error: 'request_failed' }
  }
}

function formBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return params.toString()
}

/** auth.test: who the token is (the bot's own user id, its team). */
export interface SlackAuthTest {
  user_id?: string
  team_id?: string
  team?: string
  url?: string
  enterprise_id?: string
}

/** team.info's team. */
export interface SlackTeamInfo {
  team?: { id?: string; name?: string; domain?: string; enterprise_id?: string }
}

/** users.info's user (only what Native Intelligence reads). */
export interface SlackUserInfo {
  user?: {
    id?: string
    team_id?: string
    name?: string
    real_name?: string
    deleted?: boolean
    is_bot?: boolean
    is_stranger?: boolean
    is_admin?: boolean
    is_owner?: boolean
    is_primary_owner?: boolean
    profile?: { display_name?: string; real_name?: string }
    /** Enterprise Grid: the workspaces of the organization this user belongs to. */
    enterprise_user?: { id?: string; enterprise_id?: string; teams?: string[] }
  }
}

/**
 * Whether Slack names this user a member of `teamId`: their home team, or, in
 * an Enterprise Grid organization, one of the workspaces in
 * `enterprise_user.teams` (a Grid admin's home team can be another workspace).
 * No team named at all counts as the team asked about (users.info was called
 * with that team's own token). A stranger, a bot or a deactivated account never
 * counts.
 */
export function isSlackTeamMember(user: SlackUserInfo['user'] | undefined, teamId: string): boolean {
  if (!user || user.is_stranger || user.is_bot || user.deleted) return false
  if (!user.team_id || user.team_id === teamId) return true
  const teams = user.enterprise_user?.teams
  return Array.isArray(teams) && teams.includes(teamId)
}

/** A Slack user's name to show (display name, else real name, else handle). */
export function slackUserName(user: SlackUserInfo['user'] | undefined): string {
  if (!user) return ''
  return (user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || '').trim().slice(0, 200)
}

/**
 * Post a message as the bot. `thread_ts` replies in a thread. Plain `text` is
 * Slack mrkdwn; `blocks` (when given) render instead and `text` is the
 * notification fallback.
 */
export function postSlackMessage(
  token: string,
  message: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] },
  deps: { fetch?: typeof fetch } = {},
): Promise<SlackApiResult<{ ts?: string; channel?: string }>> {
  return slackApi('chat.postMessage', token, { unfurl_links: false, unfurl_media: false, ...message }, { ...deps, json: true })
}
