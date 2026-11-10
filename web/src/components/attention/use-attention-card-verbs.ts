'use client'

/**
 * An attention card's verbs, shared by the full card (attention-card.tsx) and
 * the For you column's compact card (column-compact-card.tsx), so a click on
 * either does the same thing: Accept with the card's corrections (and the
 * assigned agent's start), Start, Dismiss and Refine, each with
 * its receipt toast and its `attention_card_*` event, and the target picker a
 * target-less update opens. The host's handlers (the shared source's, with
 * their optimistic removal) do the work; this owns only the busy state.
 */
import { POST_SURFACE_NAME, postCardCopy, postDraftFromPayload, postIntentUrl } from '@/lib/content/post-draft'
import { openInSystemBrowser } from '@/lib/open-external'
import { useState } from 'react'
import { toast } from 'sonner'
import { usePostHog } from 'posthog-js/react'
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { openBotPage } from '@/lib/bots/bot-page'
import { isTargetlessUpdate } from '@/lib/proposed-changes/derive-ui'
import type { AttentionItem, AttentionPayload, AcceptCorrections, AcceptResult } from '@/hooks/use-attention-items'
import type { RailAiMember } from '@/hooks/use-rail-picker-data'
import type { WorkRunPlace } from '@/lib/attention/work-place'
import type { CardSurface } from './attention-card'
import { toolDisplayName } from '@/lib/mcp-client/tool-permissions'

/** A held connected-app tool's name as a person reads it: mcp__linear__create_issue → "Create issue". */
function mcpToolLabel(tool: unknown): string {
  if (typeof tool !== 'string' || !tool) return 'This tool'
  return toolDisplayName({ name: tool.split('__').pop() || tool })
}

export interface AttentionCardVerbHandlers {
  item: AttentionItem
  /** The card's workspace's agents: the assigned agent's name in a failed start's toast. */
  aiMembers: RailAiMember[]
  onAccept: (id: string, corrections?: AcceptCorrections, targetEntityId?: string | null) => Promise<AcceptResult>
  onStart: (id: string, runIn?: WorkRunPlace | null) => Promise<AcceptResult>
  onDismiss: (id: string) => Promise<void>
  onRefine?: (item: AttentionItem) => void
  surface?: CardSurface
}

