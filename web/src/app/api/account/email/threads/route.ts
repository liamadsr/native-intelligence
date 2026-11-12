import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getWorkspaceEmailAccountIds, readableWorkspaceEmailAccounts } from '@/lib/email/account-scope'
import { searchThreadsLive } from '@/lib/email/live-thread-search'
import { searchResultRows } from '@/lib/email/search-result-rows'
import { heldThreadsFor } from '@/lib/email/held-threads'
import { NextResponse, type NextRequest } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { searchParams } = new URL(request.url)
  const folder = searchParams.get('folder') || 'inbox'
  const page = parseInt(searchParams.get('page') || '1')
  const perPage = parseInt(searchParams.get('per_page') || '50')
  const search = searchParams.get('search') || ''
  const unreadOnly = searchParams.get('unread_only') === 'true'
  const needsReply = searchParams.get('needs_reply') === 'true'
  const isStarred = searchParams.get('is_starred')
  const hasAttachments = searchParams.get('has_attachments')
  const fromEmail = searchParams.get('from_email')
  const fromEmailContains = searchParams.get('from_email_contains')
  const autoClassified = searchParams.get('auto_classified')
  const accountIds = searchParams.get('accountIds')
    ? searchParams.get('accountIds')!.split(',').filter(Boolean)
    : null
  // A mail card in the chat lists exactly what show and read_card count: the
  // person's ENABLED mailboxes here (readableWorkspaceEmailAccounts), searched
  // with the same filter. The Mail page leaves this off and lists as before.
  const readableOnly = searchParams.get('readable') === '1'
  // A tag (Liam, 11-11: the Mail sub-nav's Tags, "any tags that are available
  // for email"): only the threads wearing that label (email_thread_label,
  // indexed by label_id; its RLS keeps it to the person's own threads).
  const labelId = searchParams.get('label_id')
  if (labelId && !UUID_RE.test(labelId)) return NextResponse.json({ error: 'Invalid label_id' }, { status: 400 })

  // Resolve which accounts are assigned to this workspace via junction table
  // (self-heals an empty junction so a freshly-connected inbox isn't blank).
  let scopedAccountIds =
    accountIds ?? (await getWorkspaceEmailAccountIds(supabase, user.id, workspaceId))
  if (readableOnly) {
    const readable = new Set((await readableWorkspaceEmailAccounts(user.id, workspaceId)).map((a) => a.id))
    scopedAccountIds = scopedAccountIds.filter((id) => readable.has(id))
  }

  // A thread has a copy per workspace its mailbox is linked to (each with that
  // workspace's own contact link and labels); this workspace lists its own.
  let query = supabase
    .from('email_thread_index')
    .select('*, connected_account:account_id(id, account_email, display_name, color)', { count: 'exact' })
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)

  // Filter by workspace-scoped accounts
  if (scopedAccountIds?.length) {
    query = query.in('account_id', scopedAccountIds)
  } else {
    // No accounts assigned to this workspace — return empty
    return NextResponse.json({ threads: [], total: 0, page, per_page: perPage, has_more: false })
  }

  // Folder filtering. "To review" (the holding pattern, src/lib/email/hold.ts)
  // is the person's held threads: the ones Native Intelligence drafted a reply to.
  const held = await heldThreadsFor(supabase, { userId: user.id, workspaceId })

  // Search: the provider's hits ARE the results (no stored mail: the index
  // holds 30 days of pointers, so keeping only the hits it knows dropped older
  // mail). Rendered from the provider's headers, with the index's flags and
  // labels merged in where it has the thread; the folder is the provider's
  // own (Gmail `in:`, Graph's folder). "To review" searches its held threads.
  if (search && folder !== 'review') {
    const found = await searchThreadsLive(user.id, workspaceId, {
      query: search,
      folder,
      accountIds: scopedAccountIds,
      unreadOnly,
      hasAttachments: hasAttachments === 'true',
      from: fromEmail || fromEmailContains || null,
      cursor: searchParams.get('cursor'),
    })
    const rows = await searchResultRows(supabase, {
      userId: user.id,
      workspaceId,
      hits: found.hits,
      held,
      filters: {
        isStarred: isStarred === 'true' ? true : isStarred === 'false' ? false : null,
        needsReply,
        autoClassified: autoClassified || null,
      },
    })
    const tagged = labelId ? rows.filter((r) => (r.labels as { id: string }[] | undefined)?.some((l) => l.id === labelId)) : rows
    return NextResponse.json({
      threads: tagged,
      total: tagged.length,
      page,
      per_page: perPage,
      has_more: !!found.cursor,
      cursor: found.cursor,
      source: 'provider',
    })
  }

  if (labelId) {
    const { data: tagged, error: tagError } = await supabase.from('email_thread_label').select('thread_id').eq('label_id', labelId)
    if (tagError) return NextResponse.json({ error: tagError.message }, { status: 500 })
    const ids = (tagged ?? []).map((r) => r.thread_id as string)
    if (!ids.length) return NextResponse.json({ threads: [], total: 0, page, per_page: perPage, has_more: false })
    query = query.in('id', ids)
  }

  if (folder === 'review') {
    if (!held.length) return NextResponse.json({ threads: [], total: 0, page, per_page: perPage, has_more: false })
    query = query.in('provider_thread_id', held.map((h) => h.provider_thread_id))
  } else if (folder === 'starred') {
    query = query.eq('is_starred', true)
  } else if (folder === 'all') {
    query = query.not('folder', 'in', '(trash,spam)')
  } else {
    query = query.eq('folder', folder)
  }

  // "To review" with a search: its held threads whose subject (from the hold)
  // or sender has the text. Every other search returned above, from the provider.
  if (search) {
    const text = search.toLowerCase()
    const ids = held
      .filter((h) => (h.subject ?? '').toLowerCase().includes(text))
      .map((h) => h.provider_thread_id)
    const safe = search.replace(/[,()\\*%"]/g, ' ').replace(/\s+/g, ' ').trim()
    const parts = [
      ...(safe ? [`from_email.ilike.%${safe}%`] : []),
      ...(ids.length ? [`provider_thread_id.in.(${ids.map((id) => `"${id.replace(/"/g, '')}"`).join(',')})`] : []),
    ]
    if (!parts.length) return NextResponse.json({ threads: [], total: 0, page, per_page: perPage, has_more: false })
    query = query.or(parts.join(','))
  }
  if (unreadOnly) query = query.eq('is_unread', true)
  if (needsReply) query = query.eq('needs_reply', true)
  if (isStarred === 'true') query = query.eq('is_starred', true)
  if (isStarred === 'false') query = query.eq('is_starred', false)
  if (hasAttachments === 'true') query = query.eq('has_attachments', true)
  if (hasAttachments === 'false') query = query.eq('has_attachments', false)
  if (fromEmail) query = query.eq('from_email', fromEmail)
  if (fromEmailContains) query = query.ilike('from_email', `%${fromEmailContains}%`)
  if (autoClassified) query = query.eq('auto_classified', autoClassified)

  query = query.order('last_message_at', { ascending: false, nullsFirst: false })
  query = query.range((page - 1) * perPage, page * perPage - 1)

  const { data, count, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const threads = data || []

  // Try to fetch labels for these threads (gracefully skip if table doesn't exist yet)
  let labelsByThread: Record<string, { id: string; name: string; color: string }[]> = {}
  if (threads.length > 0) {
    try {
      const threadIds = threads.map((t) => t.id)
      const { data: labelData } = await supabase
        .from('email_thread_label')
        .select('thread_id, label:label(id, name, color)')
        .in('thread_id', threadIds)

      if (labelData) {
        for (const row of labelData) {
          const label = row.label as unknown as { id: string; name: string; color: string } | null
          if (!label) continue
          if (!labelsByThread[row.thread_id]) labelsByThread[row.thread_id] = []
          labelsByThread[row.thread_id].push(label)
        }
      }
    } catch {
      // Table may not exist yet — labels will be empty
    }
  }

  // A held thread's subject comes from its hold (no live call); the row says
  // it is held, and whether its draft went stale or email.trust flagged it.
  const heldBy = new Map(held.map((h) => [`${h.account_id ?? ''}:${h.provider_thread_id}`, h]))
  const threadsWithLabels = threads.map((thread) => {
    const hold = heldBy.get(`${thread.account_id ?? ''}:${thread.provider_thread_id}`)
    return {
      ...thread,
      labels: labelsByThread[thread.id] || [],
      ...(hold ? { held: true, held_subject: hold.subject, held_stale: hold.stale } : {}),
    }
  })

  return NextResponse.json({
    threads: threadsWithLabels,
    total: count || 0,
    page,
    per_page: perPage,
    has_more: (count || 0) > page * perPage,
  })
}
