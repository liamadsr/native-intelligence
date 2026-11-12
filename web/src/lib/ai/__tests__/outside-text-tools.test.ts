/**
 * Untrusted labels everywhere (A5 slice 4): every tool that returns text
 * someone outside wrote wraps it inside its own result. This holds the list
 * (src/lib/ai/outside-text-tools.ts) to the code, in three directions:
 *   1. each listed tool exists in the registry and its own definition calls
 *      its fence;
 *   2. each registry tool whose NAME looks like it reads outside text is in
 *      the list or in NOT_OUTSIDE_TEXT_TOOLS with a reason, so a new one can't
 *      land unlabeled without someone deciding;
 *   3. the paths outside src/lib/ai/tools: external MCP results go through
 *      fenceMcpContent, and every agent that keeps eve's web_fetch wraps it.
 * Each fence's behaviour has its own test (calendar-event-for-model,
 * fence-readings, mcp-content-fence, untrusted*, captures-transcript-paging).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_TOOL_NAMES } from '../tool-registry'
import { NOT_OUTSIDE_TEXT_TOOLS, OUTSIDE_TEXT_TOOLS, PROVIDER_EXECUTED_UNWRAPPED } from '../outside-text-tools'

const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/**
 * A tool's own block in its file: from `  <name>: tool(` (or
 * `Object.assign(tool(`) to the next tool definition at the same indent.
 */
