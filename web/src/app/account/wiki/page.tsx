import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceIdSafe } from '@/lib/workspace'

export const dynamic = 'force-dynamic'

const TYPE_ORDER = ['system', 'entity', 'spec', 'analysis', 'source_summary', 'note'] as const

const TYPE_LABELS: Record<string, string> = {
  system: 'Systems',
  entity: 'Entities',
  spec: 'Specifications',
  analysis: 'Analyses',
  source_summary: 'Source Summaries',
  note: 'Notes',
}

interface DocRow {
  id: string
  title: string
  slug: string | null
  type: string
  tags: string[]
  published_status: string
  updated_at: string
}

export default async function WikiIndexPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const workspaceId = await getCurrentWorkspaceIdSafe()
  if (!workspaceId) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        No workspace selected.
      </div>
    )
  }

  const { data } = await supabase
    .from('document')
    .select('id, title, slug, type, tags, published_status, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    // The person's Now file (migration 440) is no wiki page.
    .neq('kind', 'now')
    .order('updated_at', { ascending: false })
    .limit(500)

  const docs: DocRow[] = (data || []) as DocRow[]

  // Group by type for the sidebar.
  const grouped = new Map<string, DocRow[]>()
  for (const t of TYPE_ORDER) grouped.set(t, [])
  for (const d of docs) {
    const bucket = grouped.get(d.type) ?? grouped.get('note')!
    bucket.push(d)
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Wiki</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {docs.length} {docs.length === 1 ? 'page' : 'pages'} in this workspace
          </p>
        </div>
      </header>

      <div className="space-y-8">
        {TYPE_ORDER.map((t) => {
          const items = grouped.get(t) ?? []
          if (items.length === 0) return null
          return (
            <section key={t}>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {TYPE_LABELS[t] ?? t}
              </h2>
              <ul className="divide-y divide-border rounded-md border border-border">
                {items.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/account/wiki/${d.id}`}
                      className="flex items-baseline justify-between gap-4 px-4 py-3 hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{d.title || '(untitled)'}</span>
                          {d.published_status === 'draft' && (
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                              draft
                            </span>
                          )}
                        </div>
                        {d.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {d.tags.slice(0, 5).map((tag) => (
                              <span
                                key={tag}
                                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {new Date(d.updated_at).toISOString().slice(0, 10)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
