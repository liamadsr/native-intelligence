import { fetchPackageClaims, resolvePackageClaimIds } from '@/lib/knowledge/brief'
import { packageEditableBy } from '@/lib/knowledge/package-acl'
import { excludeClaimsHiddenFrom } from '@/lib/knowledge/claim-visibility'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
import { z } from 'zod'
import { entityInWorkspace, LINKABLE_ENTITY_TYPES } from './claims'
import {
  resolveCreateWorkspace,
  resolveEntityWorkspace,
  workspaceEcho,
  type CreateWorkspacePolicy,
} from './_shared'

/**
 * Knowledge packages — named, durable, access-controlled bundles of context.
 *
 * A package is a VIEW over the workspace knowledge graph, never a silo: it
 * groups pinned entities + standing rules ({"projects": [...]} → all claims
 * `about` those projects) so the same claim can serve many packages, and
 * cross-package dedup/contradiction detection keeps working. The nightly
 * weaver compiles each package's brief; the export route turns a package into
 * portable markdown + JSONL.
 *
 * Visibility (personal / team / workspace) mirrors the `view` table. In the
 * web chat these tools run under the user's RLS client, so policies enforce
 * visibility for free; over MCP they run under a service-role client, so the
 * same checks are applied explicitly here. The canonical rules are the SQL
 * predicates from mig 238 (`package_visible_to` / `package_editable_by`);
 * `canSee` below mirrors the visibility predicate in TS only because
 * list_packages needs to fence a whole page of rows without one RPC per row —
 * any rule change must land in the SQL functions first and here second.
 */

const PACKAGE_VISIBILITIES = ['personal', 'team', 'workspace'] as const

const rulesSchema = z
  .object({
    projects: z
      .array(z.string())
      .optional()
      .describe('Project UUIDs — all claims `about` these projects are included'),
    types: z
      .array(z.enum(['fact', 'open_question', 'inference', 'decision_summary']))
      .optional()
      .describe('Claim-type filter for rule-included claims'),
    since: z
      .string()
      .optional()
      .describe('ISO timestamp — only rule-included claims updated at/after this'),
    min_confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Confidence floor for rule-included claims'),
    include_suggested: z
      .boolean()
      .optional()
      .describe('false = only confirmed claims satisfy the rules (default true)'),
  })
  .describe(
    'Standing inclusion rules, resolved live at read time. Pinned items are unconditional; rules govern only the claims they resolve.',
  )

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 60) || 'package'
  )
}

