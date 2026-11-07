import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse } from 'next/server'
import { fetchAllRows } from '@/lib/supabase/paging'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  // Scope through the project in SQL (an inner embed) rather than sending
  // every workspace project id in `.in()`, which overflowed the URL past a few
  // hundred projects; paged because the result can pass 1000 rows.
  const { data, error } = await fetchAllRows(
    () =>
      supabase
        .from('milestone')
        .select('id, name, project_id, status, target_date, project:projects!inner(workspace_id)')
        .eq('project.workspace_id', workspaceId)
        .order('name', { ascending: true })
        .order('id', { ascending: true }),
    { orderBy: null },
  )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const milestones = data.map(({ project: _project, ...m }) => m)
  return NextResponse.json({ milestones })
}
