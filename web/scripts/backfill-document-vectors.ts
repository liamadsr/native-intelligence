/**
 * Back-fill document vectors (documents phase 1, item 5;
 * docs/plans/documents-as-ground-truth.md). On PROD (2026-10-19) 121 of 191
 * documents had no rows in document_chunks, so search found them by keyword
 * only: skill reports were never indexed, and older documents predate
 * indexing on write.
 *
 * For every active document with a body worth embedding (40+ characters) and
 * no chunks yet, it runs the same indexDocument the write paths run
 * (src/lib/ai/embeddings.ts): section-aware chunks with their headings,
 * embedded, then swapped in with replace_document_chunks (migration 365).
 * Documents that already have chunks are left alone (their next edit
 * re-indexes them with headings). Re-runnable: an indexed document is skipped.
 *
 * PREFLIGHT first: document_chunks.heading and replace_document_chunks
 * (migration 365) must exist, or the run stops before reading a document.
 *
 * DRY-RUN by default: prints counts (per workspace, and how many characters
 * would be embedded), writes nothing. Pass --execute to embed and write. It
 * prints ids and counts only, never a title or any content. Embedding costs
 * a little (text-embedding-3-small through the AI Gateway, logged per run to
 * ai_usage_logs under the document creator's user).
 *
 * Usage:
 *   npx tsx scripts/backfill-document-vectors.ts [--execute] [--workspace <id>] [--limit <n>] [--env-file <path>]
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — the anon key silently reads/writes 0 rows under RLS.
 *   AI_GATEWAY_API_KEY          — for --execute (embeddings).
 * Read from --env-file when given, and then the file WINS over anything already
 * exported in the shell. With no --env-file, .env.local fills only what isn't
 * exported. The script prints its target host first: check it before
 * --execute. It never prints a key.
 *
 * PROD (with Liam's word, after migration 365), from a checkout of this branch:
 *   npx tsx scripts/backfill-document-vectors.ts --env-file <main checkout>/.env.production.local
 *   npx tsx scripts/backfill-document-vectors.ts --env-file <main checkout>/.env.production.local --execute
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

const arg = (flag: string) => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? (process.argv[at + 1] ?? null) : null
}

const ENV_FILE = arg('--env-file')
config({ path: ENV_FILE ?? '.env.local', override: ENV_FILE !== null, quiet: true })

const EXECUTE = process.argv.includes('--execute')
const WORKSPACE_FILTER = arg('--workspace')
const LIMIT = Number(arg('--limit') ?? 0) || Infinity
/** Below this a body has no signal worth a vector (embeddings.ts MIN_DOCUMENT_INDEX_CHARS). */
const MIN_CHARS = 40

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
if (EXECUTE && !process.env.AI_GATEWAY_API_KEY) throw new Error('Missing AI_GATEWAY_API_KEY (needed to embed)')

interface DocRow {
  id: string
  workspace_id: string
  project_id: string | null
  content: string | null
  created_by: string | null
}

async function preflight(supabase: SupabaseClient): Promise<string | null> {
  const heading = await supabase.from('document_chunks').select('heading').limit(1)
  if (heading.error) return `document_chunks.heading is missing (apply migration 365): ${heading.error.message}`
  // An empty swap of a random id. Since 365's cross-workspace guard, the
  // function refuses an id that isn't in the workspace ("… is not in
  // workspace …"): that refusal proves it exists. Only "function not found"
  // (PostgREST PGRST202) means 365 is missing.
  const fn = await supabase.rpc('replace_document_chunks', {
    p_document_id: '00000000-0000-0000-0000-000000000000',
    p_workspace_id: '00000000-0000-0000-0000-000000000000',
    p_project_id: null,
    p_rows: [],
  })
  if (fn.error && !/is not in workspace/i.test(fn.error.message)) {
    return `replace_document_chunks is missing (apply migration 365): ${fn.error.message}`
  }
  return null
}

