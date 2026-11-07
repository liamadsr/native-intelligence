/**
 * The owner's yes (roadmap track E, step 4 "Approve"): every website change
 * goes live only through ONE approval card, raised by the server when its
 * pull request is ready, never by a model.
 *
 *   ready    {@link raiseMergeCard}: the pull request's head (the commit the
 *            owner is shown), its plain summary (the run's "Owner summary:"
 *            line) and preview link go on an approval for tool
 *            `merge_website_change`, external-write. Nobody is in a chat to
 *            see it, so it asks in the owner's home thread (the summary and
 *            preview as the line above the card) and the reach router texts
 *            it when they are away, with its reply code: "yes K7Q4MX"
 *            (src/lib/sms/approvals.ts) or the card's own click.
 *   yes      {@link mergeWebsiteChange} (approvals.ts executeStoredCall): the
 *            change must still wait on that card; GitHub merges the head the
 *            owner saw and nothing newer (a head that moved is refused, and
 *            the new version is shown again). A wiring change's intake key
 *            goes live now, replacing the business's old one. Then the deploy
 *            watch (./deploy.ts) takes it from there.
 *   no       {@link settleWebsiteApproval}: the pull request is closed with a
 *            line why; a lapsed card leaves it open (nothing is live either
 *            way).
 *
 * At accept the approval re-checks the change itself
 * ({@link websiteApprovalPermits}): still waiting on this card, still this
 * workspace's, and the approver is the person who connected the site.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { requestRoute } from '@/lib/reach/route'
import { createToolApproval, type NewApproval, type NewApprovalResult } from '@/lib/safety/approvals'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { inngest } from '@/lib/inngest/client'
import { isAgentPaused } from '@/lib/work/agent-paused'
import { appOrigin } from '@/lib/twilio/config'
import { changeForm, changeLabel, clip, declinedNote, failedText, mergeCardCopy, mergedText, mergeRefusedText, ownerSummaryOf, SUMMARY_TEXT_MAX } from './brief'
import { closePull, getPull, getPullFiles, markPullReady, mergePull, type GithubDeps } from './github'
import { getChange, getSite, updateChange, updateSite } from './store'
import { mergedEventId, prOpenedEventId, WEBSITE_CHANGE_MERGED, WEBSITE_PR_OPENED, type WebsiteEventData } from './events'
import { MERGE_WEBSITE_CHANGE_TOOL, type WebsiteApprovalContext, type WebsiteChange, type WebsiteSite } from './types'

export { changeForm } from './brief'

type Svc = SupabaseClient

export interface ApprovalDeps {
  github?: (token: string) => GithubDeps
  token?: (svc: Svc, userId: string) => Promise<string | null>
  createApproval?: (approval: NewApproval) => Promise<NewApprovalResult>
  notify?: (svc: Svc, args: OwnerNote) => Promise<void>
  send?: (event: { name: string; id?: string; data: WebsiteEventData }) => Promise<unknown>
  /** Swaps the business's live intake key for a wiring change's (default: {@link activateIntakeKey}). */
  activateKey?: (svc: Svc, change: WebsiteChange) => Promise<void>
  /** The kill switch (default src/lib/work/agent-paused.ts isAgentPaused). */
  paused?: (svc: Svc, workspaceId: string) => Promise<boolean>
  now?: () => number
}

const githubOf = (deps: ApprovalDeps, token: string): GithubDeps => deps.github?.(token) ?? { token }
const tokenOf = (deps: ApprovalDeps, svc: Svc, userId: string) => (deps.token ?? storedGithubToken)(svc, userId)
const sendOf = (deps: ApprovalDeps) => deps.send ?? ((e: { name: string; id?: string; data: WebsiteEventData }) => inngest.send(e))

export interface OwnerNote {
  userId: string
  workspaceId: string
  text: string
  /** Makes the home-thread write idempotent: `website-<change>-<what>`. */
  key: string
}

/**
 * Tell the owner something about their website: a line in their home thread,
 * which the reach router texts them when they are away. Best effort; never
 * throws.
 */
export async function notifyOwner(svc: Svc, note: OwnerNote): Promise<void> {
  try {
    const written = await appendHomeMessage(svc, {
      userId: note.userId,
      workspaceId: note.workspaceId,
      messageId: note.key,
      parts: [{ type: 'text', text: note.text }],
      metadata: { kind: 'website' },
    })
    if (written.written && written.conversationId) await requestRoute({ userId: note.userId, workspaceId: note.workspaceId, conversationId: written.conversationId }, note.key)
  } catch (err) {
    console.warn('[website] owner note skipped:', err instanceof Error ? err.message : String(err))
  }
}

