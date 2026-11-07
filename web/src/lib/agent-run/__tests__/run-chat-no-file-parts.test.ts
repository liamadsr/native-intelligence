/**
 * Tripwire (bots v4 review): NO file part, and no bytes, ever reach a run
 * chat's turn. eve 0.66 stages every file part of a user message into the
 * session's sandbox (stageAttachmentsToSandbox calls SandboxKey.get() for any
 * file part, provisioning a Vercel Sandbox microVM in production) and keeps an
 * `eve-sandbox:` reference that every later model call reads back. The
 * work-agent and the skill-runner are sandbox-free by design. So the turn
 * builder and both run-chat routes may build TEXT parts only.
 *
 * Behaviour is pinned in run-chat-turn.test.ts (expectNoFileOrBytes over every
 * kind of file); this pins the source, so a later change can't quietly add a
 * file part, an image part, or inline bytes to the path.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', '..')
const FILES = [
  'src/lib/agent-run/run-chat-turn.ts',
  'src/lib/agent-run/run-chat-attachments.ts',
  'src/app/api/account/agent-runs/[id]/chat/route.ts',
  'src/app/api/account/activity/[id]/chat/route.ts',
]

/** Comment-free source: the files explain the rule in prose, which must not trip it. */
function code(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FILE_PART = /type:\s*['"`](file|image)['"`]/

describe('a run chat’s turn carries text parts only', () => {
  it('SELF-TEST: the patterns catch a planted file part and inline bytes', () => {
    expect(`const part = { type: 'file', data: url, mediaType }`).toMatch(FILE_PART)
    expect("{ type: \"image\", image }").toMatch(FILE_PART)
    expect('`data:${type};base64,${b64}`').toMatch(/base64/i)
    // Comments don't count: the rule is explained in prose.
    expect(code('src/lib/agent-run/run-chat-turn.ts')).not.toContain('stageAttachmentsToSandbox')
  })

  for (const path of FILES) {
    it(path, () => {
      const src = code(path)
      expect(src.length).toBeGreaterThan(500)
      // No file or image part is built…
      expect(src).not.toMatch(FILE_PART)
      expect(src).not.toMatch(/\b(FilePart|ImagePart)\b/)
      // …and no bytes are inlined.
      expect(src).not.toMatch(/base64/i)
      expect(src).not.toMatch(/data:\$\{/)
      expect(src).not.toMatch(/toString\(\s*['"`]base64['"`]\s*\)/)
    })
  }
})