/** Every active document worth indexing that has no chunks, in pages. */
async function unindexed(supabase: SupabaseClient): Promise<DocRow[]> {
  const out: DocRow[] = []
  const PAGE = 500
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('document')
      .select('id, workspace_id, project_id, content, created_by')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
    const { data, error } = await q
    if (error) throw new Error(`document read failed: ${error.message}`)
    const rows = (data ?? []) as DocRow[]
    const worth = rows.filter((d) => (d.content ?? '').trim().length >= MIN_CHARS)
    if (worth.length) {
      // One existence check per document. A single .in() over many documents
      // returns every chunk row and PostgREST caps a response at 1000 rows, so
      // once documents have many chunks, indexed ones looked unindexed.
      for (const d of worth) {
        const { count, error: chunkErr } = await supabase
          .from('document_chunks')
          .select('document_id', { count: 'exact', head: true })
          .eq('document_id', d.id)
        if (chunkErr) throw new Error(`document_chunks read failed: ${chunkErr.message}`)
        if (!count) out.push(d)
      }
    }
    if (rows.length < PAGE) break
  }
  return out
}

/** The user an embedding is logged under: the document's creator, else a member of its workspace. */
async function userFor(supabase: SupabaseClient, doc: DocRow, cache: Map<string, string | null>): Promise<string | null> {
  const key = doc.created_by ?? `ws:${doc.workspace_id}`
  if (cache.has(key)) return cache.get(key)!
  const q = doc.created_by
    ? supabase.from('member').select('user_id').eq('id', doc.created_by).maybeSingle()
    : supabase.from('member').select('user_id').eq('workspace_id', doc.workspace_id).in('role', ['owner', 'admin']).limit(1).maybeSingle()
  const { data } = await q
  const userId = (data as { user_id?: string | null } | null)?.user_id ?? null
  cache.set(key, userId)
  return userId
}

async function main() {
  console.log(`Target: ${new URL(SUPABASE_URL!).host}${WORKSPACE_FILTER ? `, workspace ${WORKSPACE_FILTER}` : ''}`)
  console.log(EXECUTE ? 'EXECUTE: embedding and writing chunks.' : 'DRY RUN: nothing is written. Pass --execute to embed.')
  const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!, { auth: { persistSession: false } })

  const stop = await preflight(supabase)
  if (stop) {
    console.error(`Preflight: ${stop}`)
    process.exit(1)
  }

  const docs = (await unindexed(supabase)).slice(0, LIMIT)
  const byWorkspace = new Map<string, { docs: number; chars: number }>()
  for (const d of docs) {
    const w = byWorkspace.get(d.workspace_id) ?? { docs: 0, chars: 0 }
    w.docs++
    w.chars += (d.content ?? '').length
    byWorkspace.set(d.workspace_id, w)
  }
  console.log(`Documents with no vectors: ${docs.length} in ${byWorkspace.size} workspace(s).`)
  for (const [ws, w] of byWorkspace) console.log(`  ${ws}: ${w.docs} documents, ${w.chars} characters`)
  if (!EXECUTE || docs.length === 0) return

  // Loaded only for --execute: the embedding path and its usage logging.
  const { indexDocument } = await import('../src/lib/ai/embeddings')
  const users = new Map<string, string | null>()
  let indexed = 0
  let chunks = 0
  const failed: string[] = []
  for (const d of docs) {
    try {
      const userId = (await userFor(supabase, d, users)) ?? ''
      const res = await indexDocument(supabase, d.id, userId, d.project_id, d.content, d.workspace_id)
      indexed++
      chunks += res.chunksCreated
      if (indexed % 10 === 0) console.log(`  ${indexed}/${docs.length} indexed`)
    } catch (err) {
      failed.push(d.id)
      console.error(`  ${d.id}: failed (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`)
    }
  }
  console.log(`Done: ${indexed} documents indexed, ${chunks} chunks; ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}.`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