const notifyOf = (deps: ApprovalDeps) => deps.notify ?? notifyOwner

// ── Ready: the card ──────────────────────────────────────────────────────────

/** The hosts a change may add without being called out: Dial8's own (the intake) and the site's. Pure. */
function knownHosts(site: Pick<WebsiteSite, 'siteUrl'>): Set<string> {
  const hosts = new Set<string>()
  for (const url of [appOrigin(), site.siteUrl]) {
    try {
      if (url) {
        const host = new URL(url).hostname.toLowerCase()
        hosts.add(host)
        hosts.add(host.replace(/^www\./, ''))
        hosts.add(`www.${host.replace(/^www\./, '')}`)
      }
    } catch {
      // Not a URL.
    }
  }
  return hosts
}

/**
 * The change's pull request is ready (its run finished, or its undo opened):
 * read its head, summary and files, and raise the merge card. A preview is
 * used only when it was made for this very head (`previewHead`), so the owner
 * never previews one version and approves another. Idempotent: a change
 * already waiting on a card keeps it. Never throws.
 */
export async function raiseMergeCard(
  svc: Svc,
  args: { workspaceId: string; changeId: string; previewUrl?: string | null; previewHead?: string | null },
  deps: ApprovalDeps = {},
): Promise<{ ok: boolean; approvalId?: string; error?: string }> {
  try {
    const change = await getChange(svc, args.workspaceId, args.changeId)
    if (!change || change.state !== 'preparing' || !change.prNumber) return { ok: false, error: 'not a change waiting for its card' }
    const site = await getSite(svc, change.workspaceId, change.siteId)
    if (!site) return { ok: false, error: 'site gone' }
    const token = await tokenOf(deps, svc, site.connectedBy)
    if (!token) {
      await failChange(svc, change, site, 'GitHub is no longer connected', deps)
      return { ok: false, error: 'no GitHub token' }
    }
    const gh = githubOf(deps, token)
    const pull = await getPull(gh, site.repoFullName, change.prNumber)
    if (!pull.ok || pull.value.state !== 'open') {
      await failChange(svc, change, site, pull.ok ? 'the pull request was closed' : 'GitHub would not show the change', deps)
      return { ok: false, error: pull.ok ? 'closed' : pull.error }
    }
    const head = pull.value.headSha
    const files = await getPullFiles(gh, site.repoFullName, change.prNumber)
    const known = knownHosts(site)
    const outside = files.ok ? files.value.addedHosts.filter((h) => !known.has(h)).slice(0, 5) : []
    // Fails closed in words: when some of the diff couldn't be read, the card says it wasn't all checked.
    const unchecked = !files.ok || !files.value.complete
    const summary = ownerSummaryOf(pull.value.body) ?? (change.summary ? clip(change.summary, SUMMARY_TEXT_MAX) : null) ?? (pull.value.title ? clip(pull.value.title, 160) : null)
    const previewUrl = args.previewHead === head && args.previewUrl ? args.previewUrl : change.headSha === head ? change.previewUrl : null
    const form = changeForm(change, site)
    const label = changeLabel(change, form)
    // What a text alone could have asked for is quoted back whole (by text it fits: TEXT_EDIT_REQUEST_MAX).
    const asked = change.kind === 'edit' ? clip(change.request, 300) : null
    const replaces = change.kind === 'wire_form' && change.replaceCurrent
    const context: WebsiteApprovalContext = {
      changeId: change.id,
      headSha: head,
      ...(summary ? { summary } : {}),
      previewUrl,
      ...(asked ? { asked } : {}),
      ...(outside.length ? { outside } : {}),
      ...(replaces ? { replaces: true } : {}),
      ...(unchecked ? { unchecked: true } : {}),
    }
    const held = await (deps.createApproval ?? ((a: NewApproval) => createToolApproval(svc, a)))({
      door: 'chat',
      userId: site.connectedBy,
      workspaceId: change.workspaceId,
      toolName: MERGE_WEBSITE_CHANGE_TOOL,
      sideEffect: 'external-write',
      input: {
        change: label,
        ...(asked ? { you_asked: asked } : {}),
        what_changes: summary ?? 'See the pull request.',
        ...(replaces ? { replaces_current: 'Yes: the form stops what it does today (its emails or form service) and sends only to Dial8.' } : {}),
        ...(outside.length ? { adds_outside_addresses: outside.join(', ') } : {}),
        ...(unchecked ? { not_all_checked: 'Some files were too big or too many to check for outside links: look at the pull request before saying yes.' } : {}),
        ...(change.kind === 'wire_form' ? { accepts_requests_from: change.intakeOrigins.length ? change.intakeOrigins.join(', ') : 'any website (the secret link is the gate)' } : {}),
        ...(previewUrl ? { preview: previewUrl } : {}),
        pull_request: pull.value.url,
        files: files.ok ? files.value.files.slice(0, 10).join('\n') + (files.value.files.length > 10 ? `\n…and ${files.value.files.length - 10} more` : '') : `${pull.value.changedFiles} file(s)`,
        yes_does: 'Merges this exact version on GitHub; your host then puts it live.',
      },
      context: { website: context },
      reason: 'website_change',
      card: mergeCardCopy({ label, summary, hasPreview: !!previewUrl, outside, replaces, unchecked }),
    })
    if (!held.ok) {
      await failChange(svc, change, site, held.error, deps)
      return { ok: false, error: held.error }
    }
    const moved = await updateChange(
      svc,
      change.workspaceId,
      change.id,
      { state: 'awaiting_yes', approval_id: held.approvalId, head_sha: head, pr_url: pull.value.url, preview_url: previewUrl, ...(summary ? { summary } : {}) },
      ['preparing'],
    )
    return moved ? { ok: true, approvalId: held.approvalId } : { ok: false, error: 'moved meanwhile' }
  } catch (err) {
    console.error('[website] merge card failed:', err instanceof Error ? err.message : String(err))
    return { ok: false, error: 'card failed' }
  }
}

