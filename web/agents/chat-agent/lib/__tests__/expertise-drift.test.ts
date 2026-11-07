/**
 * The chat-agent attaches an expertise pack under EXPERTISE_FIELD, and the
 * browser's transport drops MODEL_ONLY_TOOL_FIELDS before a tool part is drawn
 * or saved. The eve bundler can't share the constant across the boundary, so
 * this keeps the two names equal: rename one alone and the pack would show up
 * in the chat.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_ONLY_TOOL_FIELDS } from '@/lib/chat/eve/tool-output-truncation'

describe('expertise field drift', () => {
  it('the field the chat-agent writes is one the transport strips', () => {
    const src = readFileSync(join(__dirname, '../expertise.ts'), 'utf8')
    const field = /export const EXPERTISE_FIELD = '([^']+)'/.exec(src)?.[1]
    expect(field).toBeTruthy()
    expect(MODEL_ONLY_TOOL_FIELDS).toContain(field)
  })
})
