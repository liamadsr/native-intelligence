// @vitest-environment jsdom
/**
 * The Teams panel's AI teammate dialog (ai-teammate-dialog.tsx), adding and
 * editing. No faces: a new teammate's face is the database's to hand out, and
 * an edit never sends one.
 *
 *   • Adding sends its name and persona, nothing for the face.
 *   • Editing seeds the teammate and sends only what changed.
 *   • A system teammate's persona is locked, with the reason; its name still
 *     changes.
 *   • The routes' errors (RLS's included) show in the dialog.
 *   • What the editor can't read (another creator's personal persona or
 *     skill) stays: the persona shows as "Private persona", selected, and is
 *     never sent unless another is picked; a private skill on a system
 *     teammate goes back in every skill_recipe_ids sent, in its place, and is
 *     counted under the list.
 *   • Skills (bots-v4 B1, decision 11): a teammate's are its agent's, shown
 *     here with the way to the one agent editor, never ticked here; a new one
 *     starts with them. Only a system teammate's change here, up to five.
 *   • On a short window the body scrolls; the title and Save stay put.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AiTeammateDialog, type EditableAiMember } from '../ai-teammate-dialog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Radix's select and checkbox reach for browser APIs jsdom lacks.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

const AGENTS = [
  { id: 'r-1', name: 'Researcher persona', icon: null, color: null, visibility: 'workspace' },
  { id: 'r-2', name: 'PM persona', icon: null, color: null, visibility: 'workspace' },
  // The caller's own personal agent: a personal agent has no teammate, so it's never offered.
  { id: 'r-mine', name: 'My private persona', icon: null, color: null, visibility: 'personal' },
]
const SKILLS = [
  { id: 's-1', name: 'Summarize', icon: null, color: null },
  { id: 's-2', name: 'Draft email', icon: null, color: null },
]

const RILEY: EditableAiMember = {
  id: 'ai-riley',
  name: 'Riley',
  is_system: false,
  agent: AGENTS[0],
  skills: [SKILLS[0]],
}

const TRIAGE: EditableAiMember = {
  id: 'sys-triage',
  name: 'Triage',
  is_system: true,
  agent: null,
  skills: [],
}

/** Built on another creator's personal persona, with one of their personal skills first. */
const QUILL: EditableAiMember = {
  id: 'ai-quill',
  name: 'Quill',
  is_system: false,
  agent: null,
  skills: [SKILLS[0]],
  agent_recipe_id: 'r-private',
  skill_recipe_ids: ['s-private', 's-1'],
}

/** A system teammate holding another creator's personal skill (pinned before B1), then a readable one. */
const SORTER: EditableAiMember = {
  id: 'sys-sorter',
  name: 'Sorter',
  is_system: true,
  agent: null,
  skills: [SKILLS[0]],
  skill_recipe_ids: ['s-private', 's-1'],
}

let container: HTMLDivElement
let root: Root
let writes: Array<{ url: string; method: string; body: Record<string, unknown> }>
let writeResponse: { status: number; body: unknown }
const onSaved = vi.fn()
const onClose = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  writes = []
  writeResponse = { status: 200, body: { success: true } }
  onSaved.mockReset()
  onClose.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/account/agents') return json(200, { agents: AGENTS })
      if (url === '/api/account/skills') return json(200, { skills: SKILLS })
      writes.push({ url, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) })
      return json(writeResponse.status, writeResponse.body)
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(props: { member?: EditableAiMember } = {}) {
  await act(async () => {
    root.render(
      <AiTeammateDialog
        teamId="team-1"
        member={props.member}
        onClose={onClose}
        onSaved={onSaved}
      />,
    )
  })
  // The agents and skills fetches settle.
  await act(async () => {})
}

const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement
const text = () => (dialog().textContent ?? '').replace(/\s+/g, ' ')
const button = (label: string) =>
  Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement
const nameInput = () => dialog().querySelector('input[placeholder="e.g. Riley (PM)"]') as HTMLInputElement
const personaSelect = () => dialog().querySelector('[role="combobox"]') as HTMLButtonElement

