/**
 * The website flow's outcomes as HTTP answers for the app's routes
 * (src/app/api/account/website/*). An outcome's own words are written for the
 * agent ("tell them…"), so the person reads these instead: plain words, the
 * outcome's code, and the status that fits.
 */
import { apiError } from '@/lib/api-errors'

const OUTCOMES: Record<string, { status: number; words: string }> = {
  NO_GITHUB: { status: 409, words: 'Connect GitHub first.' },
  NOT_ALLOWED: { status: 403, words: 'Only an owner or admin of the workspace connects its website.' },
  NOT_SITE_OWNER: { status: 403, words: 'Someone else connected this business’s website. Only they, or an owner or admin, can change which repository it is.' },
  NOT_CONNECTOR: { status: 403, words: 'Only the person who connected the website, with their GitHub, can change it.' },
  REPO_NOT_FOUND: { status: 404, words: 'Your GitHub account can’t see that repository.' },
  GITHUB_UNAVAILABLE: { status: 502, words: 'GitHub didn’t answer just now. Try again in a moment.' },
  NO_PUSH: { status: 403, words: 'Your GitHub account can read that repository but can’t change it. Whoever owns it has to give you write access.' },
  ARCHIVED: { status: 409, words: 'That repository is archived on GitHub, so it can’t take changes.' },
  INSPECT_FAILED: { status: 502, words: 'Couldn’t read that repository just now. Try again in a moment.' },
  SETUP_FAILED: { status: 500, words: 'Couldn’t get things ready for its changes just now. Try again in a moment.' },
  NO_SITE: { status: 409, words: 'Pick your website’s repository first.' },
  NO_SITE_URL: { status: 409, words: 'Add the address customers visit first: the form is checked on the live site.' },
  NO_FORM: { status: 409, words: 'No form customers fill in was found on the site.' },
  ALREADY_WIRED: { status: 409, words: 'That form already sends requests to Native Intelligence.' },
  OPEN_CHANGE: { status: 409, words: 'A change to your website is already in progress. It needs to finish (or get your no) first.' },
  START_FAILED: { status: 502, words: 'Couldn’t start that just now. Nothing on your site changed; try again in a moment.' },
  AGENT_PAUSED: { status: 409, words: 'Your agent is paused. Turn it back on, then try again.' },
  NO_TEAM: { status: 409, words: 'Your workspace needs a team before your agent can work on the website.' },
  NO_STATE: { status: 409, words: 'Your workspace’s board needs a column for work before your agent can work on the website.' },
}

/** A coding run that couldn't start for a reason in the workspace's setup (its project, repo or cloud environment). */
const SETUP_CODES = new Set(['ENVIRONMENT_NOT_ALLOWED', 'ONLY_ME_ENVIRONMENT', 'RUN_ENVIRONMENT_UNUSABLE', 'ENVIRONMENT_UNUSABLE', 'NEEDS_ENVIRONMENT', 'NO_CODING_AGENT', 'NOT_FOUND', 'NO_REPO', 'BAD_REPO', 'NOT_A_PROJECT_REPO', 'SEVERAL_PROJECTS', 'NOT_STARTED', 'REFUSED'])

export function outcomeError(out: { code?: unknown }): Response {
  const code = typeof out.code === 'string' ? out.code : 'FAILED'
  const known = OUTCOMES[code] ?? (SETUP_CODES.has(code) ? OUTCOMES.SETUP_FAILED : undefined)
  return apiError(known?.words ?? 'That didn’t work. Try again in a moment.', { status: known?.status ?? 409, code })
}
