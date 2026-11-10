import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { requestVocabularyHarvest } from '@/lib/vocabulary/harvest-trigger'
import {
  addVocabularyTerm,
  automaticVocabulary,
  compileVocabulary,
  listVocabulary,
  type VocabularyScope,
  type VocabularySource,
  type VocabularyStatus,
} from '@/lib/vocabulary/store'

/**
 * /api/account/vocabulary — custom vocabulary (migration 430,
 * docs/plans/custom-vocabulary.md §10).
 *
 *   GET                 → { terms, automatic }: the workspace's words and the
 *                         caller's own (every status; harvested ones are
 *                         source 'workspace'), and the names Native Intelligence adds
 *                         automatically.
 *   GET ?view=compiled  → { entries, version, counts, workspaceId, userId }:
 *                         what transcription uses (src/lib/vocabulary/client.ts
 *                         keys its cache on the workspace and person). Also
 *                         asks for a harvest refresh (at most hourly).
 *   POST { term, sounds_like?, scope?: 'workspace' | 'personal', hide?: true }
 *                       → { term, created }. `hide` turns an automatic name or
 *                         a harvested word off for the caller only (a personal
 *                         'dismissed' row, source 'auto').
 *
 * Fenced on the workspace and on "the workspace's or mine" in the store, so a
 * service-role client answers like RLS would.
 */

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  try {
    if (new URL(request.url).searchParams.get('view') === 'compiled') {
      const compiled = await compileVocabulary(supabase, { workspaceId, userId: user.id })
      // Keep the harvested words (what the team writes) fresh: at most hourly, debounced.
      requestVocabularyHarvest(workspaceId, user.id)
      return NextResponse.json({ ...compiled, workspaceId, userId: user.id }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const [terms, automatic] = await Promise.all([
      listVocabulary(supabase, { workspaceId, userId: user.id }),
      automaticVocabulary(supabase, { workspaceId, userId: user.id }).catch(() => []),
    ])
    return NextResponse.json({ terms, automatic })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not load the vocabulary')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send { term, sounds_like?, scope? }')

  const hide = body.hide === true
  const scope: VocabularyScope = hide ? 'personal' : body.scope === 'personal' ? 'personal' : 'workspace'
  if (body.scope !== undefined && body.scope !== 'workspace' && body.scope !== 'personal') {
    return badRequest('scope must be workspace or personal')
  }
  const source: VocabularySource = hide ? 'auto' : 'manual'
  const status: VocabularyStatus = hide ? 'dismissed' : 'active'

  const result = await addVocabularyTerm(supabase, {
    workspaceId,
    userId: user.id,
    scope,
    term: body.term,
    soundsLike: hide ? [] : body.sounds_like,
    source,
    status,
  })
  if (!result.ok) return result.status === 400 ? badRequest(result.message) : apiError(result.message, { status: result.status })
  return NextResponse.json({ term: result.term, created: result.created }, { status: result.created ? 201 : 200 })
}