async function typeName(value: string) {
  const el = nameInput()
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pickPersona(name: string) {
  await act(async () => personaSelect().click())
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((o) =>
    o.textContent?.includes(name),
  )
  if (!option) throw new Error(`persona option ${name} not shown`)
  await act(async () => option.click())
}

async function click(el: HTMLElement) {
  await act(async () => el.click())
}

describe('adding an AI teammate', () => {
  it('sends its name and persona, and leaves its face to the database', async () => {
    await render()
    expect(text()).toContain('Add an agent')
    expect(dialog().querySelector('[role="radio"]')).toBeNull()
    expect(text()).not.toMatch(/\bBot\b|face/i)

    await typeName('Atlas')
    await pickPersona('PM persona')
    await click(button('Add to team'))

    expect(writes).toEqual([
      {
        url: '/api/account/teams/team-1/ai-members',
        method: 'POST',
        // No skills: a new teammate starts with its agent's (decision 11).
        body: { name: 'Atlas', agent_recipe_id: 'r-2' },
      },
    ])
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('offers no personal agent: a personal agent has no teammate', async () => {
    await render()
    await act(async () => personaSelect().click())
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.textContent ?? '')
    expect(options.some((o) => o.includes('PM persona'))).toBe(true)
    expect(options.some((o) => o.includes('My private persona'))).toBe(false)
  })

  it('it starts with its agent’s skills: no checklist here', async () => {
    await render()
    expect(dialog().querySelector('[data-teammate-skills="agent"]')).not.toBeNull()
    expect(text()).toContain('It starts with its persona’s skills.')
    expect(Array.from(dialog().querySelectorAll('label')).some((l) => l.textContent?.includes('Summarize'))).toBe(false)
  })

  it('a refused create (RLS) shows its error in the dialog', async () => {
    writeResponse = { status: 500, body: { error: 'new row violates row-level security policy for table "ai_team_member"' } }
    await render()
    await typeName('Atlas')
    await pickPersona('PM persona')
    await click(button('Add to team'))
    expect(text()).toContain('row-level security')
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('editing an AI teammate', () => {
  it('is seeded from the teammate, with no face to pick', async () => {
    await render({ member: RILEY })
    expect(text()).toContain('Edit agent')
    expect(nameInput().value).toBe('Riley')
    expect(dialog().querySelector('[role="radio"]')).toBeNull()
    expect(personaSelect().textContent).toContain('Researcher persona')
    expect(personaSelect().disabled).toBe(false)
    // Nothing changed yet: nothing to save.
    expect(button('Save').disabled).toBe(true)
  })

  it('sends each changed field and nothing else', async () => {
    await render({ member: RILEY })
    await typeName('Riley (PM)')
    await pickPersona('PM persona')
    await click(button('Save'))
    expect(writes).toHaveLength(1)
    expect(writes[0].body).toEqual({ name: 'Riley (PM)', agent_recipe_id: 'r-2' })
  })

  it('its skills are its agent’s: shown, never ticked here, with the way to the agent’s editor', async () => {
    await render({ member: RILEY })
    expect(dialog().querySelector('[data-teammate-skills="agent"]')!.textContent).toContain('Summarize')
    expect(text()).toContain('Its skills are its persona’s, shared by every agent on it.')
    expect(dialog().querySelector('[data-open-agent-editor]')).not.toBeNull()
    expect(Array.from(dialog().querySelectorAll('label')).some((l) => l.textContent?.includes('Draft email'))).toBe(false)
  })

  it('a system teammate’s skills change here, up to five', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `k-${i}`, name: `Skill ${i}`, icon: null, color: null }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
        if (url === '/api/account/agents') return json(200, { agents: AGENTS })
        if (url === '/api/account/skills') return json(200, { skills: [...many, { id: 'k-mine', name: 'My own', icon: null, color: null, visibility: 'personal' }] })
        writes.push({ url, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) })
        return json(200, { success: true })
      }),
    )
    await render({ member: TRIAGE })
    // A personal skill is never offered.
    expect(text()).not.toContain('My own')
    const box = (name: string) =>
      Array.from(dialog().querySelectorAll('label')).find((l) => l.textContent?.includes(name))!.querySelector('button')!
    for (let i = 0; i < 5; i++) await click(box(`Skill ${i}`))
    expect(text()).toContain('5 of 5')
    expect((box('Skill 5') as HTMLButtonElement).disabled).toBe(true)
    await click(button('Save'))
    expect(writes[0].body).toEqual({ skill_recipe_ids: ['k-0', 'k-1', 'k-2', 'k-3', 'k-4'] })
  })

  it('sends a persona change on its own', async () => {
    await render({ member: RILEY })
    await pickPersona('PM persona')
    await click(button('Save'))
    expect(writes[0].body).toEqual({ agent_recipe_id: 'r-2' })
  })

  it('a system teammate’s persona is locked, with the reason; its name changes', async () => {
    await render({ member: TRIAGE })
    expect(personaSelect().disabled).toBe(true)
    expect(text()).toContain("A built-in agent runs a built-in loop, so its persona can't change.")

    await typeName('Sorter')
    await click(button('Save'))
    expect(writes).toEqual([
      { url: '/api/account/teams/team-1/ai-members/sys-triage', method: 'PATCH', body: { name: 'Sorter' } },
    ])
  })

  it('a loop’s work agent (fronts_only) has its persona locked to its loops, and never sends one; its name changes', async () => {
    const workBot: EditableAiMember = {
      id: 'ai-work-bot',
      name: 'Weekly brief',
      is_system: false,
      fronts_only: true,
      agent: null,
      agent_recipe_id: 'r-anchor',
      skills: [],
    }
    await render({ member: workBot })
    expect(personaSelect().disabled).toBe(true)
    expect(text()).toContain('This agent speaks for the loops it fronts, so it has no persona to change.')
    expect(text()).not.toContain('Built on a persona only its creator can see')

    await typeName('Ember')
    await click(button('Save'))
    expect(writes).toEqual([
      { url: '/api/account/teams/team-1/ai-members/ai-work-bot', method: 'PATCH', body: { name: 'Ember' } },
    ])
  })

  it('a user-built teammate’s persona has no lock or reason', async () => {
    await render({ member: RILEY })
    expect(text()).not.toContain('built-in loop, so its agent')
  })

  it('a refused edit (not an admin or lead) shows its error in the dialog', async () => {
    writeResponse = { status: 403, body: { error: 'Only workspace admins and this team’s leads can edit its AI teammates', code: 'FORBIDDEN' } }
    await render({ member: RILEY })
    await typeName('Riley (PM)')
    await click(button('Save'))
    expect(text()).toContain('Only workspace admins and this team’s leads can edit its AI teammates')
    expect(onSaved).not.toHaveBeenCalled()
    // Still open, and can try again.
    expect(button('Save').disabled).toBe(false)
  })
})

