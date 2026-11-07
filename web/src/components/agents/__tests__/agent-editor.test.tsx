// @vitest-environment jsdom
/**
 * The one agent editor (bots-v4 B1): the agent, shared by its bots, and this
 * bot, its own. It names the other bots a save of the agent changes before
 * saving, offers "Make a copy for this bot", shows a locked field's reason,
 * keeps to five skills, and saves the agent first, then this bot, each
 * through its own route. "New agent" makes the agent and its bot together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentEditorData, EditorBot } from '@/lib/agents/editor-model'
import { FIELD_REASONS } from '@/lib/agents/editable-fields'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Radix reaches for browser APIs jsdom lacks.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

vi.mock('@/app/account/(dashboard)/settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('@/components/read-aloud/listen-brief', () => ({ ListenBrief: () => null }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() }) }))

const { AgentEditorDialog } = await import('../agent-editor')
const { toast } = await import('sonner')

const SKILLS = Array.from({ length: 7 }, (_, i) => ({
  id: `s${i + 1}`,
  name: `Skill ${i + 1}`,
  description: null,
  color: null,
  visibility: 'workspace',
}))

function bot(over: Partial<EditorBot>): EditorBot {
  return {
    id: 'riley',
    name: 'Riley',
    team_id: 'sales',
    team_name: 'Sales',
    bot_character: 'scout',
    is_system: false,
    system_key: null,
    fronts_only: false,
    role: null,
    autonomy: 'propose',
    allowed_side_effects: ['read'],
    skill_ids: ['s1'],
    kind: 'agent_teammate',
    about: null,
    ...over,
  }
}

function editorData(over: Partial<AgentEditorData> = {}): AgentEditorData {
  return {
    agent: {
      id: 'coach',
      name: 'Sales Coach',
      description: 'Coaches reps',
      system_prompt: 'Coach reps on calls.',
      agent_config: null,
      visibility: 'workspace',
      is_system: false,
      created_by: 'u-author',
      icon: null,
      color: null,
      kind: 'workspace',
    },
    bots: [bot({}), bot({ id: 'coach-bot', name: 'Coach', team_id: 'ops', team_name: 'Ops', kind: 'agent_work_bot', fronts_only: true })],
    hidden_bots: 1,
    focus: 'riley',
    caller: { user_id: 'u-owner', role: 'owner', lead_team_ids: [] },
    teams: [
      { id: 'sales', name: 'Sales', is_private: false },
      { id: 'ops', name: 'Ops', is_private: false },
    ],
    workspace_faces: [],
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let data: AgentEditorData
let writes: Array<{ url: string; method: string; body: Record<string, unknown> }>
let responses: Record<string, { status: number; body: unknown }>
const onClose = vi.fn()
const onSaved = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  data = editorData()
  // This test's own write log and canned answers, held by the stub below: a
  // test that ran out of time can still finish its save after the next one
  // starts, and its writes must not land in that test's log.
  const ownWrites: typeof writes = []
  const ownResponses: typeof responses = {}
  writes = ownWrites
  responses = ownResponses
  onClose.mockReset()
  onSaved.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      const method = init?.method ?? 'GET'
      if (method === 'GET') {
        if (url === '/api/account/skills') return json(200, { skills: SKILLS })
        if (url.startsWith('/api/account/agent-editor')) return json(200, data)
        if (url === '/api/account/flows/bots') return json(200, { teammates: [], free_characters: ['ember'] })
        return json(404, {})
      }
      ownWrites.push({ url, method, body: JSON.parse(String(init?.body ?? '{}')) })
      const canned = ownResponses[`${method} ${url}`]
      return canned ? json(canned.status, canned.body) : json(200, { success: true })
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function open(props: { agentId?: string; teammateId?: string; create?: boolean } = { agentId: 'coach' }) {
  await act(async () => root.render(<AgentEditorDialog open {...props} onClose={onClose} onSaved={onSaved} />))
  await act(async () => {})
  await act(async () => {})
}

const editor = () => document.body.querySelector('[data-agent-editor]') as HTMLElement
const text = () => (editor().textContent ?? '').replace(/\s+/g, ' ')
const field = (label: string) => editor().querySelector(`[data-editor-field="${label}"]`) as HTMLElement
const button = (label: string, scope: ParentNode = document.body) =>
  Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (el: HTMLElement) => act(async () => el.click())

describe('the agent, shared by every bot on it (decision 11)', () => {
  it('names the other bots before you save, and a change to the agent asks first', async () => {
    await open()
    expect(text()).toContain('Also used by Coach in Ops and 1 on a private team. A change to the persona changes them too.')
    await type(editor().querySelector('[data-agent-instructions]') as HTMLTextAreaElement, 'Coach reps on discovery calls.')
    await click(button('Save'))
    // Nothing written yet: the confirm names them and offers a copy.
    expect(writes).toEqual([])
    const confirm = document.body.querySelector('[data-editor-confirm]') as HTMLElement
    expect(confirm.textContent).toContain('This also changes Coach in Ops and 1 on a private team.')
    expect(button('Make a copy for this agent', confirm)).toBeTruthy()
    await click(button('Change it for all', confirm))
    expect(writes).toEqual([{ url: '/api/account/agents/coach', method: 'PATCH', body: { system_prompt: 'Coach reps on discovery calls.' } }])
    expect(onClose).toHaveBeenCalled()
  })

  it('"Make a copy for this bot" copies the agent, points this bot at it, then saves the change to the copy alone', async () => {
    responses['POST /api/account/agents/coach/copy'] = { status: 201, body: { agent: { id: 'copy-1' } } }
    await open()
    await type(editor().querySelector('[data-agent-instructions]') as HTMLTextAreaElement, 'Only for Riley.')
    await click(button('Save'))
    await click(button('Make a copy for this agent', document.body.querySelector('[data-editor-confirm]') as HTMLElement))
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      'POST /api/account/agents/coach/copy',
      'PATCH /api/account/teams/sales/ai-members/riley',
      'PATCH /api/account/agents/copy-1',
    ])
    expect(writes[0].body).toEqual({ name: 'Sales Coach for Riley' })
    expect(writes[1].body).toEqual({ agent_recipe_id: 'copy-1' })
    expect(writes[2].body).toEqual({ system_prompt: 'Only for Riley.' })
  })

  it('a field you may not change is read-only, with why; nothing to save', async () => {
    data = editorData({ caller: { user_id: 'u-member', role: 'member', lead_team_ids: [] } })
    await open()
    const instructions = editor().querySelector('[data-agent-instructions]') as HTMLTextAreaElement
    expect(instructions.disabled).toBe(true)
    expect(field('Instructions').textContent).toContain(FIELD_REASONS.agentAuthorOnly)
    expect(field('Name').textContent).toContain(FIELD_REASONS.botManagersOnly)
    expect(field('What it may change on its own').textContent).toContain(FIELD_REASONS.boundsOwnersOnly)
    expect(button('Save').disabled).toBe(true)
  })

  it('a built-in agent is read-only, and its bot can be split off with a copy', async () => {
    data = editorData({
      agent: { ...editorData().agent!, id: 'meeting', name: 'Meeting', is_system: true, created_by: null, kind: 'builtin' },
      bots: [bot({})],
      hidden_bots: 0,
    })
    await open({ agentId: 'meeting' })
    expect(field('Instructions').textContent).toContain(FIELD_REASONS.builtinAgent)
    expect(editor().querySelector('[data-make-copy]')).not.toBeNull()
  })

  it('keeps to five skills: the sixth can’t be added', async () => {
    data = editorData({ bots: [bot({ skill_ids: ['s1', 's2', 's3', 's4', 's5'] })], hidden_bots: 0 })
    await open()
    const add = editor().querySelector('[data-add-skill]') as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(add.textContent).toContain('Up to 5 skills')
    expect(editor().querySelector('[data-pinned-count]')!.textContent).toBe('5 of 5')
  })

  it('adds a skill and saves the list through the agent’s route, for every bot on it', async () => {
    data = editorData({ bots: [bot({})], hidden_bots: 0 })
    await open()
    await click(editor().querySelector('[data-add-skill]') as HTMLButtonElement)
    await click(editor().querySelector('[data-skill-choice="s3"]') as HTMLButtonElement)
    await click(button('Save'))
    expect(writes).toEqual([{ url: '/api/account/agents/coach/skills', method: 'PUT', body: { skill_recipe_ids: ['s1', 's3'] } }])
  })
})

describe('this bot, its own', () => {
  it('saves its name and its bounds through their own routes, after the agent', async () => {
    data = editorData({ bots: [bot({})], hidden_bots: 0 })
    await open()
    await type(editor().querySelector('[data-bot-name]') as HTMLInputElement, 'Rae')
    await click(editor().querySelector('[data-bounds-choice="internal"]') as HTMLButtonElement)
    await type(editor().querySelector('[data-agent-instructions]') as HTMLTextAreaElement, 'New words.')
    await click(button('Save'))
    expect(writes.map((w) => [w.method, w.url, w.body])).toEqual([
      ['PATCH', '/api/account/agents/coach', { system_prompt: 'New words.' }],
      ['PATCH', '/api/account/teams/sales/ai-members/riley', { name: 'Rae' }],
      ['PATCH', '/api/account/workspace/agent-autonomy/teammates/riley', { allowed_side_effects: ['read', 'internal-write'] }],
    ])
  })

  it('says what didn’t save when a later step is refused, and stays open', async () => {
    data = editorData({ bots: [bot({})], hidden_bots: 0 })
    responses['PATCH /api/account/teams/sales/ai-members/riley'] = { status: 403, body: { error: 'Only workspace admins and this team’s leads can edit its AI teammates' } }
    await open()
    await type(editor().querySelector('[data-agent-instructions]') as HTMLTextAreaElement, 'New words.')
    await type(editor().querySelector('[data-bot-name]') as HTMLInputElement, 'Rae')
    await click(button('Save'))
    expect(editor().querySelector('[data-editor-error]')!.textContent).toBe(
      'Saved the persona. Didn’t save this agent: Only workspace admins and this team’s leads can edit its AI teammates',
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a work bot keeps its team and its read-and-propose limits, with why', async () => {
    data = editorData({ focus: 'coach-bot' })
    await open({ teammateId: 'coach-bot' })
    expect(field('Team').textContent).toContain(FIELD_REASONS.workBotTeam)
    expect(field('What it may change on its own').textContent).toContain(FIELD_REASONS.workBotBounds)
  })

  it('a system teammate has no agent of its own: it says what it speaks from; its name changes', async () => {
    data = editorData({
      agent: null,
      bots: [bot({ id: 'triage', name: 'Triage', kind: 'system_teammate', is_system: true, system_key: 'triage', about: 'Decides what each capture’s proposals become', skill_ids: [] })],
      hidden_bots: 0,
      focus: 'triage',
    })
    await open({ teammateId: 'triage' })
    expect(editor().querySelector('[data-no-agent]')!.textContent).toContain(FIELD_REASONS.systemSpeaks)
    expect(editor().querySelector('[data-agent-instructions]')).toBeNull()
    expect(field('Team').textContent).toContain(FIELD_REASONS.systemTeam)
    await type(editor().querySelector('[data-bot-name]') as HTMLInputElement, 'Sorter')
    await click(button('Save'))
    expect(writes).toEqual([{ url: '/api/account/teams/sales/ai-members/triage', method: 'PATCH', body: { name: 'Sorter' } }])
  })

  it('a teammate built on an agent the caller can’t read says so, and keeps its own fields', async () => {
    data = editorData({ agent: null, bots: [bot({})], hidden_bots: 0 })
    await open({ teammateId: 'riley' })
    expect(editor().querySelector('[data-no-agent]')!.textContent).toContain(FIELD_REASONS.hiddenAgent)
    expect(editor().querySelector('[data-bot-name]')).not.toBeNull()
  })

  it('has no Voice field in the browser, where there are no voices (Phase B2; the desktop’s is bot-voice-field.test.tsx)', async () => {
    await open()
    expect(editor().querySelector('[data-editor-bot-fields]')).not.toBeNull()
    expect(field('Voice')).toBeNull()
    expect(editor().querySelector('[data-voice-choice]')).toBeNull()
  })
})

// A new agent opens with its tools section expanded (every tool category), the
// editor's heaviest render: about 0.45 s alone, past 5 s under full-suite load.
describe('New agent', { timeout: 20_000 }, () => {
  it('asks for no voice in the browser: its bot starts on Automatic', async () => {
    responses['POST /api/account/agents'] = { status: 200, body: { agent: { id: 'new-1', name: 'Coach' }, ai_team_member: { name: 'Coach' } } }
    await open({ create: true })
    expect(field('Voice')).toBeNull()
    await type(field('Name in Personas').querySelector('input') as HTMLInputElement, 'Coach')
    await click(button('Create'))
    expect(writes[0].body).not.toHaveProperty('voice')
  })

  it('makes the agent and its bot together, then pins its skills', async () => {
    responses['POST /api/account/agents'] = { status: 200, body: { agent: { id: 'new-1', name: 'Coach' }, ai_team_member: { name: 'Coach' } } }
    await open({ create: true })
    await type(field('Name in Personas').querySelector('input') as HTMLInputElement, 'Coach')
    await click(editor().querySelector('[data-add-skill]') as HTMLButtonElement)
    await click(editor().querySelector('[data-skill-choice="s2"]') as HTMLButtonElement)
    await click(button('Create'))
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual(['POST /api/account/agents', 'PUT /api/account/agents/new-1/skills'])
    // Its agent is made with it; the server hands it its face (none is picked).
    expect(writes[0].body).toMatchObject({ name: 'Coach', visibility: 'workspace' })
    expect(writes[0].body).not.toHaveProperty('bot_character')
    expect(writes[1].body).toEqual({ skill_recipe_ids: ['s2'] })
    expect(onSaved).toHaveBeenCalledWith({ agentId: 'new-1', created: true })
    // One vocabulary: the recipe is the persona (named in Personas), its teammate the agent.
    const said = vi.mocked(toast.success).mock.calls.map((c) => String(c[0]))
    expect(said).toContain('Persona “Coach” created')
    expect(said).toContain('Coach is under Agents now')
  })

  it('says the skills picked weren’t kept when its bot wasn’t made: they live on its bot', async () => {
    vi.mocked(toast.warning).mockClear()
    responses['POST /api/account/agents'] = { status: 200, body: { agent: { id: 'new-1', name: 'Coach' }, bot_error: 'Join a team first' } }
    await open({ create: true })
    await type(field('Name in Personas').querySelector('input') as HTMLInputElement, 'Coach')
    await click(editor().querySelector('[data-add-skill]') as HTMLButtonElement)
    await click(editor().querySelector('[data-skill-choice="s2"]') as HTMLButtonElement)
    await click(button('Create'))
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual(['POST /api/account/agents'])
    const warned = vi.mocked(toast.warning).mock.calls.map((c) => String(c[0]))
    expect(warned).toContain('Its agent wasn’t made: Join a team first')
    expect(warned.some((w) => /skills you picked weren’t kept: they live on its agent, which wasn’t made/.test(w))).toBe(true)
  })
})
