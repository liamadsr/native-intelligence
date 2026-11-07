/**
 * Structural harness contract for the web-research mount: OpenAI's web search
 * and nothing else. Every other eve framework default that can act (the
 * sandbox-backed bash/read_file/write_file, web_fetch and the root-copy
 * `agent`) is a disableTool() sentinel, and web_search is eve's provided
 * search (OpenAI's own, since every step runs on the plan's search model).
 * glob/grep and the retired load_skill/task_cancel slots have no file: one
 * there would opt a tool back in.
 *
 * src/lib/eve/__tests__/default-tools.test.ts separately fails if eve's default
 * set changes or if this agent inherits a default without a file.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import { isWebSearchToolDefinition } from 'eve/tools/web_search'
import rootCopyAgent from '../../tools/agent'
import bash from '../../tools/bash'
import readFile from '../../tools/read_file'
import webFetch from '../../tools/web_fetch'
import webSearch from '../../tools/web_search'
import writeFile from '../../tools/write_file'

const DISABLED = { agent: rootCopyAgent, bash, read_file: readFile, web_fetch: webFetch, write_file: writeFile }
const toolsDir = fileURLToPath(new URL('../../tools/', import.meta.url))

describe('web-research — web search and nothing else', () => {
  for (const [name, mod] of Object.entries(DISABLED)) {
    it(`${name} is a disableTool() sentinel`, () => {
      expect(isDisabledToolSentinel(mod)).toBe(true)
    })
  }

  it("web_search is eve's provided search, the model's own (native)", () => {
    expect(isWebSearchToolDefinition(webSearch)).toBe(true)
    expect((webSearch as { provider: string }).provider).toBe('native')
  })

  it('tools/ holds only those files — no authored tool exists on this agent', () => {
    const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts')).sort()
    expect(files).toEqual([...Object.keys(DISABLED), 'web_search'].map((n) => `${n}.ts`).sort())
  })

  for (const slug of ['glob', 'grep', 'load_skill', 'task_cancel']) {
    it(`${slug} has NO file at its slug (a file would opt it back in)`, () => {
      expect(existsSync(`${toolsDir}${slug}.ts`)).toBe(false)
    })
  }
})