/** A change that couldn't reach its card (or the live site): failed, and the owner told. Never throws. */
export async function failChange(svc: Svc, change: WebsiteChange, site: Pick<WebsiteSite, 'connectedBy'>, reason: string, deps: Pick<ApprovalDeps, 'notify'> = {}): Promise<void> {
  try {
    const moved = await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: reason }, ['preparing', 'awaiting_yes', 'merging'])
    if (!moved) return
    await notifyOf(deps)(svc, { userId: site.connectedBy, workspaceId: change.workspaceId, text: failedText({ kind: change.kind, reason }), key: `website-${change.id}-failed` })
  } catch (err) {
    console.warn('[website] fail note skipped:', err instanceof Error ? err.message : String(err))
  }
}

// ── The re-check at accept ───────────────────────────────────────────────────

/**
 * The accept-time re-check of a merge card: the change still waits on THIS
 * card (when the row's id is known) and the head it showed, in this
 * workspace, and the approver is the person who connected the site. Throws
 * on a failed read.
 */
export async function websiteApprovalPermits(
  svc: Svc,
  row: { id?: string; workspace_id: string; user_id: string; tool: string; context?: { website?: Partial<WebsiteApprovalContext> } | null },
): Promise<boolean> {
  if (row.tool !== MERGE_WEBSITE_CHANGE_TOOL) return false
  const ctx = row.context?.website
  if (!ctx || typeof ctx.changeId !== 'string' || typeof ctx.headSha !== 'string') return false
  const change = await getChange(svc, row.workspace_id, ctx.changeId)
  if (!change || change.state !== 'awaiting_yes' || change.headSha !== ctx.headSha) return false
  if (row.id && change.approvalId && change.approvalId !== row.id) return false
  const site = await getSite(svc, row.workspace_id, change.siteId)
  return !!site && site.state !== 'disconnected' && site.connectedBy === row.user_id
}

// ── Yes: merge ───────────────────────────────────────────────────────────────

/**
 * The owner said yes: merge exactly the head the card showed (a run's draft
 * marked ready first: the owner's yes is the person), then finish the merge.
 * What the agent reads back is plain words for the owner.
 */
