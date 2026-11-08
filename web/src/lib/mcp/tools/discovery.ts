import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { searchRegistry } from '@/lib/ai/tool-discovery'
import { classifyToolAccess, type McpAuditFn } from '../guard'
import { describeCatalog, staleCatalogHint, type CatalogStamp } from '../catalog'
import { buildMcpErrorContent, targetWorkspaceOf, withActiveWorkspace, withTargetWorkspace, withoutMcpImage } from './envelope'

/**
 * DISCOVERY AND DISPATCH — the two tools whose names never change.
 *
 * THE INCIDENT. Asked on a phone to "pull my list of prospects", Claude
 * answered that it had no tool for it. Three different faults produce that one
 * sentence, and only the first was a missing tool:
 *
 *   A. the tool genuinely did not exist (fixed: list_prospect_lists);
 *   B. the client's catalog was fetched at connect and predates the tool. Our
 *      transport refuses the server→client SSE stream that MCP's
 *      `notifications/tools/list_changed` rides on, deliberately (on Vercel
 *      that stream is torn down at the function ceiling, which the CLI sees as
 *      the server dropping mid-session). So there is no way to push;
 *   C. ~165 tools are exposed flat, against a documented 30-50 degradation
 *      threshold — the tool is there and the model cannot find it.
 *
 * These two tools close B and C together, by making the CATALOG stop being the
 * unit of change:
 *
 *   `dial8_search_tools` answers "what can you do right now" from the live
 *   registry, so an agent holding a stale list can still see the truth.
 *
 *   `dial8_call_tool` invokes anything by name, so it can ACT on what it
 *   found. Its `name` is a free-form string on purpose: a client validates
 *   arguments against the schema IT cached, so a value added to an enum is
 *   rejected client-side before the request is sent. That is also why
 *   consolidating tools behind an `action` enum would not have fixed this.
 *
 * What it does NOT fix: a client that connected before these two tools existed
 * cannot see them either. Everyone reconnects once; after that the catalog
 * stops mattering.
 */

/** Names reachable through the dispatcher, minus the ones that must not be. */
const DISPATCH_DENY = new Set([
  // No recursion.
  'call_tool',
  'search_tools',
])

export interface DiscoveryToolsOptions {
  /** The bridged surface: the same `createTools()` map the registrar exposes. */
  aiTools: Record<string, unknown>
  /** Every tool name this server exposes, prefixed — for the catalog stamp. */
  exposedNames: Iterable<string>
  readOnly: boolean
  active: { id: string; name: string | null }
  audit?: McpAuditFn
}

interface BridgedTool {
  description?: string
  inputSchema?: z.ZodObject<z.ZodRawShape>
  execute?: (args: Record<string, unknown>, context: unknown) => Promise<unknown>
}

/** `dial8_list_companies` and `list_companies` are the same request. */
function bareName(name: string): string {
  return name.trim().replace(/^dial8_/, '')
}

/** The category a tool sits in, for search results. */
function categoryOf(bare: string): string | null {
  for (const cat of TOOL_CATEGORIES) {
    if (cat.tools.some((t) => t.name === bare)) return cat.label
  }
  return null
}

/** JSON Schema for a bridged tool's arguments, or null when it takes none. */
function inputSchemaOf(tool: BridgedTool): unknown {
  if (!tool.inputSchema) return null
  try {
    return z.toJSONSchema(tool.inputSchema)
  } catch {
    // A schema zod cannot render (a transform, a lazy ref) is not worth failing
    // discovery over — the model can still call the tool and read the error.
    return null
  }
}

/*
 * Half the catalog starts with one of these, so matching on them is matching
 * on nothing: `list_prospects` scored `list_actions` and `list_labels` above
 * the prospect tools until they were excluded. They still break the tie when
 * a query is ONLY generic words.
 */
const GENERIC_NAME_TOKENS = new Set([
  'list', 'get', 'create', 'update', 'delete', 'find', 'search', 'read', 'my', 'all', 'the',
])

/**
 * Tools whose names look like the query, for an unknown-name error. Cheap
 * substring scoring — a "did you mean", not a search engine — but it carries
 * real weight: this is the list a stale client reads when the tool it wanted
 * is not in its catalog, so a bad guess here reads as "that doesn't exist".
 */