export function useAttentionCardVerbs({ item, aiMembers, onAccept, onStart, onDismiss, onRefine, surface }: AttentionCardVerbHandlers) {
  const [accepting, setAccepting] = useState(false)
  // Which button is busy: Always allow shows its own spinner (Approve shows the shared one).
  const [alwaysAllowing, setAlwaysAllowing] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  // W-4c: target picker for a target-less update. Opened by the primary button
  // (needs-target card) or when accept returns UPDATE_TARGET_UNRESOLVED.
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const posthog = usePostHog()
  // Whatever it opens is the card's workspace's: a card in that workspace.
  const openInCardWorkspace = (target: OpenTarget) => void openTarget(target, { from: 'card', workspaceId: item.workspace_id })
  const p = item.payload || {}
  // Every event says where the card was (bots-v4.md Phase 3).
  const capture = (event: string, props: Record<string, unknown> = {}) =>
    posthog?.capture(event, { kind: item.kind, ...props, ...(surface ? { surface } : {}) })
  // W-4b: a target-less action update can't apply in one click (see AttentionCard).
  const needsTarget = isTargetlessUpdate(p)

  // Build corrections from the (possibly edited) payload so accept applies what
  // the card shows.
  const corrections = (): AcceptCorrections => ({
    project_id: p.project_id ?? null,
    priority: (p.priority as AcceptCorrections['priority']) ?? undefined,
    due_date: p.due_date ?? null,
    assignee_member_id: p.assignee_member_id ?? null,
    assignee_ai_member_id: p.assignee_ai_member_id ?? null,
  })

  // The accept receipt (WS-1c/2a). Fired on a successful accept: a toast naming
  // the created identifier with a "View" deep-link into the entity, or a
  // draft-ready confirmation. The deck plays its own brief resolved-state flourish
  // (attention-deck.tsx); this is the durable, actionable receipt.
  const showReceipt = (result: AcceptResult) => {
    // A Start dispatched a run: the receipt points at the page of the teammate
    // it's for (bots-v4.md Phase 3), where the run shows under Working on.
    if (result.status === 'started' && result.where) {
      // Started in the place picked on the card: say where, and open the action it was filed as.
      const w = result.where
      toast.success(result.identifier ? `${result.identifier} started` : 'Started', {
        description:
          w.kind === 'mac'
            ? `On ${w.mac}, in ${w.folder}${w.edits ? ', on its own branch' : ', reading only'}. It reports in your chat.`
            : `In the cloud, ${w.environment}${w.repo ? `, on ${w.repo}` : ''}. It opens a pull request when done.`,
        ...(result.entity_id
          ? {
              action: {
                label: 'Open',
                onClick: () => {
                  capture('attention_receipt_clicked')
                  openInCardWorkspace({ type: 'action', id: result.entity_id as string, title: item.title })
                },
              },
            }
          : {}),
      })
      return
    }
    if (result.status === 'started') {
      const runner = p.assignee_ai_member_id ? (aiMembers.find((a) => a.id === p.assignee_ai_member_id) ?? null) : null
      const page = runner?.name ?? null
      toast.success(result.identifier ? `${result.identifier} started` : 'Started', {
        description: page ? `Watch it on ${page}’s page` : 'Watch it on its agent’s page',
        ...(runner
          ? {
              action: {
                label: 'Open',
                onClick: () => {
                  capture('attention_receipt_clicked')
                  openBotPage(runner.id, { focus: 'work' })
                },
              },
            }
          : {}),
      })
      return
    }
    if (result.status === 'draft_ready') {
      // No internal email-drafts review surface exists to deep-link (see the
      // report note) — a plain confirmation is the receipt.
      toast.success('Draft ready', { description: 'Review it before sending.' })
      return
    }
    if (item.kind === 'question') {
      toast.success(postCardCopy(item.payload)?.done ?? 'Got it')
      return
    }
    if (item.kind === 'approval') {
      toast.success('Approved', { description: 'It ran once. The result is in your chat.' })
      return
    }
    // The backing proposal was already dismissed elsewhere (honest server
    // outcome) — nothing was created, so don't claim it was. The card just leaves.
    if (result.status === 'dismissed') return
    // Only actions carry an openable detail panel. A card from another workspace
    // gets the link too — the card opens in that workspace (switched to first) and
    // lands the entry on ITS tabs, so the deep link can't resolve the card's ids
    // against the active workspace's data.
    const canView = result.entity_kind === 'action' && !!result.entity_id
    const verb = p.change_type === 'update' ? 'updated' : 'created'
    const message = result.identifier ? `${result.identifier} ${verb}` : 'Accepted'
    toast.success(message, {
      ...(canView
        ? {
            action: {
              label: 'View',
              onClick: () => {
                capture('attention_receipt_clicked')
                openInCardWorkspace({ type: 'action', id: result.entity_id as string, title: item.title })
              },
            },
          }
        : {}),
    })
  }

  const handleAccept = async (targetEntityId?: string) => {
    // W-4b/c: a target-less update can't apply in one click — open the picker
    // first, in the CARD's workspace.
    if (needsTarget && !targetEntityId) {
      setTargetPickerOpen(true)
      return
    }
    // A post draft (F3): Post opens the platform's compose page (X, LinkedIn,
    // Threads, Bluesky) with the text filled in,
    // in the person's own browser where they're signed in (review Q4),
    // started inside this click (a popup opened after an await is blocked).
    // Only once that worked is the card settled (N4); the person's click on
    // the platform is the only thing that posts.
    const post = item.kind === 'question' ? postDraftFromPayload(item.payload) : null
    if (post) {
      let opened = false
      try {
        opened = await openInSystemBrowser(postIntentUrl(post.surface, post.text))
      } catch {
        opened = false
      }
      if (!opened) {
        toast.error(`Couldn't open ${POST_SURFACE_NAME[post.surface]}`, { description: 'Copy the post instead; the card stays.' })
        return
      }
    }
    setAccepting(true)
    try {
      const result = await onAccept(item.id, corrections(), targetEntityId)
      // A draft_email whose generation failed leaves the card PENDING (the hook
      // re-added it, stamped with draft_id) — it re-renders as "Retry draft". The
      // hook already toasted the failure; nothing else to do here.
      if (result.draftGenerationFailed) return
      // The update had no resolvable target (server 409) — open the picker so the
      // user names the action, then retry. The hook re-added the card pending.
      if (result.needsTarget) {
        setTargetPickerOpen(true)
        return
      }
      // 409 (already resolved) or a hard failure (hook toasted) — no receipt.
      if (!result.ok) return

      capture('attention_card_accepted', { ms_since_created: msSinceCreated(item) })
      showReceipt(result)

      // If an agent was assigned and the accept created the action, the "send it
      // off" step: kick the coding run on the created action. Best-effort — the
      // action already exists; a failed launch just means the user can start it
      // from the action later. start-agent resolves the action through the
      // request's workspace, so the card's own workspace id rides along — that is
      // what makes assign-&-start work on a foreign card instead of 404ing.
      if (result.entity_id && p.assignee_ai_member_id) {
        void startAssignedAgent(result.entity_id, item.workspace_id, p, aiMembers)
      }
    } finally {
      setAccepting(false)
    }
  }

  // Start a work_proposal — dispatches a work run (the primary action for the
  // isWork branch). The card is optimistically removed by the hook; a successful
  // Start shows the "<id> started · Watch it in Activity" receipt. Reuses the
  // `accepting` busy state so the button spinner + disabled discipline is shared.
  const handleStart = async (runIn?: WorkRunPlace | null) => {
    setAccepting(true)
    try {
      const result = await onStart(item.id, runIn ?? null)
      // 409 (already resolved/expired) or a hard failure (hook toasted) — no receipt.
      if (!result.ok) return
      capture('attention_card_started', { ms_since_created: msSinceCreated(item), run_in: runIn?.kind ?? 'dial8' })
      showReceipt(result)
    } finally {
      setAccepting(false)
    }
  }

  // C2a: a post card's Typefully button. The click is the approval: the server
  // posts it (or queues it) through their Typefully once, as them. A failure
  // leaves the card, with the reason.
  const handlePublish = async (when: 'now' | 'next_free_slot') => {
    setAccepting(true)
    try {
      const result = await onAccept(item.id, { publish: when })
      if (!result.ok) return
      capture('attention_card_published', { when })
      toast.success(when === 'now' ? 'Sent to Typefully' : 'Added to your Typefully queue', result.message ? { description: result.message } : undefined)
    } finally {
      setAccepting(false)
    }
  }

  // An approval card's Always allow (Claude's Allow once / Always allow): the
  // server runs the held call once, as Approve does, then sets that connected
  // app's tool to Always allow, so it runs without a card from now on
  // (Settings › Connectors shows it and sets it back).
  const handleAlwaysAllow = async () => {
    setAccepting(true)
    setAlwaysAllowing(true)
    try {
      const result = await onAccept(item.id, { always_allow: true })
      if (!result.ok) return
      capture('attention_card_always_allowed', { saved: result.always_allowed === true })
      const tool = mcpToolLabel(p.tool)
      if (result.always_allowed) {
        toast.success('Approved', { description: `${tool} runs without asking from now on. Change it in Settings › Connectors.` })
      } else {
        toast.success('Approved once', { description: `Always allow couldn't be saved, so ${tool} still asks.` })
      }
    } finally {
      setAccepting(false)
      setAlwaysAllowing(false)
    }
  }

  // Copy a post draft's text (F3): the card stays, for Post or Dismiss later.
  const handleCopy = async () => {
    const post = postDraftFromPayload(item.payload)
    if (!post) return
    try {
      await navigator.clipboard.writeText(post.text)
      capture('attention_card_copied')
      toast.success('Copied')
    } catch {
      toast.error('Could not copy')
    }
  }

  const handleDismiss = async () => {
    setDismissing(true)
    try {
      capture('attention_card_dismissed')
      await onDismiss(item.id)
    } finally {
      setDismissing(false)
    }
  }

  // "Refine in chat" — the DEMOTED secondary affordance for draft_email cards
  // (WS-2a). The primary action now accepts (the server fills a real draft shell);
  // this routes the ask into the chat panel for interactive drafting instead and
  // DISMISSES the card, so the chat becomes the single owner of that draft (no
  // double-write against the accept path). (Adversarial review: draft-email
  // double-write.) In a bot's bubble or on its page the host gives its own
  // chat (`onRefine`): the ask goes to that bot, never the main chat.
  const handleRefineInChat = () => {
    capture('attention_card_refined')
    if (onRefine) {
      onRefine(item)
      void onDismiss(item.id)
      return
    }
    window.dispatchEvent(
      new CustomEvent('ni:chat-about-proposal', {
        detail: {
          captureId: p.capture_id ?? null,
          proposalId: item.proposal_id,
          displayText: p.display_text ?? item.title,
          description: p.description ?? null,
          changeType: 'send_email',
          entityType: 'external',
          emailToName: p.email_to_name ?? null,
          emailToAddress: p.email_to_address ?? null,
          emailSubject: p.email_subject ?? null,
          emailContext: p.email_context ?? null,
        },
      }),
    )
    void onDismiss(item.id)
  }

  return {
    accepting,
    dismissing,
    busy: accepting || dismissing,
    targetPickerOpen,
    setTargetPickerOpen,
    needsTarget,
    capture,
    openInCardWorkspace,
    handleAccept,
    handleStart,
    handleDismiss,
    handleRefineInChat,
    handleCopy,
    handlePublish,
    handleAlwaysAllow,
    alwaysAllowing,
  }
}

function msSinceCreated(item: AttentionItem): number {
  const t = Date.parse(item.created_at)
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0
}

/** Kick off the assigned agent's run on the action the accept just created.
 *  Mirrors ProposalCard.handleStartAgent. Best-effort: the accept already
 *  created the action. */
async function startAssignedAgent(
  actionId: string,
  workspaceId: string,
  payload: AttentionPayload,
  aiMembers: RailAiMember[],
) {
  try {
    const res = await fetch(`/api/account/actions/${actionId}/start-agent`, {
      method: 'POST',
      // The route resolves the action through the request's workspace. Naming the
      // CARD's workspace here (the interceptor only fills this header in when the
      // caller hasn't; the server re-verifies membership) is what lets a foreign
      // card's assign-&-start reach its action instead of 404ing in the active one.
      headers: { 'x-workspace-id': workspaceId },
    })
    if (!res.ok) {
      const agentName = aiMembers.find((a) => a.id === payload.assignee_ai_member_id)?.name || 'the agent'
      const err = await res.json().catch(() => ({}))
      toast.error(`Couldn't start ${agentName}`, {
        description: err?.error || 'You can start it from the action.',
      })
    }
  } catch {
    // Silent — the action exists; the launch is the only thing that failed.
  }
}