export async function mergeWebsiteChange(svc: Svc, args: { userId: string; workspaceId: string; changeId: string; headSha: string }, deps: ApprovalDeps = {}): Promise<Record<string, unknown>> {
  const change = await getChange(svc, args.workspaceId, args.changeId)
  if (!change || change.state !== 'awaiting_yes' || change.headSha !== args.headSha || !change.prNumber) {
    return { success: false, error: 'That website change is no longer waiting for a yes. Nothing was merged.' }
  }
  const site = await getSite(svc, change.workspaceId, change.siteId)
  if (!site || site.connectedBy !== args.userId) return { success: false, error: 'Only the person who connected the website can put its changes live. Nothing was merged.' }
  // The kill switch: a paused workspace's agent puts nothing live, even on a yes. The card is answered; they ask again once it's back on.
  if (await (deps.paused ?? isAgentPaused)(svc, change.workspaceId)) {
    await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: 'the agent is paused' }, ['awaiting_yes'])
    return { success: false, code: 'AGENT_PAUSED', error: 'Your Dial8 agent is paused, so nothing was merged. Turn it back on, then ask for the change again.' }
  }
  const merging = await updateChange(svc, change.workspaceId, change.id, { state: 'merging' }, ['awaiting_yes'])
  if (!merging) return { success: false, error: 'That website change was already answered. Nothing more was done.' }
  const token = await tokenOf(deps, svc, site.connectedBy)
  if (!token) {
    await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: 'GitHub is no longer connected' }, ['merging'])
    return { success: false, error: 'GitHub is no longer connected, so nothing was merged. Text them a GitHub link to reconnect it.' }
  }
  const gh = githubOf(deps, token)
  const pull = await getPull(gh, site.repoFullName, change.prNumber)
  if (pull.ok && pull.value.draft && !(await markPullReady(gh, pull.value.nodeId))) {
    await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: 'GitHub would not mark the draft ready' }, ['merging'])
    return { success: false, code: 'FAILED', error: mergeRefusedText('FAILED') }
  }
  const merged = await mergePull(gh, site.repoFullName, change.prNumber, args.headSha, changeLabel(change, changeForm(change, site)))
  if (!merged.ok) {
    if (merged.code === 'HEAD_MOVED') {
      // Shown again: back to preparing, and a fresh preview wait and card for the new head.
      await updateChange(svc, change.workspaceId, change.id, { state: 'preparing', approval_id: null }, ['merging'])
      const now = await getPull(gh, site.repoFullName, change.prNumber)
      await sendOf(deps)({ name: WEBSITE_PR_OPENED, id: prOpenedEventId(change.id, now.ok ? now.value.headSha : `moved-${Date.now()}`), data: { workspaceId: change.workspaceId, changeId: change.id } }).catch(() => undefined)
    } else {
      await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: `${merged.code}: ${merged.error}` }, ['merging'])
    }
    return { success: false, code: merged.code, error: mergeRefusedText(merged.code) }
  }
  // A quote form link made since this wiring started is replaced by its key now: said, never silent.
  const newerLink = change.kind === 'wire_form' ? await liveKeyNewerThan(svc, change).catch(() => false) : false
  await finishMerge(svc, change, site, merged.sha, deps)
  return {
    success: true,
    merged: true,
    message: mergedText(),
    ...(newerLink ? { note: 'The quote form link made after this change started has stopped working: the website now uses its own. Tell them in a line.' } : {}),
  }
}

/**
 * A change reached the repo (the owner's yes, or a merge reconcile found):
 * deploying with its merge commit, a wiring's key live (an undone wiring's
 * site back to not wired), and the deploy watch started. Every write is safe
 * to repeat.
 */
export async function finishMerge(svc: Svc, change: WebsiteChange, site: Pick<WebsiteSite, 'id'>, mergeSha: string, deps: ApprovalDeps = {}): Promise<void> {
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString()
  // A merge GitHub took is recorded even if a stale-merge sweep failed the change meanwhile: the site did change.
  const moved = await updateChange(svc, change.workspaceId, change.id, { state: 'deploying', merge_sha: mergeSha, merged_at: change.mergedAt ?? nowIso, error: null }, ['merging', 'failed']).catch((err) => {
    // Another change opened since (the one-open index): this one stays as it is, and is logged.
    console.error(`[website] ws=${change.workspaceId} ALERT merged change ${change.id} not recorded:`, err instanceof Error ? err.message : String(err))
    return null
  })
  if (!moved) {
    const now = await getChange(svc, change.workspaceId, change.id).catch(() => null)
    if (!(now?.state === 'deploying' && now.mergeSha === mergeSha)) return
  }
  if (change.kind === 'wire_form' && change.intakeKeyHash) {
    try {
      await (deps.activateKey ?? activateIntakeKey)(svc, change)
    } catch (err) {
      // The deploy watch tries again on every poll (deploy.ts).
      console.error(`[website] ws=${change.workspaceId} ALERT intake key not activated yet:`, err instanceof Error ? err.message : String(err))
    }
  }
  if (change.kind === 'revert' && change.revertsChangeId) {
    // Undoing the wiring: the site isn't wired any more (its old form setup is back).
    const undone = await getChange(svc, change.workspaceId, change.revertsChangeId).catch(() => null)
    if (undone?.kind === 'wire_form') await updateSite(svc, change.workspaceId, site.id, { state: 'connected', wired_at: null }).catch(() => undefined)
  }
  try {
    await sendOf(deps)({ name: WEBSITE_CHANGE_MERGED, id: mergedEventId(change.id), data: { workspaceId: change.workspaceId, changeId: change.id } })
  } catch (err) {
    console.warn('[website] deploy watch not started:', err instanceof Error ? err.message : String(err))
  }
}