describe('editing: what the editor can’t read', () => {
  const skillBox = (name: string) =>
    Array.from(dialog().querySelectorAll('label')).find((l) => l.textContent?.includes(name))!.querySelector('button')!

  it('shows a private persona as "Private persona", selected, with why', async () => {
    await render({ member: QUILL })
    expect(personaSelect().textContent).toContain('Private persona')
    expect(personaSelect().disabled).toBe(false)
    expect(text()).toContain('Built on a persona only its creator can see. It stays unless you pick another.')
  })

  it('never sends the private persona back unless another is picked', async () => {
    await render({ member: QUILL })
    await typeName('Quill (Sales)')
    await click(button('Save'))
    expect(writes[0].body).toEqual({ name: 'Quill (Sales)' })
  })

  it('picking another persona re-points it, explicitly', async () => {
    await render({ member: QUILL })
    await pickPersona('PM persona')
    expect(text()).not.toContain('Built on a persona only its creator can see')
    await click(button('Save'))
    expect(writes[0].body).toEqual({ agent_recipe_id: 'r-2' })
  })

  it('counts a system teammate’s private skill under the list', async () => {
    await render({ member: SORTER })
    expect(text()).toContain('2 of 5')
    expect(text()).toContain('Also has 1 private skill only its creator can see. It stays as it is.')
  })

  it('sends a private skill back, in its place, when a readable one is ticked', async () => {
    await render({ member: SORTER })
    await click(skillBox('Draft email'))
    await click(button('Save'))
    expect(writes[0].body).toEqual({ skill_recipe_ids: ['s-private', 's-1', 's-2'] })
  })

  it('keeps a private skill when every readable one is unticked', async () => {
    await render({ member: SORTER })
    await click(skillBox('Summarize'))
    await click(button('Save'))
    expect(writes[0].body).toEqual({ skill_recipe_ids: ['s-private'] })
  })

  it('a teammate with nothing private says nothing about it', async () => {
    await render({ member: { ...RILEY, agent_recipe_id: 'r-1', skill_recipe_ids: ['s-1'] } })
    expect(text()).not.toContain('Private persona')
    expect(text()).not.toContain('private skill')
  })
})

describe('the dialog on a short window', () => {
  it('caps its height to the window and scrolls only its body', async () => {
    await render({ member: RILEY })
    const content = dialog()
    for (const cls of ['flex', 'flex-col', 'max-h-[calc(100dvh-2rem)]']) expect(content.classList).toContain(cls)
    const title = content.querySelector('h2')!
    const body = nameInput().closest('.overflow-y-auto') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.classList).toContain('min-h-0')
    // The title and the Save button sit outside the scrolling body.
    expect(body.contains(title)).toBe(false)
    expect(body.contains(button('Save'))).toBe(false)
  })
})
