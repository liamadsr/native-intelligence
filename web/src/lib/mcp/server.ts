import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { packageVisibleTo } from '@/lib/knowledge/package-acl'
import { createMcpAuditLogger, isReadOnlyToken } from './guard'
import { registerTools } from './tools'

/**
 * Build the `instructions` blob the MCP server sends in the `initialize`
 * response. Clients (Claude Code, ChatGPT Codex, the Dial8 live agent) treat
 * this as part of their system prompt for the duration of the session.
 *
 * Two jobs:
 *
 *   1. Make workspace ROUTING unambiguous from the very first turn. This used
 *      to say "scope is sticky; call dial8_set_workspace first" — true when the
 *      active workspace was a fence. It no longer is: writes route by the
 *      entity's own workspace and creates route by an explicit `workspace_id`,
 *      so the old text now actively causes the bug it was written to prevent.
 *      An agent that believes scope is sticky reads ENG-42 out of Engineering,
 *      never passes its workspace_id back, and files the follow-up wherever the
 *      connector happened to point. What replaces it is the protocol: read the
 *      `workspace_id` off the row, pass it back.
 *
 *   2. Teach the knowledge loop. Dial8 is the workspace's accumulated
 *      memory — external agents that don't know to ORIENT (briefs) →
 *      SEARCH (claims) → SAVE (create_claim) treat it as a bare CRUD API
 *      and miss the entire point.
 *
 * Kept short and prescriptive — clients with limited context budgets
 * truncate long server instructions.
 */
function buildInstructions(
  workspaceName: string | null,
  workspaceId: string,
  readOnly: boolean,
): string {
  const label = workspaceName?.trim()
    ? `"${workspaceName.trim()}" (id ${workspaceId})`
    : `id ${workspaceId} (no name on the workspace record)`

  return [
    `Dial8 MCP — active workspace: ${label}.`,
    '',
    'The active workspace is a DEFAULT, not a fence. One session reaches every workspace you belong to — route each call yourself instead of switching scope:',
    '  • Every row you read carries `workspace_id`, and every result carries `active_workspace`.',
    '  • To act on an existing entity, pass its id. The server routes the call to that entity\'s own workspace — no switch needed.',
    '  • To CREATE, pass `workspace_id`: take it from the rows you just read, or from `active_workspace` when the user means "here". If you belong to more than one workspace, a create without it returns `needs_workspace` listing the candidates — answer it, don\'t guess.',
    '  • `dial8_set_workspace` is optional. Use it only to pin a long session to one workspace; `dial8_list_workspaces` shows what you have.',
    '',
    // Your tool list was fetched once, when you connected. This server cannot
    // push a new one (its transport offers no server→client stream), so the
    // list can be older than the server — and a missing tool is
    // indistinguishable from a tool that never existed unless you say so.
    'YOUR TOOL LIST MAY BE OUT OF DATE. It was fetched when you connected and this server cannot update it mid-session. If a capability seems to be missing, do NOT conclude it does not exist:',
    '  1. `dial8_search_tools` — what this server can do right now, read live. Pass an exact `name` for a tool\'s argument schema.',
    '  2. `dial8_call_tool` — invoke any tool by name, including one absent from your list.',
    'When that happens, tell the user their Dial8 connector is holding an old tool list and reconnecting will refresh it.',
    '',
    'Knowledge loop — this workspace accumulates a knowledge graph of claims (durable facts, decisions, open questions, commitments) extracted from meetings, documents, and conversations, each with provenance:',
    '  1. ORIENT — read the `dial8://brief/workspace` resource (compiled world model) if your client supports MCP resources. Project and package briefs live at `dial8://brief/project/{id}` and `dial8://brief/package/{id}`.',
    '  2. SEARCH before answering questions about the workspace\'s world: `dial8_search_claims` or `dial8_deep_search` — the graph usually already has the answer. `dial8_get_context_bundle` assembles everything around a project/contact/claim in one ranked call; `dial8_get_package` loads a curated context package by name.',
    '  3. SAVE durable facts you establish while working: `dial8_create_claim` with a verbatim source excerpt. Always `dial8_search_claims` first — relate, never duplicate.',
    ...(readOnly
      ? [
          '',
          'This session\'s token is READ-ONLY: read/search/traverse tools work; anything that modifies workspace data will be refused.',
        ]
      : []),
  ].join('\n')
}

/**
 * Brief scopes exposed as `dial8://brief/<scope>/…` resource templates —
 * everything except the single workspace-wide brief. Growing an ANCHOR type
 * (project, company, …) is a one-line `scopedBriefResource` call plus its label
 * here; `package` is the odd one out (curated collection, visibility-fenced).
 */
type ScopedBriefType = 'project' | 'company' | 'package'
type BriefScopeType = 'workspace' | ScopedBriefType

const SCOPED_BRIEF_LABEL: Record<ScopedBriefType, string> = {
  project: 'Project',
  company: 'Company',
  package: 'Knowledge package',
}

/**
 * Expose compiled knowledge briefs as MCP resources. Resources are the right
 * primitive for briefs: clients can pull them as ambient context (or pin them
 * into their own prompts) without spending a tool round-trip.
 */
