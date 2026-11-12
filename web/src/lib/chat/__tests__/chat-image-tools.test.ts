// Which tools may hand a picture to the main chat's agent. The agent's proxy turns the image keys into a picture
// only for the tools on its own list (agents/chat-agent/lib/chat-image-output.ts); from any other tool they would
// reach the model as text. The app's route drops them for every tool not on the same list: the two lists are one.
import { describe, expect, it } from 'vitest'
import { CHAT_IMAGE_TOOL_NAMES } from '../../../../agents/chat-agent/lib/chat-image-output'
import { CHAT_IMAGE_TOOLS, sanitizeOutput } from '../chat-tool-dispatch'

describe('pictures in tool answers to the main chat', () => {
  it("the route's list is the agent's list", () => {
    expect([...CHAT_IMAGE_TOOLS].sort()).toEqual([...CHAT_IMAGE_TOOL_NAMES].sort())
  })

  it('a tool on the list keeps its picture', () => {
    const out = { success: true, __imageBase64: 'AAAA', __imageMimeType: 'image/jpeg' }
    expect(sanitizeOutput('wait_for_studio_job', out)).toBe(out)
    expect(sanitizeOutput('render_studio_stills', out)).toBe(out)
    expect(sanitizeOutput('read_chat_file', out)).toBe(out)
  })

  it('any other tool loses it, and keeps the rest of its answer', () => {
    const out = { success: true, report: 'two moves', __imageBase64: 'AAAA', __imageMimeType: 'image/png' }
    expect(sanitizeOutput('get_studio_job', out)).toEqual({ success: true, report: 'two moves' })
    expect(sanitizeOutput('get_attachment_content', out)).toEqual({ success: true, report: 'two moves' })
  })

  it('an answer without a picture comes back as it was, whatever its shape', () => {
    const list = [1, 2, 3]
    const plain = { success: true }
    expect(sanitizeOutput('list_actions', list)).toBe(list)
    expect(sanitizeOutput('list_actions', plain)).toBe(plain)
    expect(sanitizeOutput('list_actions', 'text')).toBe('text')
    expect(sanitizeOutput('list_actions', null)).toBe(null)
  })
})
