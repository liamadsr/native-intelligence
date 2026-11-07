// @vitest-environment jsdom
/**
 * A bot's voice in the one agent editor, in the desktop app (bots-v4 Phase
 * B2; the browser, where the field hides, is agent-editor.test.tsx):
 *
 *   • the field lists the desktop's voices (`tts_voices`) and Automatic, on
 *     the voice the bot saved; a pick saves through this bot's own route, and
 *     only there: never the agent's, so it reaches no other bot (decision 11);
 *     back to Automatic saves null;
 *   • a voice another bot in the workspace chose is said ("Also used by"),
 *     never refused;
 *   • a voice this Mac doesn't have stays chosen, says so, stays on offer
 *     after trying another, and its sample plays what Automatic gives it here;
 *   • Automatic says what it does: a voice the other bots on screen aren't
 *     using, or, beside another bot on its face that chose one, that voice
 *     (one face speaks one voice), and its sample plays it;
 *   • the arrow keys (Home, End) move the pick, and Tab reaches only the one
 *     picked;
 *   • a save tells the shared source to reload, here and in the app's other
 *     windows, so the bots speak in the new voice straight away;
 *   • "Hear it" says a line in the voice picked (`tts_speak { voice }`), or in
 *     the one Automatic gives it now; Stop stops it; a refusal says why; it
 *     waits out a capture;
 *   • someone who may not change the bot hears it but can't pick;
 *   • "New agent" and "Give it a bot" make the bot in the voice picked;
 *   • a desktop that lists no voices shows no field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TtsStatePayload } from '@/lib/tauri-bridge'
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

const VOICES = ['aba', 'cha', 'ush', 'chichi', 'lori', 'lowli', 'tana', 'milton'].map((id) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  description: '',
  default: id === 'tana',
}))

const env = vi.hoisted(() => ({
  voices: [] as Array<{ id: string; name: string; description: string; default: boolean }>,
  speaks: [] as Array<{ id: string; text: string; voice?: string }>,
  cancels: 0,
  refuse: null as unknown,
  tts: new Set<(p: TtsStatePayload) => void>(),
  recording: false,
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/hooks/recording-context', () => ({
  useOptionalRecordingStable: () => ({ isRecording: env.recording, isStarting: false }),
}))
vi.mock('@/lib/tauri-bridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/tauri-bridge')>()
  return {
    ...original,
    tauriBridge: {
      ...original.tauriBridge,
      ttsVoices: async () => env.voices,
      ttsSpeak: async (args: { id: string; text: string; voice?: string }) => {
        if (env.refuse) throw env.refuse
        env.speaks.push(args)
      },
      ttsCancel: async () => {
        env.cancels += 1
      },
      onTtsState: (cb: (p: TtsStatePayload) => void) => {
        env.tts.add(cb)
        return () => env.tts.delete(cb)
      },
    },
  }
})
vi.mock('@/app/account/(dashboard)/settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('@/components/read-aloud/listen-brief', () => ({ ListenBrief: () => null }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() }) }))

const { AgentEditorDialog } = await import('../agent-editor')
const { radioStep } = await import('../bot-voice-field')
const { TtsRefusedError } = await import('@/lib/tauri-bridge')
const { __resetBotVoicesForTests, setBotVoiceCrew, voiceForCharacter } = await import('@/lib/bots/bot-voice')
const { TEAMMATES_CHANGED_EVENT, TEAMMATES_CHANGED_KEY } = await import('@/lib/bots/teammates-changed')

function bot(over: Partial<EditorBot>): EditorBot {
  return {
    id: 'riley',
    name: 'Riley',
    team_id: 'sales',
    team_name: 'Sales',
    bot_character: 'scout',
    voice: null,
    is_system: false,
    system_key: null,
    fronts_only: false,
    role: null,
    autonomy: 'propose',
    allowed_side_effects: ['read'],
    skill_ids: [],
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
    // Another bot on the same agent: a voice edit must not reach it.
    bots: [bot({}), bot({ id: 'coach-bot', name: 'Coach', team_id: 'ops', team_name: 'Ops', kind: 'agent_work_bot', fronts_only: true, voice: 'cha' })],
    hidden_bots: 0,
    focus: 'riley',
    caller: { user_id: 'u-owner', role: 'owner', lead_team_ids: [] },
    teams: [{ id: 'sales', name: 'Sales', is_private: false }],
    workspace_faces: [
      { id: 'riley', name: 'Riley', bot_character: 'scout' },
      { id: 'coach-bot', name: 'Coach', bot_character: 'ember', voice: 'cha' },
      { id: 'writer', name: 'Writer', bot_character: 'writer', voice: 'lori' },
      { id: 'hidden', name: null, bot_character: 'dew', voice: 'lori' },
    ],
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let data: AgentEditorData
let writes: Array<{ url: string; method: string; body: Record<string, unknown> }>
let responses: Record<string, { status: number; body: unknown }>
const onClose = vi.fn()

beforeEach(() => {
  __resetBotVoicesForTests()
  env.voices = VOICES
  env.speaks = []
  env.cancels = 0
  env.refuse = null
  env.tts.clear()
  env.recording = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  data = editorData()
  writes = []
  responses = {}
  onClose.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      const method = init?.method ?? 'GET'
      if (method === 'GET') {
        if (url === '/api/account/skills') return json(200, { skills: [] })
        if (url.startsWith('/api/account/agent-editor')) return json(200, data)
        if (url === '/api/account/flows/bots') return json(200, { teammates: [], free_characters: ['ember'] })
        return json(404, {})
      }
      writes.push({ url, method, body: JSON.parse(String(init?.body ?? '{}')) })
      const canned = responses[`${method} ${url}`]
      return canned ? json(canned.status, canned.body) : json(200, { success: true })
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function open(props: { agentId?: string; teammateId?: string; create?: boolean } = { teammateId: 'riley' }) {
  await act(async () => root.render(<AgentEditorDialog open {...props} onClose={onClose} />))
  for (let i = 0; i < 4; i++) await act(async () => {})
}

const editor = () => document.body.querySelector('[data-agent-editor]') as HTMLElement
const field = (label: string) => editor().querySelector(`[data-editor-field="${label}"]`) as HTMLElement | null
const choice = (id: string) => editor().querySelector(`[data-voice-choice="${id}"]`) as HTMLButtonElement | null
const checked = () => [...editor().querySelectorAll('[data-voice-choice][aria-checked="true"]')].map((b) => b.getAttribute('data-voice-choice'))
const sample = () => editor().querySelector('[data-voice-sample]') as HTMLButtonElement
const button = (label: string) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement
const click = async (el: HTMLElement) => act(async () => el.click())
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the Voice field, in the desktop app', () => {
  it('lists the desktop’s voices and Automatic, on the voice the bot saved', async () => {
    data = editorData({ bots: [bot({ voice: 'lowli' })] })
    await open()
    expect(field('Voice')).not.toBeNull()
    expect([...editor().querySelectorAll('[data-voice-choice]')].map((b) => b.textContent)).toEqual(['Automatic', ...VOICES.map((v) => v.name)])
    expect(checked()).toEqual(['lowli'])
    expect(editor().querySelector('[role="radiogroup"]')!.getAttribute('aria-labelledby')).toBeTruthy()
  })

  it('a pick saves through this bot’s own route, and nowhere else: the agent’s other bot keeps its voice (decision 11)', async () => {
    await open()
    expect(checked()).toEqual(['automatic'])
    await click(choice('ush')!)
    expect(checked()).toEqual(['ush'])
    await click(button('Save'))
    // No confirm: nothing of the agent's changed.
    expect(document.body.querySelector('[data-editor-confirm]')).toBeNull()
    expect(writes).toEqual([{ url: '/api/account/teams/sales/ai-members/riley', method: 'PATCH', body: { voice: 'ush' } }])
    expect(onClose).toHaveBeenCalled()
  })

  it('back to Automatic saves null', async () => {
    data = editorData({ bots: [bot({ voice: 'lowli' })] })
    await open()
    await click(choice('automatic')!)
    await click(button('Save'))
    expect(writes).toEqual([{ url: '/api/account/teams/sales/ai-members/riley', method: 'PATCH', body: { voice: null } }])
  })

  it('a work bot’s voice saves through the work-bot route', async () => {
    data = editorData({ focus: 'coach-bot' })
    await open({ teammateId: 'coach-bot' })
    expect(checked()).toEqual(['cha'])
    await click(choice('aba')!)
    await click(button('Save'))
    expect(writes).toEqual([{ url: '/api/account/work-bots/coach-bot', method: 'PATCH', body: { voice: 'aba' } }])
  })

  it('says which other bots chose the voice picked, and lets it be', async () => {
    await open()
    expect(editor().querySelector('[data-voice-used-by]')).toBeNull()
    await click(choice('lori')!)
    expect(editor().querySelector('[data-voice-used-by]')!.textContent).toBe('Also used by Writer and a teammate on a private team. Agents can share a voice.')
    await click(choice('cha')!)
    expect(editor().querySelector('[data-voice-used-by]')!.textContent).toBe('Also used by Coach. Agents can share a voice.')
    await click(button('Save'))
    expect(writes).toEqual([{ url: '/api/account/teams/sales/ai-members/riley', method: 'PATCH', body: { voice: 'cha' } }])
  })

  it('a voice this Mac doesn’t have stays chosen, says so, and its sample plays what Automatic gives it here', async () => {
    env.voices = VOICES.filter((v) => v.id !== 'milton')
    data = editorData({ bots: [bot({ voice: 'milton' })] })
    await open()
    expect(checked()).toEqual(['milton'])
    expect(choice('milton')!.textContent).toBe('milton (not on this Mac)')
    expect(editor().querySelector('[data-voice-note="missing"]')).not.toBeNull()
    await click(sample())
    expect(env.speaks).toHaveLength(1)
    expect(env.speaks[0].voice).toBe(voiceForCharacter('scout', env.voices))
    // Nothing changed, nothing to save.
    expect(button('Save').disabled).toBe(true)
  })

  it('“Hear it” says a line in the voice picked; Stop stops it', async () => {
    await open()
    await click(choice('lori')!)
    await click(sample())
    expect(env.speaks).toEqual([{ id: expect.stringMatching(/^bot-voice-sample:/), text: 'Hi, I’m Riley. This is how I’ll sound.', voice: 'lori' }])
    // Started: Stop.
    await act(async () => {
      for (const cb of [...env.tts]) cb({ id: env.speaks[0].id, state: 'speaking' })
    })
    expect(sample().textContent).toBe('Stop')
    const before = env.cancels
    await click(sample())
    expect(env.cancels).toBe(before + 1)
    expect(sample().textContent).toBe('Hear it')
    // Done on its own: Hear it again.
    await click(sample())
    await act(async () => {
      for (const cb of [...env.tts]) cb({ id: env.speaks[1].id, state: 'done' })
    })
    expect(sample().textContent).toBe('Hear it')
  })

  it('on Automatic, says it picks a voice the other bots on screen aren’t using, and the sample plays the one it gets now', async () => {
    await open()
    expect(editor().querySelector('[data-voice-note="automatic"]')!.textContent).toBe(
      'Automatic picks a voice the other agents aren’t using, while there are enough to go round.',
    )
    await click(sample())
    expect(env.speaks[0].voice).toBe(voiceForCharacter('scout', VOICES))
  })

  it('on Automatic beside another bot on its face that chose a voice, says it speaks in that one, and plays it', async () => {
    // Another teammate wearing this face (in another workspace, say) chose Lori: one face speaks one voice.
    setBotVoiceCrew(['scout'], new Map([['scout', ['lori']]]))
    await open()
    expect(editor().querySelector('[data-voice-note="shared"]')!.textContent).toBe(
      'Another agent like it chose Lori, so on Automatic it speaks in that voice too.',
    )
    await click(sample())
    expect(env.speaks[0].voice).toBe('lori')
  })

  it('its own saved voice isn’t “another bot’s”: switching it to Automatic says and plays the deal', async () => {
    data = editorData({ bots: [bot({ voice: 'lori' })] })
    // The crew holds this bot's own choice on its face.
    setBotVoiceCrew(['scout'], new Map([['scout', ['lori']]]))
    await open()
    await click(choice('automatic')!)
    expect(editor().querySelector('[data-voice-note="automatic"]')).not.toBeNull()
    expect(editor().querySelector('[data-voice-note="shared"]')).toBeNull()
    await click(sample())
    expect(env.speaks[0].voice).toBe(voiceForCharacter('scout', VOICES))
  })

  it('the arrow keys move the pick and the focus; Tab reaches only the one picked', async () => {
    data = editorData({ bots: [bot({ voice: 'aba' })] })
    await open()
    const tabbable = () => [...editor().querySelectorAll<HTMLButtonElement>('[data-voice-choice]')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.voiceChoice)
    expect(tabbable()).toEqual(['aba'])
    const key = async (k: string) => {
      const focused = document.activeElement as HTMLElement
      await act(async () => focused.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
    }
    choice('aba')!.focus()
    await key('ArrowRight')
    expect(checked()).toEqual(['cha'])
    expect((document.activeElement as HTMLElement).dataset.voiceChoice).toBe('cha')
    expect(tabbable()).toEqual(['cha'])
    await key('ArrowLeft')
    await key('ArrowUp')
    expect(checked()).toEqual(['automatic'])
    await key('End')
    expect(checked()).toEqual(['milton'])
    // Round from the last to the first.
    await key('ArrowDown')
    expect(checked()).toEqual(['automatic'])
    await key('Home')
    expect(checked()).toEqual(['automatic'])
    await key('Enter')
    expect(checked()).toEqual(['automatic'])
    expect(radioStep('ArrowLeft', 0, 3)).toBe(2)
    expect(radioStep('a', 0, 3)).toBeNull()
    expect(radioStep('ArrowRight', 0, 0)).toBeNull()
  })

  it('a saved voice this Mac doesn’t have stays on offer after trying another, to go back to', async () => {
    env.voices = VOICES.filter((v) => v.id !== 'milton')
    data = editorData({ bots: [bot({ voice: 'milton' })] })
    await open()
    await click(choice('aba')!)
    expect(checked()).toEqual(['aba'])
    expect(choice('milton')!.textContent).toBe('milton (not on this Mac)')
    expect(editor().querySelector('[data-voice-note="missing"]')).toBeNull()
    await click(choice('milton')!)
    expect(checked()).toEqual(['milton'])
    expect(button('Save').disabled).toBe(true)
  })

  it('a save tells the bots to reload, here and in the app’s other windows; a save that wrote nothing doesn’t', async () => {
    const heard = vi.fn()
    window.addEventListener(TEAMMATES_CHANGED_EVENT, heard)
    try {
      localStorage.removeItem(TEAMMATES_CHANGED_KEY)
      responses['PATCH /api/account/teams/sales/ai-members/riley'] = { status: 403, body: { error: 'Only workspace admins and this team’s leads can edit its AI teammates' } }
      await open()
      await click(choice('lori')!)
      await click(button('Save'))
      expect(editor().querySelector('[data-editor-error]')).not.toBeNull()
      expect(heard).not.toHaveBeenCalled()
      expect(localStorage.getItem(TEAMMATES_CHANGED_KEY)).toBeNull()
      delete responses['PATCH /api/account/teams/sales/ai-members/riley']
      await click(button('Save'))
      expect(writes.at(-1)).toEqual({ url: '/api/account/teams/sales/ai-members/riley', method: 'PATCH', body: { voice: 'lori' } })
      expect(heard).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem(TEAMMATES_CHANGED_KEY)).toBeTruthy()
    } finally {
      window.removeEventListener(TEAMMATES_CHANGED_EVENT, heard)
    }
  })

  it('a refusal says why; a capture recording holds it', async () => {
    env.refuse = new TtsRefusedError('not_ready')
    await open()
    await click(sample())
    expect(editor().querySelector('[data-voice-sample-error]')!.textContent).toBe('Read aloud isn’t set up on this Mac yet: Settings → Voice.')
    expect(sample().textContent).toBe('Hear it')
    act(() => root.unmount())
    env.recording = true
    root = createRoot(container)
    await open()
    expect(sample().disabled).toBe(true)
  })

  it('someone who may not change the bot hears it, but can’t pick', async () => {
    data = editorData({ caller: { user_id: 'u-member', role: 'member', lead_team_ids: [] } })
    await open()
    expect(choice('lori')!.disabled).toBe(true)
    expect(field('Voice')!.textContent).toContain(FIELD_REASONS.botManagersOnly)
    expect(sample().disabled).toBe(false)
  })

  it('a desktop that lists no voices shows no field', async () => {
    env.voices = []
    await open()
    expect(editor().querySelector('[data-editor-bot-fields]')).not.toBeNull()
    expect(field('Voice')).toBeNull()
  })
})

describe('a new bot, in the voice picked', () => {
  it('“New agent” makes the agent and its bot in the voice picked', async () => {
    responses['POST /api/account/agents'] = { status: 200, body: { agent: { id: 'new-1', name: 'Coach' }, ai_team_member: { name: 'Coach' } } }
    await open({ create: true })
    await type(field('Name in Personas')!.querySelector('input') as HTMLInputElement, 'Coach')
    expect(checked()).toEqual(['automatic'])
    await click(choice('chichi')!)
    await click(button('Create'))
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual(['POST /api/account/agents'])
    expect(writes[0].body).toMatchObject({ name: 'Coach', voice: 'chichi' })
    expect(writes[0].body).not.toHaveProperty('bot_character')
  })

  it('“Give it a bot” makes it in the voice picked', async () => {
    data = editorData({ bots: [], focus: null, caller: { user_id: 'u-author', role: 'member', lead_team_ids: [] } })
    responses['POST /api/account/agents/coach/bot'] = { status: 201, body: { ai_team_member: { id: 'new-bot' } } }
    await open({ agentId: 'coach' })
    await click(editor().querySelector('[data-give-bot]') as HTMLButtonElement)
    await click(choice('tana')!)
    await click(button('Save'))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ url: '/api/account/agents/coach/bot', method: 'POST', body: { voice: 'tana' } })
    // No face picked: the server hands it the first nobody in the workspace wears.
    expect(writes[0].body).not.toHaveProperty('bot_character')
  })
})
