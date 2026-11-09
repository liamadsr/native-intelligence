/**
 * Second net for the work-run tool ceiling: the registry classification,
 * cross-checked against a text heuristic.
 *
 * THE FENCE is structural (SYNTHESIS WS-3c Fix item 3): every registry entry
 * carries a required `sideEffect` class, and computeWorkRunCeiling admits only
 * 'read' and 'internal-write' (WORK_RUN_ADMITTED_SIDE_EFFECTS in
 * @/lib/ai/tool-registry). A tool is out unless someone classified it as a read
 * or an internal write. Before that, the ceiling was "full registry MINUS a
 * hand-maintained list", which drifted four times (calendar event writes, which
 * email attendees; publish_prospect_list and the push_action_to_* trio; the
 * flow and sequence edit tools; update_skill / create_skill / accept_proposal).
 *
 * THIS TEST checks the CLASSIFICATION against what the tools SAY. A registry
 * tool is "external-write-shaped" when EITHER
 *   1. its NAME starts with publish_ / push_ / send_ / post_, OR
 *   2. its registry DESCRIPTION (TOOL_CATEGORIES in @/lib/ai/tool-registry), its
 *      REAL tool description (the full model-facing text from createTools), or
 *      its INPUT SCHEMA (as JSON Schema, field names + enum values + field
 *      descriptions) says it sends, publishes, pushes, fires an outbound HTTP
 *      request/webhook, carries a bearer token, writes to a named connected
 *      integration / third-party / external system, offers a 'public'
 *      visibility, writes another automation's prompt or tool config, or
 *      executes staged proposals. See SIGNALS for the patterns.
 *
 * Every external-write-shaped tool must EITHER be classified outside the
 * admitted classes (external-write / automation-write / delete — so it is out
 * of the ceiling), OR be listed in REVIEWED_IN_CEILING below with the reason a
 * human, reading the tool's code, kept it read / internal-write ("draft only",
 * "read-only"). A flagged tool classified as admitted with no reviewed reason
 * fails here: that is a classification a reviewer must look at twice.
 *
 * If this test fails on a tool you just added or reclassified: the safe fix is
 * to classify it external-write / automation-write / delete in the registry.
 * Only add it to REVIEWED_IN_CEILING with a one-line reason that would survive
 * review.
 *
 * Limits: the heuristic only sees names, descriptions and schemas, so it is a
 * second net, not the fence. A tool whose external effect is invisible in all of
 * them is caught only by its classification — the calendar create/update tools
 * are the precedent ("Create a new calendar event" says nothing about emailing
 * attendees), and so are effects that live in Inngest fan-out rather than in the
 * tool (create_contact's opt-in HubSpot push, the tracker status echo and
 * status-change flows on update_action). Those fan-outs are an OPEN product call
 * in ../types.ts ("OPEN — needs Liam's product call: configured mirrors").
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { computeWorkRunCeiling } from '../run-work-spec-rebuild'
import {
  ALL_TOOL_NAMES,
  TOOL_CATEGORIES,
  WORK_RUN_ADMITTED_SIDE_EFFECTS,
  getToolSideEffect,
  isAttendedOnlyTool,
} from '@/lib/ai/tool-registry'
import { createTools } from '@/lib/ai/tools'

const NAME_SIGNAL = /^(publish_|push_|send_|post_)/

const SIGNALS: Array<{ label: string; re: RegExp }> = [
  { label: 'sends', re: /\bsend(s|ing)?\b/i },
  { label: 'publishes', re: /\bpublish(es|ed|ing)?\b/i },
  { label: 'pushes', re: /\bpush(es|ed|ing)?\b/i },
  { label: 'outbound HTTP / webhook', re: /\bHTTP (POST|PUT|PATCH)\b|\bwebhooks?\b/i },
  // A tool that stores or sets a bearer token is configuring an authenticated
  // outbound call, whatever else its description says.
  { label: 'outbound credential', re: /\bbearer[_ ]token\b/i },
  // "the workspace's connected Asana project" — `connected` followed by a
  // capitalised integration name. Lower-case "connected knowledge subgraph" /
  // "edges connected to an entity" are graph language, not integrations.
  { label: 'connected integration', re: /\bconnected [A-Z][A-Za-z]+/ },
  { label: 'third-party / external system', re: /\bthird[- ]party\b|\bexternal (system|service|provider|tracker|account)\b/i },
  // An enum value "public" in the input schema (JSON-quoted, so prose like "the
  // public web" does not count): the tool can make something visible beyond the
  // workspace — Discover is every Native Intelligence tenant.
  { label: 'public visibility', re: /"public"/ },
  // An input FIELD that sets another automation's instructions or tool surface
  // (a skill's prompt / agent_config): editing what an existing flow executes.
  { label: 'automation config write', re: /"(system_prompt|agent_config|enabled_tools)"/ },
  // Executes proposals that were staged for a human (the apply engine can run
  // mcp_call:external and deletes).
  { label: 'executes staged proposals', re: /\baccept(s|ing)?\b[^.\n]*\bpropos/i },
]

/**
 * External-write-shaped tools whose registry class is read / internal-write,
 * reviewed against their code. Each reason must explain why nothing leaves the
 * workspace unreviewed.
 */
