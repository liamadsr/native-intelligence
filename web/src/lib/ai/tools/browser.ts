/**
 * The agent's browser tools.
 *
 * The agent's browser is a Chrome in the person's own cloud sandbox
 * (docs/plans/cloud-browser.md). These run SERVER-SIDE (in-process or in eve's
 * Nitro runtime): each tool ENQUEUES a command in `browser_command_queue`,
 * wakes the person's browser (ensureCloudBrowser), whose relay claims and runs
 * it (src/lib/cloud-browser/relay), and then polls briefly for the result.
 * Browser actions are fast (a click, a snapshot), so the common case resolves
 * inline; if a command runs long, the tool returns `{ pending, run_id }` and the
 * model calls `wait_for_browser_command`.
 *
 * The main agent hands browser actions to Jev through run_browser_task. Reads
 * auto-classify via isReadShapedToolName; the writes are listed in
 * NON_PREFIX_MUTATING_TOOLS. The `browser` category rides every surface the
 * edition allows (it needs no desktop): see the seeding in chat-run-rebuild.
 *
 * MUST be a pure constructor (no I/O at construction): tool-schemas.ts probes it
 * with dummy args to extract JSON schemas for the eve proxies.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueBrowserCommand, failWaitingBrowserCommand, readBrowserCommand, isTerminalBrowserStatus, ringComputer } from '@/lib/browser-agent/queue'
import { browserTaskSchema } from '@/lib/browser-agent/task-contract'
import { compactBrowserTaskResult } from '@/lib/browser-agent/task-result-summary'
import { parseDiagnosticBrowserSnapshot } from '@/lib/browser-agent/diagnostic-snapshot'
import type { BrowserCommandAttribution } from '@/lib/browser-agent/attribution'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { writeBrowserDebugTrace } from '@/lib/browser-agent/local-debug-trace'
import { RUN_BROWSER_TASK_DESCRIPTION } from '@/lib/browser-agent/task-instructions'
import { blockedSiteForUrl } from '@/lib/browser-agent/blocked-sites'
import { loadBlockedSites } from '@/lib/browser-agent/blocked-sites-server'
import { siteBlockedTaskResult } from '@/lib/browser-agent/task-executor'
import { fenceBrowserResult, fenceBrowserPageRead } from '@/lib/browser-agent/fence-readings'

/** How long a tool's execute polls inline before handing off to
 *  wait_for_browser_command. Long enough that a COLD start (the sandbox
 *  waking + its route compiling in dev) usually finishes inline — otherwise
 *  the model tends to treat the {pending} handoff as a failure and give up. A
 *  settled browser still resolves in ~1s; this only bounds the worst case. */
const INLINE_WAIT_MS = 20000
/** A browser task runs for up to its own timeout (45 s by default) after the
 *  relay claims it, so a 20 s inline wait handed nearly every task to
 *  wait_for_browser_command: one more model call (about a third of the turn's
 *  tokens, 10-07) just to wait. Wait out the task's own bound plus claim and
 *  start-up time instead; the pending handoff remains for a slow pickup. */
const TASK_START_MARGIN_MS = 15000
const POLL_EVERY_MS = 400

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Queue completion proves execution ended; only a verified task achieved its goal.
 * What the browser read on a page is fenced as untrusted (fence-readings.ts)
 * unless `fence` is false: a caller that validates the raw shape first fences
 * after.
 */
function completedResult(command: string, id: string, raw: unknown, fence = true) {
  const isTask = command === 'run_task'
  const compact = isTask ? compactBrowserTaskResult(raw) : raw
  const verified = compact !== null && typeof compact === 'object' && !Array.isArray(compact) &&
    'status' in compact && compact.status === 'verified'
  const result = fence ? fenceBrowserResult(command, compact) : compact
  return { success: !isTask || verified, browser_command_id: id,
    ...(isTask ? { browser_command_status: 'completed' as const } : {}), result }
}

