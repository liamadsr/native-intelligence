import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { ALL_FEATURE_GATED_RECIPE_IDS } from '@/lib/editions'
import { excludeFeatureGatedRecipes } from '@/lib/library/feature-gate'
import { MARKETPLACE_CARD_FIELDS } from '@/lib/library/queries'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import type { LibraryCategory } from '@/lib/types/library'

const VALID_CATEGORIES: LibraryCategory[] = ['skill', 'agent']

/**
 * Marketplace browse endpoint — returns system items + public community items.
 * Replaces the deprecated /api/marketplace/recipes endpoint. Filter with
 * ?category=skill|agent.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  const { searchParams } = request.nextUrl
  const category = searchParams.get('category')
  const marketplaceCategory = searchParams.get('marketplace_category')
  const featured = searchParams.get('featured')
  // Stripped of `.or()` syntax so user text can't end its condition or add new ones.
  const search = toIlikeSearchTerm(searchParams.get('search') ?? '')
  const sort = searchParams.get('sort') || 'popular'
  const rawLimit = parseInt(searchParams.get('limit') || '50', 10)
  const rawOffset = parseInt(searchParams.get('offset') || '0', 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

  // Feature-owned system skills are excluded UNCONDITIONALLY here: the
  // marketplace is a public browse surface with no workspace in scope, and a
  // feature-gated system skill is internal plumbing, never marketplace content.
  let query = excludeFeatureGatedRecipes(
    supabase
      .from('recipe')
      .select(MARKETPLACE_CARD_FIELDS, { count: 'exact' })
      .or('is_system.eq.true,visibility.eq.public'),
    ALL_FEATURE_GATED_RECIPE_IDS,
  )

  if (category && VALID_CATEGORIES.includes(category as LibraryCategory)) {
    query = query.eq('category', category)
  }

  if (marketplaceCategory) query = query.eq('marketplace_category', marketplaceCategory)
  if (featured === 'true') query = query.eq('featured', true)
  if (search) query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`)

  if (sort === 'recent') {
    query = query.order('created_at', { ascending: false })
  } else {
    query = query.order('fork_count', { ascending: false })
  }

  query = query.range(offset, offset + limit - 1)

  const { data, count, error } = await query

  if (error) return serverError(error.message)
  return NextResponse.json({ items: data || [], total: count || 0 })
}