const REVIEWED_IN_CEILING: Record<string, string> = {
  // writes that stop short of anything external
  update_document:
    '"published" describes the internal wiki doc state it edits; no third party sees or receives anything',
  propose_document_edit: 'stages a draft edit; its description says it does NOT publish (publish_draft is excluded)',
  create_email_draft: 'an email DRAFT for the user to review; sending is always a separate user action',
  draft_followup_email: 'saves a follow-up email DRAFT from a capture; "Only creates a draft — does NOT send"',
  create_sequence: 'creates the sequence as a draft that never sends; only the user launches it',
  remove_from_sequence: 'exits an enrollment so further steps do NOT send; it can only reduce outbound mail',
  create_campaign: '"a named push" is marketing language; it writes an internal planning row (and, from a recipe, a draft sequence) and sends nothing',
  update_campaign: 'edits a campaign\'s fields (its audience, sequence, rolling); "sends" describes the campaign, and only launch_campaign (excluded) sends, on the person\'s yes',
  create_eval_case: '"send"/"push" appear only inside the example eval script text; it writes an internal eval case',
  update_eval_case:
    '"pushed back" appears only in the example grading text of its input schema; it edits an internal eval case row',
  // reads an outside account into the CRM, attended
  import_stripe_customers:
    "reads the Stripe account the owner connected for payments (list calls only: nothing in Stripe changes) into undoable CRM contacts; 'send' is the owner sending an export file instead. It refuses an unattended turn (a work run passes unattended: true), so it never runs in a work run",
  // texts only the caller themselves
  connect_link:
    "texts a sign-in link only to the caller's OWN verified number (the channel the agent's reply already uses), and only on their own SMS turn: it refuses unattended (a work run passes unattended: true) and every other turn, so it never sends from a work run or to anyone else",
  // read-only (flagged only because they describe an external surface)
  get_email_drafts: 'read-only: lists pending drafts ("what needs sending"), sends nothing',
  get_sequence: 'read-only: sequence detail and per-step sent counts',
  list_campaigns: 'read-only: campaigns with a sending campaign\'s sent / replied / opted-out counts',
  list_prospect_lists: 'read-only: prospect list tallies ("waiting to be published"); publish_prospect_list is excluded',
}

function signalsFor(name: string, description: string): string[] {
  const hits: string[] = []
  if (NAME_SIGNAL.test(name)) hits.push('name prefix')
  for (const { label, re } of SIGNALS) if (re.test(description)) hits.push(label)
  return hits
}