function registerBriefResources(
  server: McpServer,
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
) {
  const briefText = async (
    scopeType: BriefScopeType,
    scopeId: string | null,
  ): Promise<string | null> => {
    // The MCP client is service-role, so RLS doesn't fence these reads —
    // gate package briefs on the caller's package visibility explicitly
    // (mig 238 predicate). Workspace/project briefs stay membership-wide.
    if (scopeType === 'package') {
      if (!scopeId || !(await packageVisibleTo(supabase, userId, scopeId))) return null
    }
    let q = supabase
      .from('knowledge_brief')
      .select('content, generated_at')
      .eq('workspace_id', workspaceId)
      .eq('scope_type', scopeType)
    q = scopeId === null ? q.is('scope_id', null) : q.eq('scope_id', scopeId)
    const { data } = await q.maybeSingle()
    if (!data?.content) return null
    return `> Compiled ${String(data.generated_at).slice(0, 10)} from the workspace knowledge graph. Orientation, not ground truth — verify load-bearing specifics with dial8_search_claims / dial8_get_claim.\n\n${data.content}`
  }

  server.registerResource(
    'workspace-brief',
    'dial8://brief/workspace',
    {
      title: 'Workspace knowledge brief',
      description:
        'Compiled world model of the active workspace — read this first for orientation before working with workspace data.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text:
            (await briefText('workspace', null)) ??
            'No workspace brief compiled yet — the nightly knowledge weaver generates one once the workspace has claims.',
        },
      ],
    }),
  )

  const scopedBriefResource = (scopeType: ScopedBriefType, labelTable: string) => {
    const scopeLabel = SCOPED_BRIEF_LABEL[scopeType]
    server.registerResource(
      `${scopeType}-brief`,
      new ResourceTemplate(`dial8://brief/${scopeType}/{scopeId}`, {
        list: async () => {
          const { data: allBriefs } = await supabase
            .from('knowledge_brief')
            .select('scope_id, claim_count')
            .eq('workspace_id', workspaceId)
            .eq('scope_type', scopeType)
            .limit(50)
          // Service-role client: fence package briefs to what this user can
          // see (mig 238). Project briefs are workspace-flat.
          let briefs = allBriefs ?? []
          if (scopeType === 'package') {
            const checks = await Promise.all(
              briefs.map(async (b) =>
                b.scope_id ? packageVisibleTo(supabase, userId, b.scope_id as string) : false,
              ),
            )
            briefs = briefs.filter((_, i) => checks[i])
          }
          const ids = briefs
            .map((b) => b.scope_id as string | null)
            .filter((id): id is string => !!id)
          const names = new Map<string, string>()
          if (ids.length) {
            // Both label tables (projects, knowledge_package) name their
            // display column `name`.
            const { data: rows } = await supabase
              .from(labelTable)
              .select('id, name')
              .eq('workspace_id', workspaceId)
              .in('id', ids)
            for (const r of (rows ?? []) as Array<{ id: string; name: string | null }>) {
              names.set(r.id, String(r.name ?? ''))
            }
          }
          return {
            resources: (briefs ?? [])
              .filter((b) => b.scope_id)
              .map((b) => ({
                uri: `dial8://brief/${scopeType}/${b.scope_id}`,
                name: `${scopeLabel} brief: ${names.get(b.scope_id as string) || b.scope_id}`,
                description: `${b.claim_count ?? 0} claims compiled`,
                mimeType: 'text/markdown',
              })),
          }
        },
      }),
      {
        title: `${scopeLabel} briefs`,
        description: `Compiled knowledge brief per ${scopeType}.`,
        mimeType: 'text/markdown',
      },
      async (uri, variables) => {
        const scopeId = String(
          (Array.isArray(variables.scopeId) ? variables.scopeId[0] : variables.scopeId) ?? '',
        )
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text:
                (await briefText(scopeType, scopeId)) ??
                `No brief compiled for this ${scopeType} yet.`,
            },
          ],
        }
      },
    )
  }

  scopedBriefResource('project', 'projects')
  // `company` is an ANCHOR type now, so it compiles briefs exactly like a
  // project does — same (scope_type, scope_id) row shape, same `name` label
  // column, and no package-style per-row visibility gate (company has no
  // private/workspace split).
  scopedBriefResource('company', 'company')
  scopedBriefResource('package', 'knowledge_package')
}

/**
 * Creates a new MCP server instance with all tools registered,
 * scoped to a specific user and workspace.
 *
 * @param onWorkspaceChanged - callback invoked when the user switches workspaces
 *   via the dial8_set_workspace tool. The caller can use this to persist the change.
 * @param access - the authenticated token's scopes + id; drives read-only
 *   enforcement and audit logging (see ./guard.ts).
 */
export async function createMcpServer(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  onWorkspaceChanged?: (newWorkspaceId: string) => void | Promise<void>,
  access?: {
    scopes?: string[]
    tokenId?: string | null
  },
): Promise<McpServer> {
  // Fetch the workspace name so the instructions can name it. If the lookup
  // fails (workspace not visible, transient DB error), fall back to the bare
  // id — better to ship instructions with a partial name than to omit them.
  let workspaceName: string | null = null
  try {
    const { data } = await supabase
      .from('workspace')
      .select('name')
      .eq('id', workspaceId)
      .maybeSingle()
    workspaceName = data?.name ?? null
  } catch {
    // Swallow — instructions just won't name the workspace.
  }

  const readOnly = isReadOnlyToken(access?.scopes)

  const server = new McpServer(
    {
      name: 'dial8',
      version: '1.0.0',
      // What an app shows for the server it added (its connector list, the
      // sign-in prompt), where it reads them.
      title: 'Dial8',
      websiteUrl: 'https://dial8.ai',
      icons: [{ src: 'https://dial8.ai/icon.png', mimeType: 'image/png', sizes: ['1024x1024'] }],
    },
    {
      instructions: buildInstructions(workspaceName, workspaceId, readOnly),
    },
  )

  registerBriefResources(server, supabase, workspaceId, userId)

  await registerTools(
    server,
    userId,
    supabase,
    workspaceId,
    workspaceName,
    onWorkspaceChanged,
    {
      readOnly,
      audit: createMcpAuditLogger(supabase, {
        tokenId: access?.tokenId ?? null,
        userId,
        workspaceId,
      }),
    },
  )

  return server
}
