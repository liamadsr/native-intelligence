import { getServiceClient } from '@/lib/admin'
import { getValidToken, getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { readableWorkspaceEmailAccounts } from './account-scope'

/**
 * Which mailbox holds a thread, for a live read (no stored mail, 2026-10-15:
 * every read of a person's mail goes to Gmail or Graph). A thread is read from
 * ITS OWN mailbox, never the person's first token:
 *   1. the account the caller names (the thread index row's account_id);
 *   2. else the account the person's own index row for the thread names;
 *   3. else each mailbox the workspace may read (readableWorkspaceEmailAccounts),
 *      or, with no workspace, each of the person's email accounts, in order,
 *      for a thread found some other way (a provider search result);
 *   4. a legacy row with no account: the person's token for its provider.
 * Every account is checked to be the person's own enabled email account
 * before its token is used: getValidTokenForAccount is keyed by account alone.
 */

export interface LiveMailbox {
  provider: 'google' | 'microsoft'
  token: string
  email: string | null
  accountId: string | null
}

type Provider = 'google' | 'microsoft'

function isProvider(value: unknown): value is Provider {
  return value === 'google' || value === 'microsoft'
}

/** The person's own enabled email account's token, or null. Never throws. */
export async function ownedMailbox(userId: string, accountId: string): Promise<LiveMailbox | null> {
  try {
    const { data: account, error } = await getServiceClient()
      .from('connected_account')
      .select('id, provider')
      .eq('id', accountId)
      .eq('user_id', userId)
      .eq('capability', 'email')
      .eq('is_enabled', true)
      .maybeSingle()
    if (error || !account || !isProvider(account.provider)) return null
    const token = await getValidTokenForAccount(accountId)
    if (!token || token.accountId !== accountId) return null
    return { provider: account.provider, token: token.token, email: token.email ?? null, accountId }
  } catch {
    return null
  }
}

async function legacyMailbox(userId: string, provider: Provider): Promise<LiveMailbox | null> {
  try {
    const token = await getValidToken(userId, provider, 'email')
    return token ? { provider, token: token.token, email: token.email ?? null, accountId: null } : null
  } catch {
    return null
  }
}

/** The person's own index row for the thread: its account and provider. */
async function indexedMailboxRef(
  userId: string,
  providerThreadId: string,
  workspaceId?: string,
): Promise<{ accountId: string | null; provider: Provider } | null> {
  try {
    let query = getServiceClient()
      .from('email_thread_index')
      .select('account_id, provider')
      .eq('user_id', userId)
      .eq('provider_thread_id', providerThreadId)
    if (workspaceId) query = query.eq('workspace_id', workspaceId)
    const { data, error } = await query.limit(1).maybeSingle()
    if (error || !data || !isProvider(data.provider)) return null
    return { accountId: (data.account_id as string | null) ?? null, provider: data.provider }
  } catch {
    return null
  }
}

/**
 * The mailboxes to try for a thread, best first, resolved lazily: the caller
 * stops at the first one whose read finds the thread.
 */
export async function* mailboxesForThread(
  userId: string,
  providerThreadId: string,
  opts: { workspaceId?: string; accountId?: string | null; provider?: Provider | null } = {},
): AsyncGenerator<LiveMailbox> {
  const tried = new Set<string>()
  const named = opts.accountId !== undefined
  const ref = named
    ? { accountId: opts.accountId ?? null, provider: opts.provider ?? null }
    : await indexedMailboxRef(userId, providerThreadId, opts.workspaceId)

  if (ref?.accountId) {
    tried.add(ref.accountId)
    const own = await ownedMailbox(userId, ref.accountId)
    if (own) yield own
    // A named account that is not the person's (or can't be read) is the
    // answer: never fall through to another mailbox for that thread.
    return
  }
  // A legacy row (no account, named or indexed): the person's token for its provider.
  if (ref && ref.provider && ref.accountId === null) {
    const legacy = await legacyMailbox(userId, ref.provider)
    if (legacy) yield legacy
    return
  }

  // Unknown thread: each mailbox the workspace may read (or all of the person's).
  let accounts: Array<{ id: string }> = []
  try {
    if (opts.workspaceId) {
      accounts = await readableWorkspaceEmailAccounts(userId, opts.workspaceId)
    } else {
      const { data } = await getServiceClient()
        .from('connected_account')
        .select('id')
        .eq('user_id', userId)
        .eq('capability', 'email')
        .eq('is_enabled', true)
        .order('created_at', { ascending: true })
      accounts = (data ?? []) as Array<{ id: string }>
    }
  } catch {
    accounts = []
  }
  for (const account of accounts) {
    if (tried.has(account.id)) continue
    tried.add(account.id)
    const own = await ownedMailbox(userId, account.id)
    if (own) yield own
  }
  if (accounts.length === 0) {
    for (const provider of ref?.provider ? [ref.provider] : (['google', 'microsoft'] as const)) {
      const legacy = await legacyMailbox(userId, provider)
      if (legacy) {
        yield legacy
        return
      }
    }
  }
}