// The REAL tool set, so the scan reads each tool's full model-facing description
// and not just the one-line registry summary. The builders only capture
// `supabase` in their execute closures, so a stub client is enough to enumerate
// them (same precedent as src/lib/ai/__tests__/tool-registry-sync.test.ts). Built
// with the SAME options the work-run tool route passes, so the descriptions are
// the ones a work run actually sees.
const REAL_TOOLS = createTools('guard-user', {} as unknown as SupabaseClient, 'guard-workspace', undefined, {
  strictWorkspace: true,
  omitPrivateCaptures: true,
}) as Record<string, { description?: string; inputSchema?: unknown }>

/**
 * The tool's input schema as JSON Schema text, or '' when it cannot be rendered
 * (absent from the real tool set, or z.toJSONSchema throws on a transform /
 * z.custom). '' would silently drop the tool out of the schema scan, so the
 * "every registry schema renders" test below fails on ANY '' — a tool the guard
 * cannot read has to be fixed or handled explicitly, never passed as clean.
 */
function schemaText(name: string): string {
  if (!Object.hasOwn(REAL_TOOLS, name)) return ''
  try {
    return JSON.stringify(z.toJSONSchema(REAL_TOOLS[name].inputSchema as z.ZodType)) ?? ''
  } catch {
    return ''
  }
}

const EXTERNAL_WRITE_SHAPED: Array<{ name: string; signals: string[] }> = TOOL_CATEGORIES.flatMap((c) =>
  c.tools
    .map((t) => {
      const real = Object.hasOwn(REAL_TOOLS, t.name) ? (REAL_TOOLS[t.name].description ?? '') : ''
      const text = `${t.description}\n${real}\n${schemaText(t.name)}`
      return { name: t.name, signals: [...new Set(signalsFor(t.name, text))] }
    })
    .filter((t) => t.signals.length > 0),
)

/**
 * True when the tool's registry class keeps it OUT of the work-run ceiling, or
 * it is attended-only (bots v3 Phase 5: revise_email_draft is an internal
 * write that "never sends", out of every unattended run by name).
 */
function classifiedOut(name: string): boolean {
  const cls = getToolSideEffect(name)
  return cls === undefined || !WORK_RUN_ADMITTED_SIDE_EFFECTS.has(cls) || isAttendedOnlyTool(name)
}

