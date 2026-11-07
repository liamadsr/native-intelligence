/**
 * Tripwire: the main chat's eve turn carries TEXT only. eve 0.66 stages every
 * file part of a user message into the session's sandbox
 * (stageAttachmentsToSandbox calls SandboxKey.get() for any file part, an
 * https URL included, provisioning a Vercel Sandbox microVM in production),
 * and the chat-agent is sandbox-free. A photo is named in the text and read
 * with read_chat_file instead (eveUserContent).
 *
 * The same rule for a run's chat: src/lib/agent-run/__tests__/run-chat-no-file-parts.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', '..', '..')
const TRANSPORT = 'src/lib/chat/eve/eve-chat-transport.ts'

/** Comment-free source: the file explains the rule in prose, which must not trip it. */
function code(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FILE_PART = /type:\s*['"`](file|image)['"`]/

describe('the main chat’s eve turn carries text only', () => {
  it('SELF-TEST: the pattern catches a planted file part', () => {
    expect(`return [{ type: 'text', text }, { type: 'file', data: url, mediaType }]`).toMatch(FILE_PART)
    expect('{ type: "image", image }').toMatch(FILE_PART)
  })

  it(TRANSPORT, () => {
    const src = code(TRANSPORT)
    expect(src.length).toBeGreaterThan(5000)
    expect(src).not.toMatch(FILE_PART)
    expect(src).not.toMatch(/\b(FilePart|ImagePart)\b/)
    // eveUserContent answers a string, never UserContent parts.
    expect(src).toMatch(/export function eveUserContent\([^)]*\): string \{/)
  })
})
