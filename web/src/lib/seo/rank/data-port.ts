/**
 * The search data provider as a rank check uses it (./engine.ts):
 *
 *   post         the metered task_post. The same composition as
 *                seoDataClient (../data-client.ts): this workspace's meter
 *                (the monthly ceiling before the call, the ledger after it)
 *                in front of the provider client, plus an observer on the
 *                meter's exec that reads what the provider charged, so the
 *                check can record its real cost. The ledger row is the
 *                meter's, unchanged; userId is the person who asked, null for
 *                a scheduled check.
 *   collect      the free task_get (never metered: the search was paid for
 *                at task_post).
 *   resolveGoto  the free goto converter.
 */
import {
  createDataforseoClient,
  DataforseoChargedTaskError,
  fetchRankCheckTaskResult,
  resolveGotoUrls,
  type DataforseoMeter,
} from '@/lib/seo/dataforseo'
import { createWorkspaceMeter } from '@/lib/seo/spend'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import type { RankDataPort } from './engine'

/** A meter that reports each call's billed cost to `onBilled`, and otherwise is `inner`. */
export function observingMeter(
  inner: DataforseoMeter,
  onBilled: (usd: number) => void,
): DataforseoMeter {
  return {
    run: (call) =>
      inner.run({
        ...call,
        exec: async () => {
          try {
            const response = await call.exec()
            onBilled(response.billing.costUsd)
            return response
          } catch (error) {
            if (error instanceof DataforseoChargedTaskError)
              onBilled(error.billing.costUsd)
            throw error
          }
        },
      }),
  }
}

export function rankDataPort(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string | null },
): RankDataPort {
  let billed = 0
  const client = createDataforseoClient(
    observingMeter(createWorkspaceMeter(svc, who), (usd) => {
      billed += Math.max(0, usd)
    }),
  )
  return {
    async post(input) {
      const before = billed
      const posted = await client.serp.rankCheckTaskPost(input)
      return { posted, costUsd: billed - before }
    },
    collect: (input) => fetchRankCheckTaskResult(input),
    resolveGoto: (urls) => resolveGotoUrls(urls),
  }
}