export function createBrowserTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  attribution?: BrowserCommandAttribution,
  sourceRequest?: string,
  approvedCall?: ApprovedCall,
) {
  // The person accepted a card for one step of a browser task: this replay may take that step (approval-grant.ts).
  const grant = approvedCall?.tool === 'run_browser_task' && approvedCall.browser
    ? { approval_id: approvedCall.approvalId, ...approvedCall.browser } : null
  // Enqueue a command and poll inline for its result. Returns the terminal row,
  // or a pending handoff after INLINE_WAIT_MS.
  async function run(
    command: string,
    request: Record<string, unknown>,
    opts: { tabId?: string | null; targetOrigin?: string | null; requiresApproval?: boolean; inlineWaitMs?: number; fence?: boolean } = {},
  ) {
    let id: string
    try {
      id = await enqueueBrowserCommand({
        userId,
        workspaceId,
        ...(attribution ? { attribution } : {}),
        command,
        request,
        tabId: opts.tabId ?? null,
        targetOrigin: opts.targetOrigin ?? null,
        requiresApproval: opts.requiresApproval ?? false,
      })
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }

    // Wake the person's browser; its relay claims the command once it runs. If it
    // can't start, the command fails now with the reason instead of expiring.
    void import('@/lib/cloud-browser/host')
      .then(({ ensureCloudBrowser }) => ensureCloudBrowser({ userId, workspaceId }))
      .catch(error => failWaitingBrowserCommand(userId, id,
        `Your browser could not start: ${error instanceof Error ? error.message : String(error)}`).catch(() => {}))

    if (command === 'run_task') await writeBrowserDebugTrace({ userId, workspaceId, runId: id }, 'task.queued', {
      task: request.task, tabId: opts.tabId ?? null, targetOrigin: opts.targetOrigin ?? null, attribution,
    })

    const deadline = Date.now() + (opts.inlineWaitMs ?? INLINE_WAIT_MS)
    while (Date.now() < deadline) {
      await sleep(POLL_EVERY_MS)
      const row = await readBrowserCommand(userId, id)
      if (row && isTerminalBrowserStatus(row.status)) {
        if (row.status === 'completed') return completedResult(command, id, row.result, opts.fence ?? true)
        if (row.status === 'denied')
          return { success: false, browser_command_id: id, browser_command_status: 'denied', denied: true, error: row.error_message ?? 'Blocked by browser guardrails.' }
        if (row.status === 'expired')
          return {
            success: false,
            browser_command_id: id,
            browser_command_status: 'expired',
            error:
              row.error_message ?? 'Your browser did not start in time. Try again in a moment.',
          }
        return { success: false, browser_command_id: id, browser_command_status: 'failed', error: row.error_message ?? 'Browser command failed.' }
      }
    }
    return {
      success: true,
      pending: true,
      run_id: id,
      browser_command_id: id,
      message:
        'The browser is still working (it may still be waking up). This is NOT a failure — call wait_for_browser_command with this run_id to get the result; do not retry the action or fall back to another tool.',
    }
  }

  return {
    run_browser_task: tool({
      description: RUN_BROWSER_TASK_DESCRIPTION,
      inputSchema: z.object({
        goal: browserTaskSchema.shape.goal.describe('Copy the user\'s complete browser request, preserving the requested findings, quantity, order, exclusions and exact constraints. If the user asks for titles, links, prices or a comparison, collecting those facts belongs in this goal. When continuing an unverified task, state what remains.'),
        startUrl: browserTaskSchema.shape.startUrl.describe('Optional page to open first, after site permissions are checked. For a web search, use the results URL (for example https://www.google.com/search?q=...). Omit it to continue from the current page.'),
        completion: browserTaskSchema.shape.completion,
        tab_id: z.string().optional(),
      }),
      execute: async ({ tab_id, ...input }) => {
        const task = browserTaskSchema.parse({ ...input, goalDriven: true, ...(sourceRequest ? { sourceRequest } : {}) })
        // A start page on a site the user blocked is refused here, before
        // anything is queued. The relay refuses it too (and every page the
        // task reaches), so a list that can't be read here is no reason to stop.
        if (task.startUrl) {
          const sites = await loadBlockedSites(supabase, userId).catch(() => [])
          const blocked = blockedSiteForUrl(task.startUrl, sites)
          if (blocked) return { success: false, site_blocked: true, result: compactBrowserTaskResult(siteBlockedTaskResult(blocked)) }
        }
        return run('run_task', { task, decisionCount: 0, ...(grant ? { approvalGrant: grant } : {}) },
          { tabId: tab_id, inlineWaitMs: task.timeoutMs + TASK_START_MARGIN_MS })
      },
    }),
    read_browser_page: tool({
      description:
        'Inspect the current page of your browser when context or a completion check is needed. Jev observes intermediate pages itself inside run_browser_task; do not read the page after every action. Options: {prose:true} includes in-body links; {max:N} caps the count (default 200, on-screen first). For an explicitly requested diagnostic or reproducing a failed task, decision_snapshot:true returns the exact normalized Jev observation (up to 100 controls and 12000 page-text characters). It ignores prose/max. Wait until any browser task settles before taking this diagnostic snapshot; it replaces the native observation token. It is evidence for inspection/replay, not permission to execute saved actions.',
      inputSchema: z.object({
        tab_id: z.string().optional().describe('Target tab; omit for the active tab.'),
        prose: z.boolean().optional().describe('Include in-body prose links (default false).'),
        max: z.number().optional().describe('Max elements before capping (default 200; 0 = no cap).'),
        decision_snapshot: z.boolean().optional().describe('Opt-in diagnostic: return the bounded normalized observation used by Jev, including exact controls and page text. Default false.'),
      }),
      execute: async ({ tab_id, prose, max, decision_snapshot }) => {
        const options: Record<string, unknown> = {}
        if (decision_snapshot) options.decision = true
        else {
          if (prose !== undefined) options.prose = prose
          if (max !== undefined) options.max = max
        }
        // A decision snapshot is validated on its raw shape, then fenced here.
        const outcome = await run('read_page', { options }, { tabId: tab_id, fence: !decision_snapshot })
        // New relays validate before settling. Also defend an inline response
        // from an older renderer that does not yet validate this opt-in mode.
        if (decision_snapshot && 'result' in outcome) {
          try { return { ...outcome, result: fenceBrowserPageRead(parseDiagnosticBrowserSnapshot(outcome.result)) } }
          catch (error) { return { success: false, browser_command_id: outcome.browser_command_id,
            error: error instanceof Error ? error.message : 'Browser diagnostic snapshot unavailable.' } }
        }
        return outcome
      },
    }),

    get_browser_text: tool({
      description:
        'Get readable text from the current tab of your browser. Use run_browser_task result evidence first; call this only for missing final facts after the task settles. Start with max_chars:3000 and increase only if needed. Use read_browser_page to inspect controls.',
      inputSchema: z.object({
        tab_id: z.string().optional(),
        max_chars: z.number().optional().describe('Truncate to this many characters (default 50000).'),
      }),
      execute: async ({ tab_id, max_chars }) =>
        run('get_text', { maxChars: max_chars }, { tabId: tab_id }),
    }),

    screenshot_browser: tool({
      description:
        'Take a screenshot of the current tab of your browser. Use when a visual check is needed; use run_browser_task for actions and get_browser_text for reading. The image is shown only to models that can view images in tool results; any other model gets a note instead.',
      inputSchema: z.object({ tab_id: z.string().optional() }),
      execute: async ({ tab_id }) => run('screenshot', {}, { tabId: tab_id }),
    }),

    open_browser: tool({
      description:
        'Show the user your browser (its live view), e.g. when they ask to see it. You never need this to use the browser: run_browser_task and the reads work without it.',
      inputSchema: z.object({}),
      // The person's open windows on this workspace show the live view (cloud-computer-mount.tsx); nothing runs in the sandbox.
      execute: async () => {
        await ringComputer({ userId, workspaceId }, 'browser-show')
        return { success: true, message: 'Your browser is showing on the user’s open Native Intelligence windows.' }
      },
    }),

    close_browser: tool({
      description:
        'Put the live view of your browser away.',
      inputSchema: z.object({}),
      execute: async () => {
        await ringComputer({ userId, workspaceId }, 'browser-hide')
        return { success: true }
      },
    }),

    wait_for_browser_command: tool({
      description:
        'Wait for a browser command that returned {pending, run_id} to finish, and get its result. Call this (re-calling if it says still running) after a task or read that did not complete inline.',
      inputSchema: z.object({
        run_id: z.string().describe('The run_id from a pending browser tool result.'),
        max_wait_seconds: z
          .number()
          .optional()
          .describe('How long to wait this call before returning still-running (default 30, max 240).'),
      }),
      execute: async ({ run_id, max_wait_seconds }) => {
        const budget = Math.min(Math.max(max_wait_seconds ?? 30, 1), 240) * 1000
        const deadline = Date.now() + budget
        while (Date.now() < deadline) {
          const row = await readBrowserCommand(userId, run_id)
          if (!row) return { success: false, error: 'Unknown run_id.' }
          if (isTerminalBrowserStatus(row.status)) {
            if (row.status === 'completed') return { ...completedResult(row.command, run_id, row.result), done: true }
            if (row.status === 'denied')
              return { success: false, done: true, browser_command_id: run_id, browser_command_status: 'denied', denied: true, error: row.error_message }
            return { success: false, done: true, browser_command_id: run_id, browser_command_status: row.status, error: row.error_message ?? row.status }
          }
          await sleep(POLL_EVERY_MS)
        }
        return {
          success: true,
          done: false,
          still_running: true,
          run_id,
          browser_command_id: run_id,
          message: 'Still running. Call wait_for_browser_command again with the same run_id.',
        }
      },
    }),
  }
}