function closestNames(query: string, names: string[]): string[] {
  const q = bareName(query).toLowerCase()
  const tokens = q.split(/[\s_-]+/).filter((t) => t.length > 2)
  const meaningful = tokens.filter((t) => !GENERIC_NAME_TOKENS.has(t))
  /* Singular/plural is the commonest near miss there is — `list_prospects`
   * for `list_prospect_lists`, `list_company` for `list_companies` — and
   * substring matching gets the second one wrong (company ⊄ companies). So
   * compare stemmed word to stemmed word, not string to string. */
  const stem = (w: string) => w.replace(/ies$/, 'y').replace(/s$/, '')

  const scored = names
    .map((name) => {
      const n = name.toLowerCase()
      const segments = n.split('_').map(stem)
      let score = 0
      if (n.includes(q) || q.includes(n)) score += 5
      for (const token of meaningful) {
        const t = stem(token)
        if (segments.some((seg) => seg === t || seg.startsWith(t) || t.startsWith(seg))) score += 3
      }
      // A generic verb only counts when the query had nothing else in it —
      // otherwise "list_prospects" drags in every list_* tool there is.
      if (meaningful.length === 0) {
        for (const token of tokens) if (n.startsWith(token)) score += 1
      }
      return { name, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, 5)
  return scored.map((s) => `dial8_${s.name}`)
}

export function registerDiscoveryTools(server: McpServer, opts: DiscoveryToolsOptions): void {
  const { aiTools, readOnly, active, audit } = opts
  const stamp: CatalogStamp = describeCatalog(opts.exposedNames)

  /** Bridged tools that can actually be dispatched (an `execute`, not denied). */
  const dispatchable = new Map<string, BridgedTool>()
  for (const [name, tool] of Object.entries(aiTools)) {
    const t = tool as BridgedTool
    if (!t.execute) continue
    if (DISPATCH_DENY.has(name)) continue
    dispatchable.set(name, t)
  }
  const dispatchableNames = [...dispatchable.keys()]

  /** A tool a read-only token may not reach. Fail-closed by name, exactly as
   *  the guard does — an unresolvable name classifies as a write. */
  const forbiddenForScope = (bare: string) => readOnly && classifyToolAccess(bare) === 'write'

  const forbidden = (bare: string) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: `This access token is read-only and "${bare}" modifies workspace data. Re-authorize with write scope to use it.`,
          error_type: 'forbidden',
          retryable: false,
          active_workspace: active,
        }),
      },
    ],
    isError: true as const,
  })

  const text = (payload: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  })

  // ── dial8_search_tools ────────────────────────────────────────────────
  server.tool(
    'dial8_search_tools',
    "What this server can do RIGHT NOW, read from its live registry rather than from the tool list your client cached when it connected. Search by topic or category, or pass an exact `name` to get that tool's full argument schema. Anything listed here can be invoked with dial8_call_tool even if it is absent from your own tool list — which is the point: your list may be older than the server. Start here whenever a capability seems to be missing.",
    {
      query: z
        .string()
        .optional()
        .describe(
          `Topic, or a category to browse. Categories: ${TOOL_CATEGORIES.map((c) => c.id).join(', ')}. Omit both arguments to list the categories.`,
        ),
      name: z
        .string()
        .optional()
        .describe(
          "One tool's exact name, prefixed or bare — returns its description and full JSON argument schema, which is what you need to call a tool your client has never seen.",
        ),
    },
    async ({ query, name }) => {
      // Exact lookup: the path a stale client takes before dispatching.
      if (name) {
        const bare = bareName(name)
        const tool = dispatchable.get(bare)
        if (!tool) {
          return text({
            found: false,
            requested: name,
            closest: closestNames(bare, dispatchableNames),
            catalog: stamp,
            hint: staleCatalogHint(stamp),
          })
        }
        return text({
          found: true,
          tool: {
            name: `dial8_${bare}`,
            description: tool.description ?? null,
            category: categoryOf(bare),
            access: classifyToolAccess(bare),
            available_to_this_token: !forbiddenForScope(bare),
            input_schema: inputSchemaOf(tool),
          },
          catalog: stamp,
          hint: `Call it with dial8_call_tool({ name: "${bare}", input: { … } }).`,
        })
      }

      if (!query?.trim()) {
        return text({
          categories: TOOL_CATEGORIES.map((c) => ({
            id: c.id,
            label: c.label,
            description: c.description,
            tool_count: c.tools.length,
          })),
          catalog: stamp,
          hint: 'Search a topic, or pass a category id as the query to list its tools.',
        })
      }

      const results = searchRegistry(query)
        // Registry rows for tools this server does not bridge (or a read-only
        // token cannot reach) are noise: never advertise what cannot be called.
        .filter((r) => !dispatchable.has(r.name) || !forbiddenForScope(r.name))
        .map((r) => ({
          name: dispatchable.has(r.name) ? `dial8_${r.name}` : r.name,
          description: r.description,
          category: r.category,
          callable: dispatchable.has(r.name),
        }))

      return text({
        query,
        tools: results,
        catalog: stamp,
        hint: results.length
          ? `Call any of these with dial8_call_tool, or ask for one by name to see its arguments. ${staleCatalogHint(stamp)}`
          : `Nothing matched. Browse a category instead: ${TOOL_CATEGORIES.map((c) => c.id).join(', ')}.`,
      })
    },
  )

  // ── dial8_call_tool ───────────────────────────────────────────────────
  server.tool(
    'dial8_call_tool',
    'Invoke any Native Intelligence tool by name, including one that is missing from your own tool list because your client cached its catalog before the tool shipped. `name` is the tool name (prefixed or bare) and `input` is its arguments — use dial8_search_tools with an exact `name` first if you need the argument schema. The result is identical to calling the tool directly.',
    {
      name: z.string().describe('Tool name, e.g. "list_prospect_lists" or "dial8_list_prospect_lists".'),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The tool's own arguments. Omit for a tool that takes none."),
    },
    async ({ name, input }) => {
      const bare = bareName(name)
      const tool = dispatchable.get(bare)

      if (!tool) {
        audit?.(`dial8_call_tool:${bare}`, false, 0, 'unknown_tool')
        return text({
          error: `"${name}" is not a tool on this server.`,
          error_type: 'unknown_tool',
          retryable: false,
          closest: closestNames(bare, dispatchableNames),
          catalog: stamp,
          hint: staleCatalogHint(stamp),
          active_workspace: active,
        })
      }

      /*
       * THE SECURITY BOUNDARY MOVES HERE, and this is the one line that keeps
       * it closed. installMcpGuard classifies by the REGISTERED name, and
       * `call_tool` is in READ_ALLOWED_WRITES so a read-only token can reach
       * read tools through it — which means the guard has already waved this
       * call through by the time we get here. The inner name has to be
       * classified again, or a read-only token would write through the
       * dispatcher.
       */
      if (forbiddenForScope(bare)) {
        audit?.(`dial8_call_tool:${bare}`, false, 0, 'forbidden_read_only')
        return forbidden(bare)
      }

      // A direct call has the MCP SDK parse its arguments against the tool's
      // schema (defaults, coercions, limits, required fields); the dispatcher
      // must do the same, or "identical to calling the tool directly" is false.
      let args: Record<string, unknown> = input ?? {}
      if (typeof tool.inputSchema?.safeParse === 'function') {
        const parsed = tool.inputSchema.safeParse(args)
        if (!parsed.success) {
          audit?.(`dial8_call_tool:${bare}`, false, 0, 'invalid_input')
          return {
            ...text({
              error: `Invalid input for "${bare}".`,
              error_type: 'invalid_input',
              retryable: true,
              issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
              hint: `Get the argument schema with dial8_search_tools({ name: "${bare}" }).`,
              active_workspace: active,
            }),
            isError: true as const,
          }
        }
        args = parsed.data as Record<string, unknown>
      }

      const started = Date.now()
      try {
        const result = await tool.execute!(args, {})
        // Pull the target-workspace stamp BEFORE anything stringifies the
        // result — same handoff a direct call gets via installMcpGuard, so a
        // dispatched create/mutate audits the workspace it actually acted in
        // (mig 271), not just the session's.
        const target = targetWorkspaceOf(result)
        audit?.(`dial8_call_tool:${bare}`, true, Date.now() - started, undefined, target)
        return withTargetWorkspace(text(withActiveWorkspace(withoutMcpImage(result), active)), target)
      } catch (err) {
        audit?.(`dial8_call_tool:${bare}`, false, Date.now() - started, 'execution_error')
        return buildMcpErrorContent(err, `dial8_call_tool:${bare}`, active)
      }
    },
  )
}
