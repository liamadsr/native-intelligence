/**
 * What the email page says when a thread change (archive, delete) failed: the
 * server's own reason when it gives a short one (Gmail without permission to
 * change mail: ./gmail-permission.ts), else the page's line. Client-safe.
 */
export async function archiveFailure(res: Response | null, fallback: string): Promise<string> {
  if (!res) return fallback
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown }
    // Only a reason meant for the person (the permission one); a raw provider error stays the plain line.
    if (body?.code === 'gmail_needs_permission' && typeof body.error === 'string' && body.error.trim()) return body.error.trim().slice(0, 240)
  } catch {
    // No body: the plain line.
  }
  return fallback
}
