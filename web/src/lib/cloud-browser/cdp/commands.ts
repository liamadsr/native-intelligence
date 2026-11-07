import { parseDiagnosticBrowserSnapshot } from '@/lib/browser-agent/diagnostic-snapshot'
import { mergeFrameObservations } from '@/lib/browser-agent/frame-observation'
import { AGENT_SCREENSHOT_MAX_WIDTH, AGENT_SCREENSHOT_QUALITY, checkReadSite, parseNative } from '@/lib/browser-agent/page-reads'
import type { TaskExecutorPorts } from '@/lib/browser-agent/task-executor'
import type { CloudPage } from './page'

/**
 * The queue's commands on a cloud page, with the results the desktop's
 * command relay returns for them today (use-browser-command-relay.ts
 * `execute`), and the engine half of a task's ports (docs/plans/cloud-browser.md,
 * C1). The relay that claims rows in the sandbox (C2) adds the rest: claim,
 * the guardrail, the decision route, approvals and settle.
 *
 * open_window and close_window are the live view's (C3), never the sandbox's.
 */
export async function runCloudCommand(page: CloudPage, command: string, req: Record<string, unknown>,
  sites: readonly string[]): Promise<unknown> {
  switch (command) {
    case 'read_page': {
      const options = (req.options ?? {}) as Record<string, unknown>
      const snapshot = parseNative(await page.readPage(options))
      // A page still loading has no runtime yet: a read-only startup condition the relay retries.
      if (typeof snapshot === 'object' && snapshot !== null &&
          (snapshot as Record<string, unknown>).error === 'agent runtime not present') throw new Error('agent runtime not present')
      checkReadSite(snapshot, sites)
      return options.decision === true ? parseDiagnosticBrowserSnapshot(snapshot) : snapshot
    }
    case 'get_text': {
      const text = parseNative(await page.getText(typeof req.maxChars === 'number' ? req.maxChars : undefined))
      checkReadSite(text, sites)
      return text
    }
    case 'screenshot': {
      // Pixels carry no address: the page's own is read just before and just after the capture.
      const pageUrl = async () => {
        try {
          const read = parseNative(await page.getText(1)) as Record<string, unknown>
          if (typeof read?.url === 'string') return read.url
        } catch { /* no page runtime yet (mid-load): the tab's committed address instead */ }
        return page.url
      }
      if (sites.length) checkReadSite({ url: await pageUrl() }, sites)
      const screenshotBase64 = await page.screenshot({ maxWidth: AGENT_SCREENSHOT_MAX_WIDTH, quality: AGENT_SCREENSHOT_QUALITY })
      if (sites.length) checkReadSite({ url: await pageUrl() }, sites)
      return { screenshotBase64, mediaType: 'image/jpeg' }
    }
    case 'navigate':
      await page.navigate(String(req.url ?? ''), new AbortController().signal, Date.now() + 15_000)
      return { ok: true }
    case 'click':
      return parseNative(await page.click(String(req.ref ?? '')))
    case 'type':
      return parseNative(await page.type(String(req.ref ?? ''), String(req.text ?? '')))
    case 'go_back':
      await page.goBack()
      return { ok: true }
    case 'go_forward':
      await page.goForward()
      return { ok: true }
    case 'reload':
      await page.reload()
      return { ok: true }
    default:
      throw new Error(`Unsupported browser command: ${command}`)
  }
}

export type CloudTaskPorts = Pick<TaskExecutorPorts, 'navigate' | 'snapshot' | 'act' | 'blockedNavigation'> & { stop(): void }

/**
 * A task's engine ports on a cloud page, built as the desktop relay builds its
 * own: the snapshot merges embedded frames, an action is refused once the task
 * is cancelled, and a navigation the guard kept the page from is reported.
 */
export function cloudTaskPorts(page: CloudPage, task: { signal: AbortSignal; deadline: number; sites: () => readonly string[] }): CloudTaskPorts {
  let kept: string | null = null
  const stop = page.onNotice(notice => { if (notice.kind === 'agent-navigation-blocked') kept = notice.site })
  return {
    navigate: url => page.navigate(url, task.signal, task.deadline),
    snapshot: async () => mergeFrameObservations(parseNative(await page.decisionSnapshot()), task.sites()),
    act: async request => {
      if (task.signal.aborted) throw new Error('Task cancelled')
      return parseNative(await page.taskAction(request)) as { ok: boolean; code?: string }
    },
    blockedNavigation: () => kept,
    stop,
  }
}