function toolBlock(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(\\s+)${name}: (?:Object\\.assign\\()?tool\\(`))
  if (start < 0) return ''
  const rest = source.slice(start + 1)
  const indent = /^(\s+)/.exec(rest)?.[1] ?? ''
  const next = rest.slice(1).search(new RegExp(`\\n${indent}[a-z_]+: (?:Object\\.assign\\()?tool\\(`))
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/**
 * Names that look like they read someone else's text. The CRM and prospecting
 * part (contact, compan, prospect) covers what web enrichment and prospecting
 * read off public pages (src/lib/ai/tools/web-derived.ts).
 */
const OUTSIDE_TEXT_NAME = /email|browser|attachment|transcript|calendar|chat_file|web|inbox|fetch|contact|compan|prospect/

describe('outside-text tools wrap what they return', () => {
  for (const [name, entry] of Object.entries(OUTSIDE_TEXT_TOOLS)) {
    it(`${name} is a registry tool whose definition calls its fence (${entry.fence.join(' / ')})`, () => {
      expect(ALL_TOOL_NAMES).toContain(name)
      const block = toolBlock(read(entry.file), name)
      expect(block, `${name} not found in ${entry.file}`).not.toBe('')
      expect(entry.fence.some((f) => block.includes(f)), `${name} no longer calls ${entry.fence.join(' or ')}`).toBe(true)
    })
  }

  it('the fences the browser and transcript tools lean on are themselves wired', () => {
    const browser = read('src/lib/ai/tools/browser.ts')
    // run() settles every completed command through completedResult, which fences.
    expect(browser).toMatch(/if \(row\.status === 'completed'\) return completedResult\(command, id, row\.result, opts\.fence \?\? true\)/)
    expect(browser).toMatch(/const result = fence \? fenceBrowserResult\(command, compact\) : compact/)
    const captures = read('src/lib/ai/tools/captures.ts')
    expect(captures).toMatch(/function transcriptFirstPage[\s\S]*?transcriptForModel\(/)
  })

  it('the search tools are listed explicitly, each with its fence wired where the outside text is', () => {
    for (const name of ['search', 'deep_search', 'find', 'get_document']) expect(OUTSIDE_TEXT_TOOLS).toHaveProperty(name)
    const search = read('src/lib/ai/tools/search.ts')
    // find: an email hit's subject and snippet, an attachment hit's excerpt.
    expect(toolBlock(search, 'find')).toMatch(/title: wrapUntrusted\(r\.subject\) \?\? ''/)
    expect(toolBlock(search, 'find')).toMatch(/excerpt: wrapUntrusted\(r\.snippet\)/)
    expect(toolBlock(search, 'find')).toMatch(/excerpt: wrapUntrusted\(r\.excerpt, 'FILE'\)/)
    // search: both email branches (enriched and plain).
    expect(toolBlock(search, 'search').match(/title: wrapUntrusted\(r\.subject\) \?\? ''/g)).toHaveLength(2)
    expect(toolBlock(search, 'search').match(/snippet: wrapUntrusted\(r\.snippet\)/g)).toHaveLength(2)
    expect(toolBlock(search, 'search')).not.toMatch(/snippet: r\.snippet/)
    // deep_search: both passage kinds, at output.
    expect(toolBlock(search, 'deep_search')).toMatch(/fenceChunks\(keptCaptures, 'TRANSCRIPT'\)/)
    expect(toolBlock(search, 'deep_search')).toMatch(/fenceChunks\(keptAttachments, 'FILE'\)/)
  })

  it('the web-derived CRM and prospecting fields are fenced where the tools build them', () => {
    const prospecting = read('src/lib/ai/tools/prospecting.ts')
    const entrySummary = /function entrySummary[\s\S]*?\n}\n/.exec(prospecting)?.[0] ?? ''
    expect(entrySummary).toMatch(/fit_rationale: webText\(entry\.fit_rationale\)/)
    expect(entrySummary).toMatch(/title: typeof candidate\.title === 'string' \? webText\(candidate\.title\) : null/)
    expect(entrySummary).not.toMatch(/fit_rationale: entry\.fit_rationale/)
    const research = toolBlock(prospecting, 'research_my_company')
    expect(research).toMatch(/description: webText\(/)
    expect(research).toMatch(/industry: webText\(/)
    expect(research).toMatch(/icp_fields: fenceWebValues\(enrichment\)/)
    const contacts = read('src/lib/ai/tools/contacts.ts')
    expect(toolBlock(contacts, 'get_contact')).toMatch(/contact: fenceContactForModel\(/)
    expect(toolBlock(contacts, 'get_contact')).not.toMatch(/contact: data \}/)
    const companies = read('src/lib/ai/tools/companies.ts')
    for (const name of ['create_company', 'update_company']) {
      expect(toolBlock(companies, name)).toMatch(/company: fenceWebFields\(data as Record<string, unknown>, COMPANY_WEB_FIELDS\)/)
    }
    const crm = read('src/lib/ai/tools/crm.ts')
    for (const name of ['get_contact_details', 'get_company_overview']) {
      expect(toolBlock(crm, name)).toMatch(/recent_email_threads: fenceThreads\(ctx\.recent_email_threads\)/)
    }
    expect(toolBlock(crm, 'get_company_overview')).toMatch(/fenceWebFields\(ctx\.company as unknown as Record<string, unknown>, COMPANY_WEB_FIELDS\)/)
    // A contact hit's subtitle (job title at company) and a capture's participants.
    expect(read('src/lib/ai/tools/search.ts')).toMatch(/subtitle: webText\(\[c\.job_title, company\?\.name\]/)
    const captures = read('src/lib/ai/tools/captures.ts')
    expect(captures).toMatch(/job_title: webText\(p\.job_title\)/)
    expect(captures).toMatch(/company: webText\(p\.company\)/)
  })

  it('the Studio video read fences where it is built, and its write path takes the fence off', () => {
    const view = read('src/lib/studio/agent/edit-view.ts')
    expect(read('src/lib/studio/agent/reads.ts')).toMatch(/summary = editOverview\(row\.doc\)/)
    expect(view).toMatch(/const words = \(text: string\) => fenced\(text, 'TRANSCRIPT'\)/)
    expect(view).toMatch(/const fileName = \(name: string\) => fenced\(name, 'FILE'\)/)
    expect(view).toMatch(/transcript: base\.transcript \? fenced\(base\.transcript\.join/)
    expect(read('src/lib/studio/server/ops.ts')).toMatch(/args: unfenceArgs\(call\.args\)/)
  })

  it('every outside-text-looking registry tool is listed one way or the other', () => {
    const unlisted = ALL_TOOL_NAMES.filter(
      (n) => OUTSIDE_TEXT_NAME.test(n) && !(n in OUTSIDE_TEXT_TOOLS) && !(n in NOT_OUTSIDE_TEXT_TOOLS),
    )
    expect(unlisted, 'add each to OUTSIDE_TEXT_TOOLS (and fence it) or to NOT_OUTSIDE_TEXT_TOOLS with a reason').toEqual([])
  })

  it('the two lists name only real tools and never the same one', () => {
    for (const n of Object.keys(NOT_OUTSIDE_TEXT_TOOLS)) {
      expect(ALL_TOOL_NAMES).toContain(n)
      expect(n in OUTSIDE_TEXT_TOOLS).toBe(false)
    }
  })
})

describe('outside text reaching a model outside src/lib/ai/tools', () => {
  it('external MCP results are fenced on every path: chat direct, mcp_confirm_call, and the live agent’s lookups', () => {
    const adapter = read('src/lib/mcp-client/adapter.ts')
    expect(adapter).not.toMatch(/content: result\.content/)
    // Two fence sites: callExternalMcpTool (chat direct + live lookups) and
    // executeExternalMcpCall (the call mcp_confirm_call's card runs).
    expect(adapter.match(/content: fenceMcpContent\(result\.content\)/g)).toHaveLength(2)
    const shared = adapter.slice(adapter.indexOf('export async function callExternalMcpTool'))
    expect(shared.slice(0, shared.indexOf('\n}\n'))).toMatch(/content: fenceMcpContent\(result\.content\)/)
    const approved = adapter.slice(adapter.indexOf('export async function executeExternalMcpCall'))
    expect(approved.slice(0, approved.indexOf('\n}\n'))).toMatch(/content: fenceMcpContent\(result\.content\)/)
    // Chat's direct tool runs through the shared, fenced body…
    expect(adapter).toMatch(/return callExternalMcpTool\(server, remoteName, /)
    // …and so does the live agent's lookup, which never calls the transport itself.
    const live = read('src/lib/live-agent/mcp-lookups.ts')
    expect(live).toMatch(/callExternalMcpTool\(server, toolName, args, \{/)
    expect(live).not.toMatch(/\bcallTool\(/)
  })

  it('every agent that keeps eve web_fetch wraps the page in the WEB marker', () => {
    const agentsDir = join(ROOT, 'agents')
    const kept: string[] = []
    for (const agent of readdirSync(agentsDir)) {
      const file = join(agentsDir, agent, 'tools', 'web_fetch.ts')
      if (!existsSync(file)) continue
      const source = readFileSync(file, 'utf8')
      if (/export default disableTool\(\)/.test(source)) continue
      kept.push(agent)
      expect(source, agent).toMatch(/import \{ wrapUntrustedWeb \} from '\.\.\/lib\/untrusted'/)
      expect(source, agent).toMatch(/content: wrapUntrustedWeb\(fetched\.content \?\? ''\)/)
      expect(source, agent).not.toMatch(/return \(await webFetch\.execute\(input, ctx\)\)/)
    }
    // The five agents with a guarded web_fetch (url-guard-drift.test.ts's list).
    expect(kept.sort()).toEqual(['chat-agent', 'coding-agent', 'onboarding-researcher', 'skill-runner', 'work-agent'])
  })

  it('web_search stays the one known unwrapped source: provider-executed, no executor of ours', () => {
    expect(PROVIDER_EXECUTED_UNWRAPPED).toEqual(['web_search'])
    // The cloud body's search is Exa's; the Mac body has none of its own (C1 serves a proxied one).
    expect(read('agents/chat-agent/tools/web_search.ts')).toMatch(/export default isMacHost\(\) \? disableTool\(\) : webSearch\(\{ provider: 'exa' \}\)/)
  })
})
