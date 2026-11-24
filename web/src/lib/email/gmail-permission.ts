/**
 * Gmail refusing a change for want of permission (Liam, 11-24: every archive
 * failed). Archive, read, star, labels, mute and trash all go through Gmail's
 * threads/messages modify (or trash), which needs gmail.modify (or the full
 * mail.google.com scope); connections made before it was asked for
 * (lib/oauth/config.ts) hold gmail.readonly and gmail.compose only, and Gmail
 * answers those calls 403. Their connection shows "Update access" in Settings
 * › Connectors (lib/oauth/scope-diff.ts), which asks Google for it again.
 */

/** What the person is told, wherever a Gmail change is refused this way. */
export const GMAIL_NEEDS_PERMISSION = 'Gmail needs permission to change your mail. Update access in Settings › Connectors.'

/** Gmail's codes for a token whose grant doesn't cover the call. */
const SCOPE_CODES = new Set(['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions', 'PERMISSION_DENIED'])

/** True for Gmail's permission refusal: a 403 saying the grant is short, or a 403 with no code to say otherwise. */
export function isGmailPermissionRefusal(status: number, code: string | null | undefined): boolean {
  return status === 403 && (!code || SCOPE_CODES.has(code))
}

/** A provider error answer's code: a short identifier only (safe to report), never its message text. */
export async function providerErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { status?: unknown; code?: unknown; errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }> } }
    const e = body?.error
    const candidates = [e?.details?.find((d) => typeof d?.reason === 'string')?.reason, e?.errors?.[0]?.reason, e?.status, e?.code]
    return candidates.find((c): c is string => typeof c === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(c)) ?? null
  } catch {
    return null
  }
}

/** A Gmail change refused for want of permission: its message is the one to show. */
export class GmailPermissionError extends Error {
  readonly code = 'gmail_needs_permission'
  constructor() {
    super(GMAIL_NEEDS_PERMISSION)
    this.name = 'GmailPermissionError'
  }
}
