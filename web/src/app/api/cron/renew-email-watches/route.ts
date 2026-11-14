import { NextResponse } from 'next/server'
import { renewGmailWatches } from '@/lib/email/gmail-watch'
import { renewOutlookSubscriptions } from '@/lib/email/outlook-webhook'
import { restartStalledEmailImports } from '@/lib/email/import-heal'
import { requireCronSecret } from '@/lib/api-auth'

/**
 * Daily mail-plumbing upkeep: renew push watches before they lapse, and
 * restart any initial import that never finished (src/lib/email/import-heal.ts).
 * There is no polling sync: pushes and the Sync button keep mail fresh.
 */
export async function GET(request: Request) {
  // Verify the request is from the scheduler
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    const [gmailRenewed, outlookRenewed, importsRestarted] = await Promise.allSettled([
      renewGmailWatches(),
      renewOutlookSubscriptions(),
      restartStalledEmailImports(),
    ])

    return NextResponse.json({
      gmail: gmailRenewed.status === 'fulfilled' ? gmailRenewed.value : 0,
      outlook: outlookRenewed.status === 'fulfilled' ? outlookRenewed.value : 0,
      imports_restarted: importsRestarted.status === 'fulfilled' ? importsRestarted.value : 0,
      errors: [
        gmailRenewed.status === 'rejected' ? `Gmail: ${gmailRenewed.reason}` : null,
        outlookRenewed.status === 'rejected' ? `Outlook: ${outlookRenewed.reason}` : null,
        importsRestarted.status === 'rejected' ? `Import restart: ${importsRestarted.reason}` : null,
      ].filter(Boolean),
    })
  } catch (err) {
    console.error('Email watch renewal cron error:', err)
    return NextResponse.json({ error: 'Watch renewal failed' }, { status: 500 })
  }
}
