/**
 * The client a local rank scan posts through: the same composition as
 * seoDataClient (../data-client.ts), this workspace's meter (the monthly
 * ceiling before the call, the ledger after it) in front of the provider
 * client, plus an observer on the meter's exec that adds up what the
 * provider charged. The scan records that number per keyword
 * (./scan-engine.ts postKeyword), so its cost_usd is the real charge, the
 * same way a rank check records its own (../rank/data-port.ts). The ledger
 * row is the meter's, unchanged; userId is the person who started the scan.
 */
import { createDataforseoClient } from '@/lib/seo/dataforseo'
import { observingMeter } from '@/lib/seo/rank/data-port'
import { createWorkspaceMeter } from '@/lib/seo/spend'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import type { ScanPostClient } from './scan-engine'

export function localScanClient(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string | null },
): ScanPostClient {
  let billed = 0
  const client = createDataforseoClient(
    observingMeter(createWorkspaceMeter(svc, who), (usd) => {
      billed += Math.max(0, Number.isFinite(usd) ? usd : 0)
    }),
  )
  return { serp: client.serp, billedUsd: () => billed }
}