export function createPackageTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  // The user's member id + team ids, used for explicit visibility/share
  // checks when the client is service-role (MCP; RLS covers the web path).
  // Resolved lazily, once per tool call chain — and PER WORKSPACE: a package
  // resolved cross-workspace (loadPackage below) must check membership in the
  // workspace it actually lives in, not the session one, or a genuinely
  // visible foreign-workspace package would read as invisible.
  const accessCache = new Map<string, Promise<{ memberId: string | null; teamIds: Set<string> }>>()
  const myAccess = (ws: string = workspaceId): Promise<{ memberId: string | null; teamIds: Set<string> }> => {
    let p = accessCache.get(ws)
    if (!p) {
      p = (async () => {
        const { data: member } = await supabase
          .from('member')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', ws)
          .maybeSingle()
        if (!member?.id) return { memberId: null, teamIds: new Set<string>() }
        const { data: teams } = await supabase
          .from('team_member')
          .select('team_id')
          .eq('member_id', member.id)
        return {
          memberId: member.id as string,
          teamIds: new Set((teams ?? []).map((t) => t.team_id as string)),
        }
      })()
      accessCache.set(ws, p)
    }
    return p
  }
  const myTeamIds = async (ws: string = workspaceId): Promise<Set<string>> => (await myAccess(ws)).teamIds

  /**
   * ANY share row (member or team) grants visibility — access_level only
   * distinguishes view from edit, and edit checks live in the SQL predicate
   * (package_editable_by) now, never here.
   */
  const hasShare = async (packageId: string, ws: string = workspaceId): Promise<boolean> => {
    const { memberId, teamIds } = await myAccess(ws)
    if (!memberId && teamIds.size === 0) return false
    const ors: string[] = []
    if (memberId) ors.push(`shared_with_member_id.eq.${memberId}`)
    if (teamIds.size > 0) ors.push(`shared_with_team_id.in.(${[...teamIds].join(',')})`)
    const { data } = await supabase
      .from('knowledge_package_share')
      .select('id')
      .eq('package_id', packageId)
      .or(ors.join(','))
      .limit(1)
    return (data?.length ?? 0) > 0
  }

  interface PackageRow {
    id: string
    workspace_id: string
    name: string
    slug: string
    description: string | null
    visibility: string
    team_id: string | null
    rules: Record<string, unknown>
    created_by: string
    created_at: string
    updated_at: string
  }

  const canSee = async (pkg: PackageRow, ws: string = workspaceId): Promise<boolean> => {
    // Membership precondition, mirroring package_row_visible_to: with no
    // member row in this workspace (e.g. an ex-member holding a live MCP
    // token whose active workspace still points here), nothing is visible —
    // not even workspace-visible packages or the user's own creations.
    if (!(await myAccess(ws)).memberId) return false
    if (pkg.visibility === 'workspace') return true
    if (pkg.created_by === userId) return true
    if (pkg.visibility === 'team' && pkg.team_id && (await myTeamIds(ws)).has(pkg.team_id)) {
      return true
    }
    return hasShare(pkg.id, ws)
  }

  // Edit access delegates to the SQL predicate (creator ∨ edit-share ∨
  // admin/owner for non-personal) so the service-role MCP path can never be
  // looser than RLS. Mutations are one-at-a-time, so one RPC is fine.
  const canMutate = async (pkg: PackageRow): Promise<boolean> =>
    packageEditableBy(supabase, userId, pkg.id)

  /**
   * Resolve + load a package. `package_id` routes cross-workspace via
   * {@link resolveEntityWorkspace} — an id copied from another workspace the
   * user belongs to still resolves (unless `strictWorkspace` fences the run to
   * one workspace). `slug` has no id to route by, so it stays session-scoped.
   * The visibility ACL (`canSee`, mig 238) is a SEPARATE fence and still runs
   * on whichever workspace the package actually resolved to.
   */
  const loadPackage = async (ref: {
    package_id?: string
    slug?: string
  }): Promise<PackageRow | null> => {
    let targetWs = workspaceId
    if (ref.package_id) {
      const wsResolved = await resolveEntityWorkspace(
        supabase,
        userId,
        'knowledge_package',
        ref.package_id,
        workspaceId,
        strictWorkspace,
      )
      if (!wsResolved) return null
      targetWs = wsResolved.workspaceId
    } else if (!ref.slug) {
      return null
    }
    let q = supabase
      .from('knowledge_package')
      .select('id, workspace_id, name, slug, description, visibility, team_id, rules, created_by, created_at, updated_at')
      .eq('workspace_id', targetWs)
    if (ref.package_id) q = q.eq('id', ref.package_id)
    else if (ref.slug) q = q.eq('slug', ref.slug)
    const { data } = await q.maybeSingle()
    if (!data) return null
    const pkg = data as PackageRow
    return (await canSee(pkg, targetWs)) ? pkg : null
  }

  return {
    create_package: tool({
      description:
        'Create a knowledge package — a named, durable, access-controlled bundle of context about a subject, project, or initiative. Membership = entities you pin (add_to_package) plus standing rules (e.g. all claims about given projects). The nightly weaver compiles a brief for it, and it can be exported (markdown + JSONL) or scoped to a person/team via visibility.',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        description: z.string().optional(),
        visibility: z.enum(PACKAGE_VISIBILITIES).optional().default('workspace'),
        team_id: z
          .string()
          .optional()
          .describe('Required when visibility is "team"'),
        rules: rulesSchema.optional(),
        pins: z
          .array(
            z.object({
              entity_type: z.enum(LINKABLE_ENTITY_TYPES),
              entity_id: z.string(),
            }),
          )
          .max(50)
          .optional()
          .describe(
            'Entities to pin immediately — lets "promote this to a package" happen in one call',
          ),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }),
      execute: async ({ name, description, visibility, team_id, rules, pins, workspace_id }) => {
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        const vis = visibility ?? 'workspace'
        if (vis === 'team' && !team_id) {
          return { success: false, error: 'team visibility requires team_id' }
        }
        let slug = slugify(name)
        for (let attempt = 0; attempt < 2; attempt++) {
          const { data, error } = await supabase
            .from('knowledge_package')
            .insert({
              workspace_id: targetWs,
              name,
              slug,
              description: description ?? null,
              visibility: vis,
              team_id: vis === 'team' ? team_id : null,
              rules: rules ?? {},
              created_by: userId,
            })
            .select('id, name, slug, visibility')
            .single()
          if (!error) {
            let pinned = 0
            let invalid = 0
            for (const pin of pins ?? []) {
              const ok = await entityInWorkspace(
                supabase,
                targetWs,
                pin.entity_type,
                pin.entity_id,
              )
              if (!ok) {
                invalid += 1
                continue
              }
              const { error: pinErr } = await supabase
                .from('knowledge_package_item')
                .upsert(
                  {
                    package_id: data.id,
                    workspace_id: targetWs,
                    entity_type: pin.entity_type,
                    entity_id: pin.entity_id,
                    added_by: userId,
                  },
                  { onConflict: 'package_id,entity_type,entity_id', ignoreDuplicates: true },
                )
              if (!pinErr) pinned += 1
            }
            return {
              success: true,
              package: data,
              pinned,
              ...(invalid ? { invalid_pins: invalid } : {}),
              message:
                'Package created. Pin more entities with add_to_package, or set rules.projects to auto-include claims about projects.',
              ...workspaceEcho(targetWs, ws.workspaceName),
            }
          }
          if (error.code === '23505') {
            slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`
            continue
          }
          return { success: false, error: error.message }
        }
        return { success: false, error: 'Could not allocate a unique slug' }
      },
    }),

    update_package: tool({
      description:
        'Update a knowledge package — rename it, change its description, visibility, team, or standing inclusion rules.',
      inputSchema: z.object({
        package_id: z.string(),
        name: z.string().min(1).max(120).optional(),
        description: z.string().nullable().optional(),
        visibility: z.enum(PACKAGE_VISIBILITIES).optional(),
        team_id: z.string().nullable().optional(),
        rules: rulesSchema.optional(),
      }),
      execute: async ({ package_id, name, description, visibility, team_id, rules }) => {
        const pkg = await loadPackage({ package_id })
        if (!pkg) return { success: false, error: 'Package not found' }
        if (!(await canMutate(pkg))) {
          return { success: false, error: 'You do not have edit access to this package' }
        }
        // Mirror create_package's invariant on the RESULTING row: team
        // visibility without a team makes the package visible to no one but
        // its creator/shares — always a mistake, never an intent.
        const nextVisibility = visibility ?? pkg.visibility
        const nextTeamId = team_id !== undefined ? team_id : pkg.team_id
        if (nextVisibility === 'team' && !nextTeamId) {
          return { success: false, error: 'team visibility requires team_id' }
        }
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
        if (name !== undefined) updates.name = name
        if (description !== undefined) updates.description = description
        if (visibility !== undefined) updates.visibility = visibility
        if (team_id !== undefined) updates.team_id = team_id
        if (rules !== undefined) updates.rules = rules
        const { data, error } = await supabase
          .from('knowledge_package')
          .update(updates)
          .eq('id', package_id)
          .eq('workspace_id', pkg.workspace_id)
          .select('id, name, slug, visibility, rules')
          .single()
        if (error) return { success: false, error: error.message }
        return { success: true, package: data }
      },
    }),

    list_packages: tool({
      description:
        'List the knowledge packages visible to the user — named, shareable bundles of curated workspace context, with item counts.',
      inputSchema: z.object({
        search: z.string().optional().describe('Filter by name'),
      }),
      execute: async ({ search }) => {
        let q = supabase
          .from('knowledge_package')
          .select('id, name, slug, description, visibility, team_id, rules, created_by, created_at, updated_at')
          .eq('workspace_id', workspaceId)
          .order('updated_at', { ascending: false })
          .limit(50)
        if (search) q = q.ilike('name', `%${search}%`)
        const { data, error } = await q
        if (error) return { success: false, error: error.message }

        const visible: PackageRow[] = []
        for (const row of (data ?? []) as PackageRow[]) {
          if (await canSee(row)) visible.push(row)
        }

        // One exact count per package (at most 50): counting fetched rows
        // stopped at 1000 (`.limit(5000)` is still one 1000-row response), so
        // busy packages under-counted and later ones showed 0 pins.
        const counts = new Map<string, number>()
        await Promise.all(
          visible.map(async (p) => {
            const { count } = await supabase
              .from('knowledge_package_item')
              .select('package_id', { count: 'exact', head: true })
              .eq('package_id', p.id)
            counts.set(p.id, count ?? 0)
          }),
        )

        return {
          success: true,
          packages: visible.map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            description: p.description,
            visibility: p.visibility,
            rules: p.rules,
            pinned_items: counts.get(p.id) ?? 0,
            updated_at: p.updated_at,
          })),
          count: visible.length,
        }
      },
    }),

    get_package: tool({
      description:
        'Load a knowledge package: its pinned entities, its standing rules, the claims those rules resolve to (ranked, confirmed first), and its compiled brief. This is the "give me everything about <subject>" call when a package exists for it.',
      inputSchema: z.object({
        package_id: z.string().optional(),
        slug: z.string().optional().describe('Lookup by slug instead of id'),
        max_claims: z.number().int().min(1).max(100).optional().default(40),
      }),
      execute: async ({ package_id, slug, max_claims }) => {
        const pkg = await loadPackage({ package_id, slug })
        if (!pkg) return { success: false, error: 'Package not found' }

        // Every downstream read below is scoped to the package's OWN
        // workspace (pkg.workspace_id, from loadPackage) rather than the
        // session one — loadPackage may have resolved this package
        // cross-workspace, and scoping these to the wrong tenant would return
        // a package with zero items/claims/brief instead of the real ones.
        const { data: items } = await supabase
          .from('knowledge_package_item')
          .select('entity_type, entity_id, created_at')
          .eq('package_id', pkg.id)
          .eq('workspace_id', pkg.workspace_id)
          .order('created_at', { ascending: true })
          .limit(200)

        // Shared resolver: pins unconditional, rules (types/since/confidence/
        // include_suggested) applied to rule-resolved claims — identical
        // semantics to brief compilation and the export route.
        const [resolvedClaims, claimIds] = await Promise.all([
          fetchPackageClaims(supabase, pkg.workspace_id, pkg.id, max_claims ?? 40),
          resolvePackageClaimIds(supabase, pkg.workspace_id, pkg.id),
        ])
        // Over MCP this runs service-role: a claim is readable only when one
        // of its sources is, and never when one is mail (migration 341).
        const claims = await excludeClaimsHiddenFrom(supabase, resolvedClaims, userId)

        const { data: brief } = await supabase
          .from('knowledge_brief')
          .select('content, generated_at')
          .eq('workspace_id', pkg.workspace_id)
          .eq('scope_type', 'package')
          .eq('scope_id', pkg.id)
          .maybeSingle()

        return {
          success: true,
          package: {
            id: pkg.id,
            name: pkg.name,
            slug: pkg.slug,
            description: pkg.description,
            visibility: pkg.visibility,
            rules: pkg.rules,
          },
          pinned_items: items ?? [],
          claims,
          claim_count: claimIds.length,
          brief: brief?.content ?? null,
          brief_generated_at: brief?.generated_at ?? null,
          export_url: `/api/account/knowledge-packages/${pkg.id}/export`,
        }
      },
    }),

    add_to_package: tool({
      description:
        'Pin an entity (claim, document, capture, project, contact, action, ...) into a knowledge package. Pinning a project does NOT auto-include its claims — set rules.projects for that; pinning is for hand-picked items.',
      inputSchema: z.object({
        package_id: z.string(),
        entity_type: z.enum(LINKABLE_ENTITY_TYPES),
        entity_id: z.string(),
      }),
      execute: async ({ package_id, entity_type, entity_id }) => {
        const pkg = await loadPackage({ package_id })
        if (!pkg) return { success: false, error: 'Package not found' }
        if (!(await canMutate(pkg))) {
          return { success: false, error: 'You do not have edit access to this package' }
        }
        const ok = await entityInWorkspace(supabase, pkg.workspace_id, entity_type, entity_id)
        if (!ok) {
          return { success: false, error: `${entity_type} ${entity_id} not found in this workspace` }
        }
        const { error } = await supabase.from('knowledge_package_item').upsert(
          {
            package_id,
            workspace_id: pkg.workspace_id,
            entity_type,
            entity_id,
            added_by: userId,
          },
          { onConflict: 'package_id,entity_type,entity_id', ignoreDuplicates: true },
        )
        if (error) return { success: false, error: error.message }
        return { success: true, message: `Pinned ${entity_type} into "${pkg.name}"` }
      },
    }),

    remove_from_package: tool({
      description: 'Remove a pinned entity from a knowledge package.',
      inputSchema: z.object({
        package_id: z.string(),
        entity_type: z.enum(LINKABLE_ENTITY_TYPES),
        entity_id: z.string(),
      }),
      execute: async ({ package_id, entity_type, entity_id }) => {
        const pkg = await loadPackage({ package_id })
        if (!pkg) return { success: false, error: 'Package not found' }
        if (!(await canMutate(pkg))) {
          return { success: false, error: 'You do not have edit access to this package' }
        }
        const { error } = await supabase
          .from('knowledge_package_item')
          .delete()
          .eq('package_id', package_id)
          .eq('entity_type', entity_type)
          .eq('entity_id', entity_id)
        if (error) return { success: false, error: error.message }
        return { success: true }
      },
    }),
  }
}
