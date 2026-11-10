/**
 * The Graph calls the push path makes: the inbox delta since a checkpoint
 * (which conversations changed) and a fresh checkpoint. The delta asks for
 * ids only: the index reads each conversation's metadata
 * (src/lib/crm/email-sync.ts), and Native Intelligence stores no mail (2026-10-15).
 */

/** What the delta returns of a message: which conversation it belongs to. */
export interface OutlookDeltaMessage {
  id: string
  conversationId?: string
}

// =====================================================================
// Get a fresh inbox delta link (incremental checkpoint)
// =====================================================================
//
// Walks /me/mailFolders/inbox/messages/delta to the end to obtain the
// @odata.deltaLink representing "current state". Subsequent fetchOutlookDelta
// calls resume from this link to get only what changed. Inbox-scoped to match
// the webhook subscription resource (me/mailFolders/inbox/messages).
export async function getOutlookDeltaLink(
  accessToken: string,
): Promise<string | undefined> {
  // $deltaToken=latest jumps straight to the end state without paging the whole
  // mailbox — we only want the checkpoint, not the messages here.
  // $select is carried in the delta link: every later round returns ids only.
  let url =
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=latest&$select=id,conversationId'

  for (let i = 0; i < 50; i++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      console.error('Outlook delta-link fetch error:', res.status)
      return undefined
    }
    const data = await res.json()
    if (data['@odata.deltaLink']) return data['@odata.deltaLink']
    if (data['@odata.nextLink']) {
      url = data['@odata.nextLink']
      continue
    }
    return undefined
  }
  return undefined
}

// =====================================================================
// Fetch delta changes (incremental sync)
// =====================================================================

export async function fetchOutlookDelta(
  accessToken: string,
  deltaLink: string,
): Promise<{
  messages: OutlookDeltaMessage[]
  deletedIds: string[]
  nextDeltaLink: string
}> {
  const messages: OutlookDeltaMessage[] = []
  const deletedIds: string[] = []
  let nextDeltaLink = deltaLink
  let url: string = deltaLink

  do {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!res.ok) {
      throw new Error(`Outlook delta error: ${res.status}`)
    }

    const data = await res.json()

    for (const item of data.value || []) {
      if (item['@removed']) {
        deletedIds.push(item.id)
      } else {
        messages.push({ id: item.id, conversationId: item.conversationId })
      }
    }

    if (data['@odata.nextLink']) {
      url = data['@odata.nextLink']
    } else {
      nextDeltaLink = data['@odata.deltaLink'] || deltaLink
      break
    }
  } while (true)

  return { messages, deletedIds, nextDeltaLink }
}
