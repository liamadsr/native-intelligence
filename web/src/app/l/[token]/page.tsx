import { getServiceClient } from '@/lib/supabase/service'
import { peekOneTimeLink } from '@/lib/links/one-time'
import { LINK_PURPOSES } from '@/lib/links/purposes'
import { linkedPhoneForUser } from '@/lib/sms/store'
import { maskPhone } from '@/lib/twilio/phone'
import { LinkCard, LinkConfirm } from '../link-card'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Dial8',
  // One person's single-use link: out of the search index, and its URL never sent to another site
  // as a referrer ('same-origin' still lets the button's POST carry a real Origin).
  robots: { index: false, follow: false },
  referrer: 'same-origin' as const,
}

/**
 * A single-use link Dial8 texted (src/lib/links/one-time.ts). Looking only
 * peeks, so a link preview can't use it up. The page says what the link does
 * and which (masked) number it was sent to, and its button POSTs to
 * /api/links/<token>, which uses it. A link whose account has no verified
 * number (links only ever go to one) works no more. A link that's used,
 * expired or unknown says so, without saying which.
 */
export default async function OneTimeLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = getServiceClient()
  const peeked = await peekOneTimeLink(supabase, token)
  if (!peeked.ok) {
    return peeked.reason === 'lookup_failed' ? (
      <LinkCard title="Something went wrong" description="We couldn't open this link just now. Try it again in a moment." />
    ) : (
      <LinkCard title="This link no longer works" description="It was already used or it expired. Text Dial8 for a new one." />
    )
  }
  const view = LINK_PURPOSES[peeked.link.purpose].view(peeked.link)
  if (!view) return <LinkCard title="This link no longer works" description="Text Dial8 for a new one." />
  let phone: Awaited<ReturnType<typeof linkedPhoneForUser>>
  try {
    phone = await linkedPhoneForUser(supabase, peeked.link.userId)
  } catch {
    return <LinkCard title="Something went wrong" description="We couldn't open this link just now. Try it again in a moment." />
  }
  if (!phone) return <LinkCard title="This link no longer works" description="Text Dial8 for a new one." />
  return <LinkConfirm view={view} maskedPhone={maskPhone(phone.phone)} action={`/api/links/${encodeURIComponent(token)}`} />
}