/** Whether the business's live intake key was made after this change started (and isn't the change's own). Throws on a failed read. */
async function liveKeyNewerThan(svc: Svc, change: WebsiteChange): Promise<boolean> {
  const { data, error } = await svc.from('quote_intake_key').select('key_hash, created_at').eq('workspace_id', change.workspaceId).is('revoked_at', null).maybeSingle()
  if (error) throw new Error(`quote_intake_key read failed: ${error.message}`)
  const key = data as { key_hash?: string; created_at?: string } | null
  return !!key?.created_at && key.key_hash !== change.intakeKeyHash && Date.parse(key.created_at) > Date.parse(change.createdAt)
}

/**
 * Whether a merged wiring's key should (still) be made live: its site is
 * still connected, and no later wiring of the site has merged since (whose
 * key is the one that counts now). Throws on a failed read.
 */
export async function keyStillWanted(svc: Svc, change: WebsiteChange): Promise<boolean> {
  if (change.kind !== 'wire_form' || !change.intakeKeyHash) return false
  const site = await getSite(svc, change.workspaceId, change.siteId)
  if (!site || site.state === 'disconnected') return false
  const { data, error } = await svc
    .from('website_change')
    .select('id, merged_at')
    .eq('workspace_id', change.workspaceId)
    .eq('site_id', change.siteId)
    .eq('kind', 'wire_form')
    .not('merged_at', 'is', null)
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  const mine = change.mergedAt ? Date.parse(change.mergedAt) : Infinity
  return !((data ?? []) as Array<{ id: string; merged_at: string | null }>).some((c) => c.id !== change.id && c.merged_at && Date.parse(c.merged_at) > mine)
}

/**
 * A wiring change merged: its key becomes the business's live intake key,
 * for the site's origins, the old one revoked in the same transaction
 * (swap_quote_intake_key, 463; one live key per workspace, 458). Safe to
 * repeat. Throws on a failed call.
 */
export async function activateIntakeKey(svc: Svc, change: WebsiteChange): Promise<void> {
  if (!change.intakeKeyHash || !change.intakeKeyPrefix) return
  const { error } = await svc.rpc('swap_quote_intake_key', {
    p_workspace_id: change.workspaceId,
    p_key_hash: change.intakeKeyHash,
    p_key_prefix: change.intakeKeyPrefix,
    p_allowed_origins: change.intakeOrigins,
    p_created_by: change.requestedBy,
  })
  if (error) throw new Error(`swap_quote_intake_key failed: ${error.message}`)
}

// ── No, or no answer ─────────────────────────────────────────────────────────

/**
 * The owner said no to a merge card, or it lapsed: a no closes the pull
 * request with a line why; a lapse leaves it open. Only the change's own
 * card settles it (a stray second card never declines the real one). Best
 * effort; never throws.
 */
export async function settleWebsiteApproval(
  svc: Svc,
  row: { id?: string; workspace_id: string; context?: { website?: Partial<WebsiteApprovalContext> } | null },
  outcome: 'denied' | 'expired',
  deps: ApprovalDeps = {},
): Promise<void> {
  const changeId = row.context?.website?.changeId
  if (typeof changeId !== 'string') return
  try {
    const change = await getChange(svc, row.workspace_id, changeId)
    if (!change || (row.id && change.approvalId && change.approvalId !== row.id)) return
    const moved = await updateChange(svc, row.workspace_id, changeId, { state: outcome === 'denied' ? 'declined' : 'expired' }, ['awaiting_yes'])
    if (!moved || outcome !== 'denied' || !moved.prNumber) return
    const site = await getSite(svc, moved.workspaceId, moved.siteId)
    const token = site ? await tokenOf(deps, svc, site.connectedBy) : null
    if (site && token) await closePull(githubOf(deps, token), site.repoFullName, moved.prNumber, declinedNote())
  } catch (err) {
    console.warn('[website] settle skipped:', err instanceof Error ? err.message : String(err))
  }
}
