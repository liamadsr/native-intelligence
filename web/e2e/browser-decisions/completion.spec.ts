import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { browserTaskSchema, taskCompleted, type BrowserObservation } from '../../src/lib/browser-agent/task-contract'
import { executeBrowserTask, type TaskExecutorPorts } from '../../src/lib/browser-agent/task-executor'

const runtime = readFileSync(resolve(process.env.DIAL8_NATIVE_REPO ?? '../dial8-desktop', 'src-tauri/src/native/agent_runtime.js'), 'utf8')
const snapshot = (page: Page) => page.evaluate<BrowserObservation>('window.__dial8Agent.snapshot({decision:true})')
const task = browserTaskSchema.parse({ goal: 'Reveal the Ada Lovelace article by dismissing all dialogs', completion: [
  { kind: 'heading', value: 'Ada Lovelace', level: 1 }, { kind: 'dialog', state: 'absent' },
] })

async function fixture(page: Page, replacement = false) {
  const action = replacement ? "this.parentElement.setAttribute('aria-label','Reminder options');this.textContent='Send a reminder'" : 'this.parentElement.remove()'
  await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><h1>Ada Lovelace</h1><p>10 December 1815</p><div role="dialog" aria-label="Fundraising" style="position:fixed;inset:0;background:white"><button onclick="${action}">Close banner</button></div>` }))
  await page.addInitScript(runtime)
  await page.goto('https://fixture.invalid/')
}

test('native dismissal reveals a grounded heading and the executor verifies final dialog absence', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  expect(before.evidence?.headings).toEqual([])
  expect(before.evidence?.dialogs).toEqual([{ name: 'Fundraising', visible: true }])
  expect(taskCompleted(task, before)).toBe(false)
  const ports: TaskExecutorPorts = {
    signal: new AbortController().signal, deadline: Date.now() + 45000, alive: () => !page.isClosed(),
    allowedOrigins: () => ['https://fixture.invalid'], snapshot: () => snapshot(page), approve: async () => false,
    act: request => page.evaluate(`window.__dial8Agent.taskAction(${JSON.stringify(request)})`),
    // Deterministic planning tests grounding/execution, not live model accuracy.
    decide: async observation => ({ deadline: Date.now() + 45000, decision: {
      status: 'accepted', version: 'fixture', inferenceId: 'fixture', value: observation.evidence?.dialogs.length ?
        { operation: 'click', ref: observation.elements.find(element => element.name === 'Close banner')!.ref } : { operation: 'done' },
    } }),
  }
  const result = await executeBrowserTask(task, ports)
  expect(result.status).toBe('verified')
  expect(result.steps).toBe(1)
  expect(taskCompleted(task, await snapshot(page))).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('replacing a banner with reminder options does not satisfy dismissal', async ({ page }) => {
  await fixture(page, true)
  const before = await snapshot(page)
  const button = before.elements.find(element => element.name === 'Close banner')!
  expect(button.dialog).toBe('Fundraising')
  const result = await page.evaluate(`window.__dial8Agent.taskAction(${JSON.stringify({
    documentId: before.documentId, observationId: before.observationId, interactionEpoch: before.interactionEpoch,
    operation: 'click', ref: button.ref, deadline: Date.now() + 5000,
  })})`)
  expect(result).toEqual({ ok: true })
  const after = await snapshot(page)
  expect(after.evidence?.dialogs).toEqual([{ name: 'Reminder options', visible: true }])
  expect(taskCompleted(task, after)).toBe(false)
})

test('delayed autocomplete recovers within one executor call after an uncertain observation', async ({ page }) => {
  await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><label>City<input aria-label="City"></label><div id="suggestions"></div><h1>Choose a city</h1>' }))
  await page.addInitScript(runtime)
  await page.goto('https://fixture.invalid/')
  let uncertainties = 0
  const ports: TaskExecutorPorts = {
    signal: new AbortController().signal, deadline: Date.now() + 45000, alive: () => !page.isClosed(),
    allowedOrigins: () => ['https://fixture.invalid'], snapshot: () => snapshot(page), approve: async () => false,
    act: request => page.evaluate(`window.__dial8Agent.taskAction(${JSON.stringify(request)})`),
    decide: async observation => {
      const field = observation.elements.find(element => element.name === 'City')!
      const option = observation.elements.find(element => element.name === 'Berlin, Germany')
      if (field.value && !option && !observation.text.includes('Selected Berlin')) {
        uncertainties++
        // Release a deferred suggestions response only after the incomplete
        // observation reached the planner. Timing remains deterministic under load.
        await page.evaluate(() => {
          setTimeout(() => {
            const option = document.createElement('button')
            option.textContent = 'Berlin, Germany'
            option.onclick = () => {
              document.querySelector('h1')!.textContent = 'Selected Berlin'
              document.querySelector('#suggestions')!.replaceChildren()
            }
            document.querySelector('#suggestions')!.append(option)
          }, 150)
        })
        return { deadline: Date.now() + 45000, decision: { status: 'escalate', reason: 'uncertain' } }
      }
      return { deadline: Date.now() + 45000, decision: { status: 'accepted', version: 'fixture', inferenceId: 'fixture',
        value: observation.text.includes('Selected Berlin') ? { operation: 'done' } : option ?
          { operation: 'click', ref: option.ref } : { operation: 'type', ref: field.ref, binding: 0 },
      } }
    },
  }
  const result = await executeBrowserTask({ goal: 'Select Berlin from autocomplete', bindings: [{ name: 'City', value: 'Berlin' }],
    completion: [{ kind: 'heading', value: 'Selected Berlin' }] }, ports)
  expect(result.status).toBe('verified')
  expect(result.steps).toBe(2)
  expect(uncertainties).toBe(1)
  expect(result.trace.filter(entry => entry.recovery === 'page_changed')).toHaveLength(1)
  await expect(page.getByRole('heading')).toHaveText('Selected Berlin')
})

test('autocomplete exposes the real link once and reaches the article in one task', async ({ page }) => {
  const label = 'Ada LovelaceEnglish mathematician (1815–1852)'
  await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    new URL(route.request().url()).pathname === '/article' ? '<!doctype html><h1>Ada Lovelace</h1><p>10 December 1815</p>' :
      `<!doctype html><h1>Main Page</h1><input aria-label="Search Wikipedia" role="combobox" oninput="document.querySelector('[role=listbox]').hidden=false">
      <div role="listbox" aria-label="Search results" hidden>
        <div role="option"><a href="/article">${label}</a></div>
        <div role="option"><a href="/gpu">Ada Lovelace (microarchitecture)</a></div>
      </div><script>document.querySelectorAll('[role=option]').forEach(option => option.addEventListener('click', () => { option.parentElement.hidden=true }))</script>` }))
  await page.addInitScript(runtime)
  await page.goto('https://fixture.invalid/')
  let choices = 0
  const ports: TaskExecutorPorts = {
    signal: new AbortController().signal, deadline: Date.now() + 45000, alive: () => !page.isClosed(),
    allowedOrigins: () => ['https://fixture.invalid'], snapshot: () => snapshot(page), approve: async () => false,
    act: request => page.evaluate(`window.__dial8Agent.taskAction(${JSON.stringify(request)})`),
    // Deterministic planning validates the production native/executor boundary,
    // including navigation; live Jev accuracy is measured separately.
    decide: async observation => {
      if (observation.url.endsWith('/article')) return { deadline: Date.now() + 45000, decision: {
        status: 'accepted', version: 'fixture', inferenceId: 'fixture', value: { operation: 'done' },
      } }
      const field = observation.elements.find(element => element.name === 'Search Wikipedia')!
      if (!field.value) return { deadline: Date.now() + 45000, decision: {
        status: 'accepted', version: 'fixture', inferenceId: 'fixture', value: { operation: 'type', ref: field.ref, binding: 0 },
      } }
      const candidates = observation.elements.filter(element => element.name === label)
      expect(candidates).toHaveLength(1)
      expect(candidates[0].role).toBe('link')
      expect(observation.elements.some(element => element.role === 'listbox')).toBe(false)
      choices++
      return { deadline: Date.now() + 45000, decision: {
        status: 'accepted', version: 'fixture', inferenceId: 'fixture', value: { operation: 'click', ref: candidates[0].ref },
      } }
    },
  }
  const result = await executeBrowserTask({ goal: 'Search for Ada Lovelace and open her article',
    bindings: [{ name: 'Search query', value: 'Ada Lovelace' }], completion: [
      { kind: 'url', value: 'https://fixture.invalid/article' }, { kind: 'heading', value: 'Ada Lovelace', level: 1 },
    ] }, ports)
  expect(result.status, JSON.stringify(result)).toBe('verified')
  expect(result.steps).toBe(2)
  expect(choices).toBe(1)
  await expect(page).toHaveURL('https://fixture.invalid/article')
  await expect(page.getByRole('heading')).toHaveText('Ada Lovelace')
})
