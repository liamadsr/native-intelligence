import { describe, it, expect, vi } from 'vitest'
import type { EveSpec } from '../spec-client'

/**
 * The skill-runner's screenshot proxies (lib/screenshot-output.ts): the base64 leaves
 * the JSON, and rides as an image part only for a model that reads one. The
 * helper itself is covered in agents/chat-agent/lib/__tests__/screenshot-output.test.ts.
 */
const fetchEveSpec = vi.fn<(t: string) => Promise<EveSpec | null>>()

vi.mock('../spec-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spec-client')>()),
  fetchEveSpec: (t: string) => fetchEveSpec(t),
  dispatchWorkspaceTool: async () => ({ ok: true }),
  runTokenFromAuth: () => 'tok.sig',
}))

import workspaceTools from '../../tools/workspace_tools'

type Shaped = { toModelOutput?: (o: unknown) => { type: string; value: unknown } }
type Resolver = {
  events: { 'session.started': (e: unknown, ctx: { session: { auth: unknown } }) => Promise<Record<string, Shaped> | null> }
}
const SHOT = { success: true, result: { screenshotBase64: 'QUJD', mediaType: 'image/jpeg' } }

async function tools(model: string) {
  fetchEveSpec.mockResolvedValue({
    model,
    webAccess: true,
    ceilingTools: [
      { name: 'screenshot_browser', description: 'Screenshot the tab.' },
      { name: 'list_actions', description: 'List actions.' },
    ],
  } as unknown as EveSpec)
  return (await (workspaceTools as unknown as Resolver).events['session.started']({}, { session: { auth: {} } }))!
}

describe('skill-runner workspace_tools — browser screenshots', () => {
  it('a Claude run gets the image as a file part, with no base64 in the text', async () => {
    const out = (await tools('anthropic/claude-sonnet-4.5')).screenshot_browser.toModelOutput!(SHOT)
    expect(out.type).toBe('content')
    expect(JSON.stringify((out.value as unknown[])[0])).not.toContain('QUJD')
    expect((out.value as unknown[])[1]).toMatchObject({ type: 'file', mediaType: 'image/jpeg' })
  })

  it('a DeepSeek run gets a note instead, and other proxies keep the default output', async () => {
    const t = await tools('deepseek/deepseek-v4-flash')
    const out = t.screenshot_browser.toModelOutput!(SHOT)
    expect(out.type).toBe('json')
    expect(JSON.stringify(out)).not.toContain('QUJD')
    expect(t.list_actions.toModelOutput).toBeUndefined()
  })
})
