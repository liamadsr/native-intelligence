/**
 * The Gmail calls the push path makes: the history since a checkpoint (which
 * threads changed) and the profile (a fresh checkpoint). No message bodies
 * are fetched here: the index reads each thread's metadata
 * (src/lib/crm/email-sync.ts), and Native Intelligence stores no mail (2026-10-15).
 */

// =====================================================================
// Fetch history (changes since last sync)
// =====================================================================

export async function fetchGmailHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ history: any[]; historyId: string }> {
  let allHistory: any[] = []
  let pageToken: string | undefined
  let latestHistoryId = startHistoryId

  do {
    const params = new URLSearchParams({ startHistoryId })
    params.append('historyTypes', 'messageAdded')
    params.append('historyTypes', 'messageDeleted')
    params.append('historyTypes', 'labelAdded')
    params.append('historyTypes', 'labelRemoved')
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )

    if (res.status === 404) {
      throw new Error('HISTORY_EXPIRED')
    }

    if (!res.ok) {
      throw new Error(`Gmail history error: ${res.status}`)
    }

    const data = await res.json()
    if (data.history) allHistory.push(...data.history)
    latestHistoryId = data.historyId || latestHistoryId
    pageToken = data.nextPageToken
  } while (pageToken)

  return { history: allHistory, historyId: latestHistoryId }
}

// =====================================================================
// Fetch Gmail user profile (for historyId)
// =====================================================================

export async function fetchGmailProfile(accessToken: string) {
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error(`Gmail profile error: ${res.status}`)
  return res.json() as Promise<{ emailAddress: string; historyId: string }>
}
