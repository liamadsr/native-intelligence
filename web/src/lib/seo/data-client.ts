/**
 * The search-data client for one workspace: the DataForSEO client with this
 * workspace's meter in front of every paid call (./spend.ts). Check
 * checkSeoDataAccess (./access.ts) before making one.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createDataforseoClient, type DataforseoClient } from './dataforseo'
import { createWorkspaceMeter } from './spend'

export function seoDataClient(svc: SupabaseClient, who: { workspaceId: string; userId: string | null }): DataforseoClient {
  return createDataforseoClient(createWorkspaceMeter(svc, who))
}
