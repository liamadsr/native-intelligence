import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { fetchPackageClaims } from '@/lib/knowledge/brief'
import { excludeClaimsHiddenFrom } from '@/lib/knowledge/claim-visibility'

// PostgREST caps a response at 1000 rows (silently) and `.in()` rides in the
// URL, so the provenance reads go in claim-id chunks, each paged by .range()
// until a short page — a package's sources and links must arrive whole.
const PAGE_SIZE = 1000
const ID_CHUNK = 100

async function readInChunks<T>(
  ids: string[],
  read: (
    chunk: string[],
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK))
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const rows: T[] = []
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await read(chunk, from, from + PAGE_SIZE - 1)
        if (error) return { rows, error }
        rows.push(...(data ?? []))
        if ((data ?? []).length < PAGE_SIZE) return { rows, error: null }
      }
    }),
  )
  const failed = results.find((r) => r.error)
  return { data: results.flatMap((r) => r.rows), error: failed?.error ?? null }
}

/**
 * GET /api/account/knowledge-packages/[id]/export?format=markdown|jsonl
 *
 * Turn a knowledge package into a portable artifact — the "take your context
 * to any intelligence layer" surface:
 *
 *   markdown (default) — the compiled brief followed by every claim grouped
 *     by type, each with confidence, confirmation state, and provenance
 *     lines. Human-readable, model-agnostic; paste it into any LLM.
 *
 *   jsonl — one JSON object per line: a package header line, then one line
 *     per claim carrying full provenance (sources with excerpts + graph
 *     links). Machine-readable for import pipelines.
 *
 * Runs under the user's RLS client, so package visibility (personal/team/
 * workspace) is enforced by the database policies from migration 124.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params
  const url = new URL(request.url)
  const format = url.searchParams.get('format') ?? 'markdown'
  if (format !== 'markdown' && format !== 'jsonl') {
    return badRequest('format must be "markdown" or "jsonl"')
  }

  // RLS-filtered: a package the caller can't see comes back as null.
  const { data: pkg, error: pkgErr } = await supabase
    .from('knowledge_package')
    .select('id, name, slug, description, visibility, rules, created_at, updated_at')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (pkgErr) return serverError(pkgErr.message)
  if (!pkg) return notFound('Package not found')

  // Shared resolver — same rule semantics as get_package and brief compilation.
  // A claim is readable only when one of its sources is; mail never is (341).
  const claims = await excludeClaimsHiddenFrom(
    supabase,
    await fetchPackageClaims(supabase, workspaceId, pkg.id, 500),
    user.id,
  )
  const ids = claims.map((c) => c.id)

  const [sourcesRes, linksRes, { data: brief }] = await Promise.all([
    readInChunks<Record<string, unknown>>(ids, (chunk, from, to) =>
      supabase
        .from('claim_source')
        .select('claim_id, source_type, source_id, source_uri, excerpt')
        .in('claim_id', chunk)
        .order('id')
        .range(from, to),
    ),
    readInChunks<Record<string, unknown>>(ids, (chunk, from, to) =>
      supabase
        .from('entity_link')
        .select('source_id, target_type, target_id, relation')
        .eq('workspace_id', workspaceId)
        .eq('source_type', 'claim')
        .in('source_id', chunk)
        .order('id')
        .range(from, to),
    ),
    supabase
      .from('knowledge_brief')
      .select('content, generated_at')
      .eq('workspace_id', workspaceId)
      .eq('scope_type', 'package')
      .eq('scope_id', pkg.id)
      .maybeSingle(),
  ])

  // A partial provenance export would claim sources it dropped — fail instead.
  const readError = sourcesRes.error ?? linksRes.error
  if (readError) return serverError(readError.message)
  const sources = sourcesRes.data
  const links = linksRes.data

  const sourcesByClaim = new Map<string, Record<string, unknown>[]>()
  for (const s of sources) {
    const key = s.claim_id as string
    ;(sourcesByClaim.get(key) ?? sourcesByClaim.set(key, []).get(key)!).push({
      source_type: s.source_type,
      source_id: s.source_id,
      source_uri: s.source_uri,
      excerpt: s.excerpt,
    })
  }
  const linksByClaim = new Map<string, Record<string, unknown>[]>()
  for (const l of links) {
    const key = l.source_id as string
    ;(linksByClaim.get(key) ?? linksByClaim.set(key, []).get(key)!).push({
      target_type: l.target_type,
      target_id: l.target_id,
      relation: l.relation,
    })
  }

  const exportedAt = new Date().toISOString()
  const filenameBase = `${pkg.slug || 'knowledge-package'}-${exportedAt.slice(0, 10)}`

  if (format === 'jsonl') {
    const lines: string[] = [
      JSON.stringify({
        kind: 'dial8.knowledge_package',
        version: 1,
        exported_at: exportedAt,
        package: {
          id: pkg.id,
          name: pkg.name,
          slug: pkg.slug,
          description: pkg.description,
          rules: pkg.rules,
        },
        claim_count: (claims ?? []).length,
        brief: brief?.content ?? null,
      }),
      ...(claims ?? []).map((c) =>
        JSON.stringify({
          kind: 'claim',
          id: c.id,
          text: c.text,
          type: c.type,
          confidence: c.confidence,
          confirmation: c.confirmation,
          created_at: c.created_at,
          updated_at: c.updated_at,
          sources: sourcesByClaim.get(c.id as string) ?? [],
          links: linksByClaim.get(c.id as string) ?? [],
        }),
      ),
    ]
    return new Response(lines.join('\n') + '\n', {
      headers: {
        'Content-Type': 'application/jsonl; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filenameBase}.jsonl"`,
      },
    })
  }

  // Markdown
  const TYPE_HEADINGS: Record<string, string> = {
    fact: 'Facts',
    decision_summary: 'Decisions',
    open_question: 'Open questions',
    inference: 'Inferences',
  }
  const byType = new Map<string, typeof claims>()
  for (const c of claims ?? []) {
    const key = (c.type as string) || 'fact'
    ;(byType.get(key) ?? byType.set(key, []).get(key)!)!.push(c)
  }

  const md: string[] = [
    `# ${pkg.name}`,
    '',
    ...(pkg.description ? [String(pkg.description), ''] : []),
    `> Knowledge package exported from Native Intelligence on ${exportedAt.slice(0, 10)} — ${(claims ?? []).length} claims with provenance. Every claim traces back to a recorded source.`,
    '',
  ]
  if (brief?.content) {
    md.push('## Brief', '', String(brief.content), '', '---', '')
  }
  for (const type of ['decision_summary', 'fact', 'open_question', 'inference']) {
    const group = byType.get(type)
    if (!group?.length) continue
    md.push(`## ${TYPE_HEADINGS[type]}`, '')
    for (const c of group) {
      const conf =
        c.confirmation === 'confirmed' ? 'confirmed' : 'unconfirmed'
      md.push(
        `- ${c.text} _(${conf}${c.confidence != null ? `, confidence ${c.confidence}` : ''})_`,
      )
      for (const s of (sourcesByClaim.get(c.id as string) ?? []).slice(0, 3)) {
        const anchor = s.source_uri || s.source_id || ''
        md.push(
          `  - source: ${s.source_type}${anchor ? ` ${anchor}` : ''}${s.excerpt ? ` — "${String(s.excerpt).slice(0, 160)}"` : ''}`,
        )
      }
    }
    md.push('')
  }

  return new Response(md.join('\n'), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filenameBase}.md"`,
    },
  })
}
