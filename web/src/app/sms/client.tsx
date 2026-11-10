'use client'

/**
 * The public page carriers review for Dial8's texting (10DLC): the opt-in
 * itself is inside the signed-in app (Settings → Phone), so this shows its
 * exact words and screenshots, what we send, and how to stop.
 */
import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { ContentSection, PageHeader, PageLayout, type Section } from '@/components/page-layout'
import { HELP_REPLY, SMS_CONSENT_TEXT } from '@/lib/sms/consent'

const sections: Section[] = [
  { id: 'program', label: 'The Program' },
  { id: 'opt-in', label: 'How You Opt In' },
  { id: 'alerts', label: 'Approval Alerts' },
  { id: 'what-we-send', label: 'What We Send' },
  { id: 'opt-out', label: 'Opting Out & Help' },
]

const LINK = 'text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300'

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote className="mt-4 rounded-lg border-l-4 border-gray-300 bg-gray-50 p-4 text-gray-950 dark:border-gray-700 dark:bg-gray-900 dark:text-white">
      {children}
    </blockquote>
  )
}

function Screenshot({ src, alt }: { src: string; alt: string }) {
  return (
    <img src={src} alt={alt} className="mt-6 w-full max-w-xl rounded-lg border border-gray-200 dark:border-gray-800" />
  )
}

/** The name on this page, header and footer included, until the 10DLC campaign names the new one. */
const HELD_BRAND = 'Dial8'

export default function SmsProgram() {
  return (
    <PageLayout sections={sections} brandName={HELD_BRAND}>
      <div>
        <Navbar brandName={HELD_BRAND} />
        <PageHeader title="Text Messaging (SMS)" meta="Last Updated: October 24, 2026" />

        <main className="pb-24">
          <ContentSection id="program" title="The Program" isFirst>
            <p>
              Dial8 (operated by Bridgebound Studio) is an AI workspace assistant for meetings, tasks and
              calendars. Dial8 account holders can text their own Dial8 AI assistant from their phone, and the
              assistant replies by text. Texts come from +1 928 769 8774. Every text goes only to a verified
              account holder who opted in as described below. We never send marketing texts.
            </p>
          </ContentSection>

          <ContentSection id="opt-in" title="How You Opt In">
            <p>
              Signed in to Dial8, an account holder opens Settings → Phone, types their mobile number, and must
              check this box (unchecked by default) before the &quot;Send code&quot; button works:
            </p>
            <Quote>{SMS_CONSENT_TEXT}</Quote>
            <p className="mt-4">
              We then text a one-time code, and the number is linked only once they enter it. We store the time
              and the version of the wording each person agreed to.
            </p>
            <Screenshot src="/legal/sms-opt-in.png" alt="Dial8 Settings → Phone: the mobile number field and the unchecked consent box" />
          </ContentSection>

          <ContentSection id="alerts" title="Texts While You're Away">
            <p>
              The consent above covers the texts the assistant starts while the account holder is away from the
              Dial8 app: when it needs them or has something for them, including requests for their OK with a
              short code they reply with (&quot;yes CODE&quot; or &quot;no CODE&quot;), and a morning summary.
              Nothing is texted between 9pm and 8am except something urgent. Message frequency varies. Reply STOP
              to stop all texts.
            </p>
          </ContentSection>

          <ContentSection id="what-we-send" title="What We Send">
            <ul className="space-y-2">
              <li>- The verification code: &quot;Dial8: Your code is 482913. Reply STOP to opt out.&quot;</li>
              <li>- A welcome message, and the assistant&apos;s replies to the texts you send.</li>
              <li>- Short notices when the assistant can&apos;t answer.</li>
              <li>
                - While you&apos;re away from the app: the assistant&apos;s messages when it needs you or has something
                for you (requests for your OK carry a reply code), and a morning summary. None between 9pm and 8am
                unless it&apos;s urgent.
              </li>
            </ul>
            <p className="mt-4">Message frequency varies. Message and data rates may apply.</p>
          </ContentSection>

          <ContentSection id="opt-out" title="Opting Out & Help">
            <p>
              Reply STOP at any time to stop all texts, START to resubscribe, or HELP for help. Our HELP reply
              is: &quot;{HELP_REPLY}&quot; You can also remove your number in Settings → Phone. Carriers are not
              liable for delayed or undelivered messages. We do not sell, rent, or share your mobile number or
              opt-in data with third parties for marketing. See our{' '}
              <a href="/terms#text-messages" className={LINK}>
                Terms
              </a>{' '}
              and{' '}
              <a href="/privacy#text-messages" className={LINK}>
                Privacy Policy
              </a>
              .
            </p>
          </ContentSection>
        </main>
      </div>
      <Footer brandName={HELD_BRAND} />
    </PageLayout>
  )
}