describe('work-run ceiling classification vs what the tools say', () => {
  const ceiling = computeWorkRunCeiling()

  it('the heuristic still finds the known external-write tools (it has not gone blind)', () => {
    const found = new Set(EXTERNAL_WRITE_SHAPED.map((t) => t.name))
    for (const name of [
      'publish_draft',
      'publish_prospect_list',
      'push_action_to_asana',
      'push_action_to_jira',
      'push_action_to_linear',
      'create_flow',
      'update_flow',
      'update_sequence',
      'update_skill',
      'create_skill',
      'accept_proposal',
    ]) {
      expect(found.has(name), `${name} should be flagged by the heuristic`).toBe(true)
    }
  })

  it('every external-write-shaped tool is classified out of the ceiling, or reviewed with a reason', () => {
    const unreviewed = EXTERNAL_WRITE_SHAPED.filter(
      (t) => !classifiedOut(t.name) && !Object.hasOwn(REVIEWED_IN_CEILING, t.name),
    ).map((t) => `${t.name} [${getToolSideEffect(t.name)}] (${t.signals.join(', ')})`)
    // Fix: classify the tool external-write / automation-write / delete in
    // src/lib/ai/tool-registry.ts (or, with a stated reason, add it to
    // REVIEWED_IN_CEILING in this file).
    expect(unreviewed).toEqual([])
  })

  it('the classification and the ceiling agree for every flagged tool', () => {
    // classifiedOut is the rule; the ceiling is its implementation. They must
    // never disagree on a tool the heuristic cares about.
    for (const t of EXTERNAL_WRITE_SHAPED) {
      expect(ceiling.has(t.name), t.name).toBe(!classifiedOut(t.name))
    }
  })

  it('every name-prefix match (publish_/push_/send_/post_) is out of the ceiling', () => {
    // Name-shaped sends/publishes/pushes have no reviewed exemption path.
    const leaked = ALL_TOOL_NAMES.filter((n) => NAME_SIGNAL.test(n) && (ceiling.has(n) || !classifiedOut(n)))
    expect(leaked).toEqual([])
  })

  it('REVIEWED_IN_CEILING holds no stale entries', () => {
    const registry = new Set(ALL_TOOL_NAMES)
    const shaped = new Set(EXTERNAL_WRITE_SHAPED.map((t) => t.name))
    for (const [name, reason] of Object.entries(REVIEWED_IN_CEILING)) {
      // Still a real tool, still classified admitted (if it was reclassified
      // out, drop it here), still flagged by the heuristic (otherwise the entry
      // is dead weight), and the reason says something.
      expect(registry.has(name), `${name} is not a registry tool`).toBe(true)
      expect(classifiedOut(name), `${name} is classified out — remove it from this list`).toBe(false)
      expect(ceiling.has(name), `${name} is not in the ceiling — remove it from this list`).toBe(true)
      expect(shaped.has(name), `${name} is no longer flagged — remove it from this list`).toBe(true)
      expect(reason.trim().length, `${name} needs a reason`).toBeGreaterThan(10)
    }
  })

  it('reads the REAL tool descriptions, not only the registry one-liners', () => {
    // update_sequence's registry line ("Edit a sequence's structure or
    // pause/resume/archive it") matches no signal; only its real description
    // ("turn on sending", "send times") does. If the real-tool scan is dropped,
    // this fails before a send path can slip back through.
    const registryOnly = TOOL_CATEGORIES.flatMap((c) => c.tools).find((t) => t.name === 'update_sequence')
    expect(registryOnly, 'update_sequence is a registry tool').toBeDefined()
    expect(signalsFor('update_sequence', registryOnly!.description)).toEqual([])
    expect(EXTERNAL_WRITE_SHAPED.map((t) => t.name)).toContain('update_sequence')
    // And the real tool set really was built (a stub that returned {} would
    // silently reduce this guard to the registry scan).
    expect(Object.keys(REAL_TOOLS).length).toBeGreaterThanOrEqual(ALL_TOOL_NAMES.length)
  })

  it('every registry tool has a real tool whose input schema renders (none is silently unscanned)', () => {
    const registry = TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name))
    expect(registry.length).toBeGreaterThan(100)
    const unscanned = registry.filter((name) => schemaText(name) === '')
    expect(unscanned).toEqual([])
  })

  it('reads the INPUT SCHEMAS too, not only descriptions', () => {
    // update_skill's registry line and its real description match no signal;
    // only its schema (a "public" visibility value, the system_prompt field)
    // does. If the schema scan is dropped or starts rendering '', this fails
    // before an automation re-aim or Discover publish can slip back in.
    // (agent_config left this schema in Sequence step 1 — the D.1 lockdown —
    // so system_prompt is the automation-write field the scan must still see.)
    const registryOnly = TOOL_CATEGORIES.flatMap((c) => c.tools).find((t) => t.name === 'update_skill')
    expect(registryOnly, 'update_skill is a registry tool').toBeDefined()
    const described = `${registryOnly!.description}\n${REAL_TOOLS.update_skill?.description ?? ''}`
    expect(signalsFor('update_skill', described)).toEqual([])
    expect(schemaText('update_skill')).toContain('"system_prompt"')
    expect(schemaText('update_skill')).not.toContain('"agent_config"')
    const hit = EXTERNAL_WRITE_SHAPED.find((t) => t.name === 'update_skill')
    expect(hit?.signals).toEqual(expect.arrayContaining(['public visibility', 'automation config write']))
  })
})
