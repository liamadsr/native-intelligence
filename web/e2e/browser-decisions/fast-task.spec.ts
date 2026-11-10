import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { executeBrowserTask, type TaskExecutorPorts } from '../../src/lib/browser-agent/task-executor'
import type { BrowserAction, BrowserObservation } from '../../src/lib/browser-agent/task-contract'

const runtime = readFileSync(resolve(process.env.NI_NATIVE_REPO ?? '../desktop', 'src-tauri/src/native/agent_runtime.js'), 'utf8')
const html = '<!doctype html><label>City<input aria-label="City"></label><button type="button" onclick="document.querySelector(\'output\').textContent=\'Results for \'+document.querySelector(\'input\').value">Search</button><output></output>'
async function fixture(page: Page) {
  await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.addInitScript(runtime)
  await page.goto('https://fixture.invalid/')
}
const snapshot = (page: Page) => page.evaluate<BrowserObservation>('window.__dial8Agent.snapshot({decision:true})')
const act = (page: Page, request: Record<string, unknown>) => page.evaluate<{ ok: boolean; code?: string }>(
  `window.__dial8Agent.taskAction(${JSON.stringify(request)})`)
function ports(page: Page, signal: AbortSignal): TaskExecutorPorts {
  return { signal, deadline: Date.now() + 45000, alive: () => !page.isClosed(), allowedOrigins: () => ['https://fixture.invalid'],
    snapshot: () => snapshot(page), act: request => act(page, request), approve: async () => false,
    // Deterministic planner exercises integration; this is not a Jev accuracy/latency benchmark.
    decide: async observation => {
      const field = observation.elements.find(e => e.name === 'City')!
      const action: BrowserAction = observation.text.includes('Results for Berlin') ? { operation: 'done' } : field.value ? { operation: 'click', ref: observation.elements.find(e => e.name === 'Search')!.ref } :
        { operation: 'type', ref: field.ref, binding: 0 }
      return { decision: { status: 'accepted', value: action, version: 'fixture', inferenceId: 'fixture' }, deadline: Date.now() + 45000 }
    },
  }
}
test('the production executor fills, clicks and verifies in a real browser', async ({ page }) => {
  await fixture(page)
  const result = await executeBrowserTask({ goal: 'Search for Berlin', bindings: [{ name: 'City', value: 'Berlin' }],
    completion: [{ kind: 'text', value: 'Results for Berlin' }] }, ports(page, new AbortController().signal))
  expect(result.status).toBe('verified')
  expect(result.steps).toBe(2)
  await expect(page.locator('output')).toHaveText('Results for Berlin')
})
test('a real user input event invalidates an in-flight native prediction', async ({ page }) => {
  await fixture(page)
  const observation = await snapshot(page)
  await page.getByLabel('City').click()
  await page.keyboard.type('Paris')
  const result = await act(page, { operation: 'type', ref: observation.elements[0].ref, text: 'Berlin',
    documentId: observation.documentId, observationId: observation.observationId, interactionEpoch: observation.interactionEpoch,
    deadline: Date.now() + 5000 })
  expect(result).toMatchObject({ ok: false, code: 'stale_observation' })
  await expect(page.getByLabel('City')).toHaveValue('Paris')
})
test('Stop during inference leaves the page untouched', async ({ page }) => {
  await fixture(page)
  const abort = new AbortController()
  const p = ports(page, abort.signal)
  const decide = p.decide
  p.decide = async (...args) => { abort.abort(); return decide(...args) }
  const result = await executeBrowserTask({ goal: 'Search', bindings: [{ name: 'City', value: 'Berlin' }],
    completion: [{ kind: 'text', value: 'Results for Berlin' }] }, p)
  expect(result.status).toBe('cancelled')
  await expect(page.getByLabel('City')).toHaveValue('')
  await expect(page.locator('output')).toHaveText('')
})
