/**
 * /api/account/seo/keywords/saved: the workspace's saved keywords. Nothing
 * here costs money; any member may read and change them.
 *
 *   GET     ?offset=&limit=&search=&tag=a&tag=b&location_code=&sort=&dir=
 *           &min_volume=&max_volume=&min_difficulty=&max_difficulty=
 *           → SavedKeywordPage & { tags: SavedKeywordTagCount[], max }.
 *           `tag` (repeatable) matches keywords carrying ANY of them.
 *   POST    { keywords, location_code?, language_code?, metrics?, tags?, note? }
 *           save keywords in one market (already-saved ones gain the tags,
 *           and the metrics when given) → { added, already_saved, rows }.
 *           409 SAVED_KEYWORDS_FULL past 10,000 per workspace.
 *   PATCH   { ids, add_tags?, remove_tags?, set_tags?, note? }
 *           retag or annotate → { updated, rows }. 404 when none is ours.
 *   DELETE  { ids } → { removed }. Ids that are not this workspace's are ignored.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import {
  addSavedKeywords,
  listSavedKeywords,
  removeSavedKeywords,
  savedKeywordTagCounts,
  updateSavedKeywords,
  type SavedKeywordWriteFailure,
} from '@/lib/seo/keywords/saved'
import {
  KEYWORD_INTENTS,
  SAVED_KEYWORD_SORTS,
  SAVED_KEYWORDS_MAX,
  SAVED_KEYWORDS_PER_ADD,
} from '@/lib/seo/keywords/view'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function failure(out: SavedKeywordWriteFailure) {
  const status =
    out.code === 'SAVED_KEYWORDS_FULL'
      ? 409
      : out.code === 'NOT_FOUND'
        ? 404
        : 400
  return apiError(out.message, { status, code: out.code })
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const search = request.nextUrl.searchParams
  const sort = search.get('sort')
  const dir = search.get('dir')
  if (
    sort !== null &&
    !(SAVED_KEYWORD_SORTS as readonly string[]).includes(sort)
  )
    return badRequest('Unknown sort')
  if (dir !== null && dir !== 'asc' && dir !== 'desc')
    return badRequest('dir is asc or desc')
  try {
    const svc = getServiceClient()
    const [page, tags] = await Promise.all([
      listSavedKeywords(svc, auth.workspaceId, {
        offset: numberParam(search.get('offset')),
        limit: numberParam(search.get('limit')),
        search: search.get('search')?.slice(0, 200) ?? undefined,
        tags: search.getAll('tag').slice(0, 20),
        location_code: numberParam(search.get('location_code')),
        min_volume: numberParam(search.get('min_volume')),
        max_volume: numberParam(search.get('max_volume')),
        min_difficulty: numberParam(search.get('min_difficulty')),
        max_difficulty: numberParam(search.get('max_difficulty')),
        sort: (sort ?? undefined) as
          | (typeof SAVED_KEYWORD_SORTS)[number]
          | undefined,
        dir: (dir ?? undefined) as 'asc' | 'desc' | undefined,
      }),
      savedKeywordTagCounts(svc, auth.workspaceId),
    ])
    return NextResponse.json({ ...page, tags, max: SAVED_KEYWORDS_MAX })
  } catch (err) {
    console.error('[seo-saved-keywords] list failed', err)
    return serverError('Could not load your saved keywords just now.')
  }
}

const Metric = z.object({
  keyword: z.string().max(200),
  search_volume: z.number().nonnegative().nullish(),
  cpc: z.number().nonnegative().nullish(),
  competition: z.number().min(0).max(1).nullish(),
  keyword_difficulty: z.number().min(0).max(100).nullish(),
  intent: z.enum(KEYWORD_INTENTS).nullish(),
  trend: z
    .array(
      z.object({
        year: z.number().int(),
        month: z.number().int().min(1).max(12),
        search_volume: z.number().nonnegative(),
      }),
    )
    .max(24)
    .optional(),
})

const AddBody = z.object({
  keywords: z.array(z.string().max(200)).min(1).max(SAVED_KEYWORDS_PER_ADD),
  location_code: z.number().int().positive().nullish(),
  language_code: z.string().trim().min(2).max(10).nullish(),
  metrics: z.array(Metric).max(SAVED_KEYWORDS_PER_ADD).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
  note: z.string().max(4000).nullish(),
})

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = AddBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const { metrics, ...rest } = parsed.data
    const out = await addSavedKeywords(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      {
        ...rest,
        metrics: metrics?.map((metric) => ({
          keyword: metric.keyword,
          search_volume: metric.search_volume ?? null,
          cpc: metric.cpc ?? null,
          competition: metric.competition ?? null,
          keyword_difficulty: metric.keyword_difficulty ?? null,
          intent: metric.intent ?? 'unknown',
          trend: metric.trend ?? [],
        })),
      },
    )
    if (!out.ok) return failure(out)
    return NextResponse.json(
      { added: out.added, already_saved: out.already_saved, rows: out.rows },
      { status: out.added > 0 ? 201 : 200 },
    )
  } catch (err) {
    console.error('[seo-saved-keywords] add failed', err)
    return serverError('Could not save those keywords just now.')
  }
}

const Ids = z
  .array(z.string().regex(UUID, 'Not a saved keyword id'))
  .min(1)
  .max(SAVED_KEYWORDS_PER_ADD)

const PatchBody = z.object({
  ids: Ids,
  add_tags: z.array(z.string().max(80)).max(20).optional(),
  remove_tags: z.array(z.string().max(80)).max(20).optional(),
  set_tags: z.array(z.string().max(80)).max(20).nullish(),
  note: z.string().max(4000).nullish(),
})

export async function PATCH(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = PatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const out = await updateSavedKeywords(
      getServiceClient(),
      auth.workspaceId,
      parsed.data,
    )
    if (!out.ok) return failure(out)
    return NextResponse.json({ updated: out.updated, rows: out.rows })
  } catch (err) {
    console.error('[seo-saved-keywords] update failed', err)
    return serverError('Could not change those keywords just now.')
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = z
    .object({ ids: Ids })
    .safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const out = await removeSavedKeywords(
      getServiceClient(),
      auth.workspaceId,
      parsed.data.ids,
    )
    return NextResponse.json({ removed: out.removed })
  } catch (err) {
    console.error('[seo-saved-keywords] delete failed', err)
    return serverError('Could not remove those keywords just now.')
  }
}
