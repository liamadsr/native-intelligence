/**
 * The queue's commands and a task's engine ports on a cloud page
 * (src/lib/cloud-browser/cdp/commands.ts), with a stub page: the same results
 * and site checks the desktop's command relay gives, frames merged into the
 * task's snapshot, and a guard notice reported as the blocked navigation.
 */
import { describe, expect, it, vi } from 'vitest'
import { cloudTaskPorts, runCloudCommand } from '../commands'
import type { CloudPage, PageNotice } from '../page'

function stubPage(overrides: Partial<Record<keyof CloudPage, unknown>> = {}) {
  const listeners = new Set<(notice: PageNotice) => void>()
  return {
    url: 'https://example.com/',
    readPage: vi.fn(async () => '{"url":"https://example.com/","elements":[]}'),
    getText: vi.fn(async () => '{"url":"https://example.com/","text":"Hello"}'),
    screenshot: vi.fn(async () => 'BASE64'),
    click: vi.fn(async () => '{"ok":true}'),
    type: vi.fn(async () => '{"ok":true}'),
    navigate: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    decisionSnapshot: vi.fn(async () => '{"main":{"elements":[],"documentId":"d","observationId":1,"interactionEpoch":0},"frames":[],"inputCapable":true}'),
    taskAction: vi.fn(async () => '{"ok":true}'),
    onNotice: (listener: (notice: PageNotice) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    emit: (notice: PageNotice) => { for (const listener of listeners) listener(notice) },
    ...overrides,
  }
}
const asPage = (stub: ReturnType<typeof stubPage>) => stub as unknown as CloudPage

describe('runCloudCommand', () => {
  it('reads the page and refuses one on a blocked site', async () => {
    const page = stubPage()
    expect(await runCloudCommand(asPage(page), 'read_page', { options: { prose: true } }, [])).toEqual({ url: 'https://example.com/', elements: [] })
    expect(page.readPage).toHaveBeenCalledWith({ prose: true })
    await expect(runCloudCommand(asPage(page), 'get_text', {}, ['example.com'])).rejects.toMatchObject({ site: 'example.com' })
  })

  it('treats a page with no runtime yet as a retryable startup condition', async () => {
    const page = stubPage({ readPage: vi.fn(async () => '{"error":"agent runtime not present"}') })
    await expect(runCloudCommand(asPage(page), 'read_page', {}, [])).rejects.toThrow('agent runtime not present')
  })

  it('takes the agent screenshot small, checking the page before and after', async () => {
    const page = stubPage()
    expect(await runCloudCommand(asPage(page), 'screenshot', {}, ['linkedin.com'])).toEqual({ screenshotBase64: 'BASE64', mediaType: 'image/jpeg' })
    expect(page.screenshot).toHaveBeenCalledWith({ maxWidth: 1024, quality: 0.6 })
    expect(page.getText).toHaveBeenCalledTimes(2)
    const blocked = stubPage({ getText: vi.fn(async () => '{"url":"https://www.linkedin.com/feed"}') })
    await expect(runCloudCommand(asPage(blocked), 'screenshot', {}, ['linkedin.com'])).rejects.toMatchObject({ site: 'linkedin.com' })
    expect(blocked.screenshot).not.toHaveBeenCalled()
  })

  it('runs the ref commands and history, and refuses what the sandbox does not serve', async () => {
    const page = stubPage()
    expect(await runCloudCommand(asPage(page), 'click', { ref: 'e3' }, [])).toEqual({ ok: true })
    expect(page.click).toHaveBeenCalledWith('e3')
    expect(await runCloudCommand(asPage(page), 'type', { ref: 'e4', text: 'hi' }, [])).toEqual({ ok: true })
    expect(await runCloudCommand(asPage(page), 'go_back', {}, [])).toEqual({ ok: true })
    for (const command of ['open_window', 'close_window', 'list_tabs'])
      await expect(runCloudCommand(asPage(page), command, {}, [])).rejects.toThrow('Unsupported browser command')
  })
})

describe('cloudTaskPorts', () => {
  it('merges frames into the snapshot, refuses an action once cancelled, and reports a kept navigation', async () => {
    const page = stubPage()
    const controller = new AbortController()
    const ports = cloudTaskPorts(asPage(page), { signal: controller.signal, deadline: Date.now() + 5000, sites: () => [] })
    expect(await ports.snapshot()).toMatchObject({ documentId: 'd', trustedInput: true })
    expect(await ports.act({ operation: 'click' })).toEqual({ ok: true })
    expect(ports.blockedNavigation!()).toBeNull()
    page.emit({ kind: 'download-unsupported' })
    page.emit({ kind: 'agent-navigation-blocked', site: 'linkedin.com' })
    expect(ports.blockedNavigation!()).toBe('linkedin.com')
    controller.abort()
    await expect(ports.act({ operation: 'click' })).rejects.toThrow('Task cancelled')
    ports.stop()
    page.emit({ kind: 'agent-navigation-blocked', site: 'other.com' })
    expect(ports.blockedNavigation!()).toBe('linkedin.com')
  })
})
