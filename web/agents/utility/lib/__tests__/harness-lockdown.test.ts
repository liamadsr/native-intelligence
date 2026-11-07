/**
 * Structural harness contract for the utility mount (WS-4).
 *
 * The utility agent runs one-shot generations with NO tools at all. Every eve
 * framework default that can act — the sandbox-backed bash/read_file/
 * write_file, web_search, web_fetch and the root-copy `agent` — is a
 * disableTool() sentinel. eve 0.76 retired the `load_skill` and `task_cancel`
 * slots (skills load through `eve__skill`, added only with a skill; task
 * control is `eve__task_*`, added only with a task-running tool), so this
 * skill-less, agent-less mount gets neither and has no file at either old
 * slug: one there would be an ordinary tool. Web is off here, unlike every other Dial8
 * agent: these prompts are workspace data written back into the workspace, so
 * a fetched page could only be an injection vector.
 *
 * Disabling the sandbox-backed TOOLS does not mean no sandbox: eve still
 * provisions the agent's sandbox to stage a task message's file parts
 * (reference_ingest_* sends a PDF — harness/attachment-staging.js). What this
 * lockdown guarantees is that no session can reach it: no tool that runs a
 * command in it, reads from it or writes to it is enabled.
 *
 * glob/grep are not eve defaults (dropped at 0.39.0): a file at either slug
 * would opt the tool back IN, so the lockdown asserts ABSENCE.
 *
 * src/lib/eve/__tests__/default-tools.test.ts separately fails if eve's default
 * set changes or if this agent inherits a default without a file.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import rootCopyAgent from '../../tools/agent'
import bash from '../../tools/bash'
import readFile from '../../tools/read_file'
import webFetch from '../../tools/web_fetch'
import webSearch from '../../tools/web_search'
import writeFile from '../../tools/write_file'

const DISABLED = {
  agent: rootCopyAgent,
  bash,
  read_file: readFile,
  web_fetch: webFetch,
  web_search: webSearch,
  write_file: writeFile,
}

const toolsDir = fileURLToPath(new URL('../../tools/', import.meta.url))

describe('utility — every framework default is structurally disabled', () => {
  for (const [name, mod] of Object.entries(DISABLED)) {
    it(`${name} is a disableTool() sentinel`, () => {
      expect(isDisabledToolSentinel(mod)).toBe(true)
    })
  }

  it('tools/ holds ONLY those sentinels — no authored tool exists on this agent', () => {
    const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts')).sort()
    expect(files).toEqual(Object.keys(DISABLED).map((n) => `${n}.ts`).sort())
  })

  for (const slug of ['glob', 'grep', 'load_skill', 'task_cancel']) {
    it(`${slug} has NO file at its slug (a file would opt it back in)`, () => {
      expect(existsSync(`${toolsDir}${slug}.ts`)).toBe(false)
    })
  }
})
