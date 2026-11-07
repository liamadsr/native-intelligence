/**
 * In-app browser — agent guardrails, enforced DEVICE-SIDE (in the drain loop).
 *
 * "Autonomous with guardrails" (the product decision): the agent may run
 * multi-step browser tasks without a confirm on every click, but:
 *  - it may use any site, except the ones the user blocked (blocked-sites.ts):
 *    there it can't read, screenshot, act or navigate at all;
 *  - sensitive actions (anything that could send/buy/delete or touch
 *    credentials) require a human OK on the device, on every site.
 *
 * Enforcing this on the device (not the server tool) is deliberate: the device
 * is the only place that knows the tab's real current page, and it's the
 * trust boundary the user physically controls (the visible Stop lives here too).
 */
import { blockedSiteForUrl, siteBlockedMessage } from './blocked-sites'

/** Commands that read the page without changing it. */
const READ_COMMANDS = new Set(['read_page', 'get_text', 'screenshot', 'list_tabs'])
/** Window-management ops (open/close the browser window itself): they touch
 *  no site, so there is nothing to check. */
const WINDOW_COMMANDS = new Set(['open_window', 'close_window'])

/** Commands that mutate page state / navigate. */
const WRITE_COMMANDS = new Set([
  'navigate',
  'click',
  'type',
  'go_back',
  'go_forward',
  'reload',
  'open_tab',
  'close_tab',
])

export interface GuardrailContext {
  /** The sites the user blocked the agent from. */
  blockedSites: readonly string[]
  /** The page the command reads or acts on (the tab's current URL, or the
   *  destination for a navigate). Null when it isn't known. */
  targetUrl: string | null
  command: string
  /** Whether the server already flagged this as sensitive (send/buy/delete). */
  requiresApproval: boolean
}

export type GuardrailDecision =
  | { allow: true; needsApproval: false }
  | { allow: true; needsApproval: true; reason: string }
  | { allow: false; reason: string; blockedSite?: string }

/** Decide whether a browser command may run, needs a human OK first, or is
 *  blocked. Pure — unit-testable without a browser. */
export function evaluateGuardrail(ctx: GuardrailContext): GuardrailDecision {
  // Window-management ops act on our own window, not any site.
  if (WINDOW_COMMANDS.has(ctx.command)) return { allow: true, needsApproval: false }

  const read = READ_COMMANDS.has(ctx.command)
  if (!read && !WRITE_COMMANDS.has(ctx.command)) {
    // Unknown command: refuse (fail closed).
    return { allow: false, reason: `Unknown browser command: ${ctx.command}` }
  }
  const blockedSite = blockedSiteForUrl(ctx.targetUrl, ctx.blockedSites)
  if (blockedSite) return { allow: false, reason: siteBlockedMessage(blockedSite), blockedSite }
  if (read) return { allow: true, needsApproval: false }
  // An action on a page whose site isn't known could be on a blocked one.
  // Reads are checked against the page they actually read instead.
  if (!ctx.targetUrl && ctx.blockedSites.length > 0) {
    return { allow: false, reason: 'The browser could not confirm which site this page is on, so the agent did not act on it.' }
  }
  // Even on an allowed site, a sensitive action needs a human OK.
  if (ctx.requiresApproval) {
    return {
      allow: true,
      needsApproval: true,
      reason: 'This is a sensitive action (it may send, buy, or delete). Confirm to proceed.',
    }
  }
  return { allow: true, needsApproval: false }
}

/** Heuristic: does this command look sensitive enough to always ask, even if the
 *  server didn't flag it? Used as a belt-and-braces on the device for click/type
 *  whose target text hints at an irreversible action. The server also flags
 *  these; this catches ones it missed. */
const SENSITIVE_TEXT = /\b(buy|purchase|pay|checkout|order|delete|remove|send|transfer|confirm|subscribe|unsubscribe|deactivate|close account)\b/i

export function looksSensitive(commandText: string | null | undefined): boolean {
  return !!commandText && SENSITIVE_TEXT.test(commandText)
}
