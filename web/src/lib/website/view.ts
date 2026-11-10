/**
 * The website flow as the app shows it (roadmap track E): the connected site,
 * what reading its repo found, and the change in flight, in the same plain
 * words the owner reads by text. Pure, and safe for client components: types
 * and words only.
 */
import { inspectionWords } from './brief'
import { platformHostOf } from './inspect'
import { OPEN_CHANGE_STATES, type WebsiteChange, type WebsiteSite } from './types'

export interface WebsiteSiteView {
  repo: string
  siteUrl: string | null
  /** What reading the repo found, as the agent tells the owner. */
  found: string
  /** Its form already sends customers' requests to Native Intelligence. */
  wired: boolean
  /** A form was found that can be connected. */
  hasForm: boolean
  /** The address is the host's own (x.vercel.app): customers may use another. */
  hostAddress: boolean
  /** The person looking connected it: they connect its form and make its changes (the pull requests are theirs on GitHub). */
  connectedByYou: boolean
  /** They may pick another repository or edit the address (they connected it, or they're an owner or admin). */
  canRepoint: boolean
}

export interface WebsiteChangeView {
  kind: WebsiteChange['kind']
  state: WebsiteChange['state']
  open: boolean
  prUrl: string | null
  previewUrl: string | null
  /** Where it stands, in a sentence. */
  status: string
}

export interface WebsiteView {
  githubConnected: boolean
  /** They may connect a website (an owner or admin of the workspace). */
  canConnect: boolean
  site: WebsiteSiteView | null
  change: WebsiteChangeView | null
}

export interface WebsiteRepoView {
  fullName: string
  private: boolean
  /** The repo's GitHub homepage, when it names one. */
  homepage: string | null
  /** Among the likeliest to be the website (the ones texted as a numbered list). */
  likely: boolean
}

const STATUS: Record<WebsiteChange['state'], string> = {
  preparing: 'Making the change. You’ll get a text when it’s ready to look at.',
  awaiting_yes: 'Ready for your yes: approve it from the card in your chat, or reply yes with the code from the text. Nothing is live until then.',
  merging: 'Going live now.',
  deploying: 'Going live now: your host is publishing it.',
  live: 'Live on your site.',
  declined: 'You said no, so nothing changed.',
  expired: 'It waited a day without a yes, so nothing changed.',
  failed: 'It didn’t work, and nothing on your site changed. Your agent told you why in your chat.',
}

export function siteView(site: WebsiteSite, viewer: { userId: string; role: string | null }): WebsiteSiteView {
  const inspection = site.inspection
  return {
    repo: site.repoFullName,
    siteUrl: site.siteUrl,
    // The address has its own row: the words without it.
    found: inspection ? inspectionWords({ ...site, siteUrl: null }, inspection) : '',
    wired: site.state === 'wired',
    hasForm: (inspection?.forms.length ?? 0) > 0 && inspection?.forms[0]?.submits !== 'dial8',
    hostAddress: platformHostOf(site.siteUrl) !== null,
    connectedByYou: site.connectedBy === viewer.userId,
    canRepoint: site.connectedBy === viewer.userId || viewer.role === 'owner' || viewer.role === 'admin',
  }
}

export function changeView(change: WebsiteChange): WebsiteChangeView {
  const open = (OPEN_CHANGE_STATES as readonly string[]).includes(change.state)
  return {
    kind: change.kind,
    state: change.state,
    open,
    prUrl: change.prUrl,
    previewUrl: change.state === 'awaiting_yes' ? change.previewUrl : null,
    // Never the raw error (written for the agent, or a run's own words): the owner is texted what went wrong.
    status: STATUS[change.state],
  }
}

/** The page's view: the site, and the change worth showing (the open one, else one that just didn't work). Pure. */
export function websiteView(args: { githubConnected: boolean; canConnect: boolean; viewer: { userId: string; role: string | null }; site: WebsiteSite | null; open: WebsiteChange | null; last: WebsiteChange | null }): WebsiteView {
  const shown = args.open ?? (args.last && args.last.state === 'failed' ? args.last : null)
  return { githubConnected: args.githubConnected, canConnect: args.canConnect, site: args.site ? siteView(args.site, args.viewer) : null, change: shown ? changeView(shown) : null }
}
