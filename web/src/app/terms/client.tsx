'use client'

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { ContentSection, PageHeader, PageLayout, type Section } from '@/components/page-layout'

const sections: Section[] = [
  { id: 'agreement', label: 'Agreement to Terms' },
  { id: 'service', label: 'The Service' },
  { id: 'accounts', label: 'Accounts & Eligibility' },
  { id: 'billing', label: 'Billing & Cancellation' },
  { id: 'recording', label: 'Recording Consent' },
  { id: 'your-content', label: 'Your Content' },
  { id: 'ai-features', label: 'AI Features' },
  { id: 'text-messages', label: 'Text Messages (SMS)' },
  { id: 'acceptable-use', label: 'Acceptable Use' },
  { id: 'third-party', label: 'Third-Party Services' },
  { id: 'ip', label: 'Intellectual Property' },
  { id: 'testimonials', label: 'Feedback & Testimonials' },
  { id: 'disclaimers', label: 'Disclaimers' },
  { id: 'liability', label: 'Limitation of Liability' },
  { id: 'termination', label: 'Termination' },
  { id: 'disputes', label: 'Disputes & Governing Law' },
  { id: 'general', label: 'General Terms' },
  { id: 'contact', label: 'Contact Us' },
]

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="text-gray-400 dark:text-gray-600">-</span>
      <span>{children}</span>
    </li>
  )
}

export default function Terms() {
  return (
    <PageLayout sections={sections}>
      <div>
        <Navbar />
        <PageHeader title="Terms of Service" meta="Last Updated: October 24, 2026" />

        <main className="pb-24">
          <ContentSection id="agreement" title="Agreement to Terms" isFirst>
            <p>
              These Terms of Service (&quot;Terms&quot;) are a binding agreement between you and
              Bridgebound Studio (&quot;Native Intelligence,&quot; formerly &quot;Dial8,&quot; &quot;we,&quot; &quot;our,&quot; or
              &quot;us&quot;) governing your access to and use of the Native Intelligence website, web
              application, desktop application, and related services (collectively, the
              &quot;Service&quot;).
            </p>
            <p className="mt-4">
              By creating an account, clicking to accept these Terms, or using the Service, you
              agree to be bound by these Terms and our{' '}
              <a
                href="/privacy"
                className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
              >
                Privacy Policy
              </a>
              , which describes how we collect and use your data and is incorporated into these
              Terms by reference. If you do not agree, do not use the Service.
            </p>
            <p className="mt-4">
              If you are using the Service on behalf of a company or other organization, you
              represent that you have authority to bind that organization, and &quot;you&quot;
              refers to that organization.
            </p>
          </ContentSection>

          <ContentSection id="service" title="The Service">
            <p>
              Native Intelligence is a workspace that combines meeting capture and transcription, project and
              task management, email and calendar integration, and CRM features, assisted by
              artificial intelligence. Features vary by plan and platform, and we may add, change,
              or remove features over time. Where a change materially reduces the core
              functionality of a paid plan, we will provide reasonable advance notice.
            </p>
          </ContentSection>

          <ContentSection id="accounts" title="Accounts & Eligibility">
            <p>
              You must be at least 16 years old to use the Service. You are responsible for
              maintaining the confidentiality of your account credentials and for all activity
              under your account. You agree to provide accurate registration information and to
              notify us promptly at{' '}
              <a
                href="mailto:liam@dial8.ai"
                className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
              >
                liam@dial8.ai
              </a>{' '}
              of any unauthorized use of your account.
            </p>
          </ContentSection>

          <ContentSection id="billing" title="Subscriptions, Billing & Cancellation">
            <div className="space-y-6">
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Plans and payment</h3>
                <p className="mt-2">
                  Paid features of the Service are offered as subscriptions billed in advance on a
                  recurring basis (for example, monthly or annually). Prices, plan limits, and
                  included features are described on our{' '}
                  <a
                    href="/pricing"
                    className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                  >
                    pricing page
                  </a>{' '}
                  and are presented, including the renewal price and billing frequency, before you
                  subscribe. Payments are processed by our third-party payment processor (Stripe);
                  we do not store your full payment card details.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Free trials</h3>
                <p className="mt-2">
                  If your plan includes a free trial, we will tell you the trial length and the
                  price you will be charged when the trial ends before you start the trial. You can
                  cancel at any time during the trial to avoid being charged.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Automatic renewal</h3>
                <p className="mt-2">
                  Unless you cancel before the end of the current billing period, your subscription
                  automatically renews for successive periods of the same length at the
                  then-current price, and your payment method on file is charged at the start of
                  each renewal period. For annual (or longer) subscriptions, we will send a
                  reminder email to the address on your account before the renewal date, with
                  instructions for how to cancel.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Cancellation — as easy as signing up
                </h3>
                <p className="mt-2">
                  You can cancel your subscription at any time, online, in the same way you signed
                  up: go to Settings → Billing in the app (or visit{' '}
                  <a
                    href="https://dial8.ai/account/settings/billing"
                    className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                  >
                    dial8.ai/account/settings/billing
                  </a>
                  ) and choose Cancel. No phone call, email, or chat with support is required.
                  Cancellation takes effect at the end of the current billing period; you keep
                  access to paid features until then. Except where required by law, fees already
                  paid are non-refundable, but if you believe you were charged in error, contact us
                  and we will make it right.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Price changes</h3>
                <p className="mt-2">
                  If we change subscription prices, the new price applies from your next renewal,
                  and we will notify you by email at least 30 days before it takes effect so you
                  can cancel first if you choose.
                </p>
              </div>
            </div>
          </ContentSection>

          <ContentSection id="recording" title="Recording Consent & Compliance">
            <p>
              The Service can capture and transcribe meetings and conversations. Laws about
              recording conversations vary by jurisdiction, and many require the consent of all
              participants. You are solely responsible for complying with all applicable laws when
              recording, including obtaining any required consent from every participant before a
              recording begins. You represent that you will only record conversations where you
              have the legal right to do so. We are not responsible for your failure to obtain
              required consents.
            </p>
          </ContentSection>

          <ContentSection id="your-content" title="Your Content">
            <div className="space-y-6">
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">You own your content</h3>
                <p className="mt-2">
                  &quot;Your Content&quot; means everything you upload to or create in the Service
                  — recordings, transcripts, notes, documents, tasks, emails, contacts, and files.
                  You retain all ownership rights in Your Content. We claim no ownership over it.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">License to operate the Service</h3>
                <p className="mt-2">
                  You grant us a limited, worldwide, non-exclusive license to host, store, process,
                  transmit, and display Your Content solely as needed to provide, secure, and
                  improve the Service for you (including processing it with the AI features
                  described below), and for no other purpose. This license ends when Your Content
                  is deleted from the Service.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Deletion of your content</h3>
                <p className="mt-2">
                  You can delete Your Content (including uploaded recordings and files) within the
                  app at any time, and you can request deletion of your account and all associated
                  content by contacting us. When you delete content or your account, we delete
                  Your Content from our production systems within 30 days, and from backups within
                  90 days, except where we are legally required to retain it. Deleted content is
                  not kept for any other purpose.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Your responsibilities</h3>
                <p className="mt-2">
                  You are responsible for Your Content, including having the rights necessary to
                  upload it and ensuring it does not violate the law or these Terms.
                </p>
              </div>
            </div>
          </ContentSection>

          <ContentSection id="ai-features" title="AI Features">
            <div className="space-y-6">
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">How AI is used</h3>
                <p className="mt-2">
                  The Service uses artificial intelligence — including third-party AI providers
                  such as Anthropic (language models) and Deepgram (speech-to-text) — to transcribe
                  recordings, summarize meetings, extract action items, draft emails, and power the
                  assistant. Your Content is sent to these providers only as needed to deliver
                  these features, under agreements that restrict how they may use it. With local
                  transcription turned on and ready in the Native Intelligence desktop app, recordings are
                  transcribed on your device instead (falling back to Deepgram, with a notice, if
                  on-device transcription is unavailable or stops). We do not use
                  Your Content to train generalized AI models, and our providers are contractually
                  prohibited from doing so with data we send them. See our{' '}
                  <a
                    href="/privacy"
                    className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                  >
                    Privacy Policy
                  </a>{' '}
                  for details.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  AI output may be wrong
                </h3>
                <p className="mt-2">
                  AI-generated output — transcripts, summaries, extracted tasks, drafts, and
                  assistant responses — is generated automatically and may be inaccurate,
                  incomplete, or misleading. You are responsible for reviewing AI output before
                  relying on it or sending it to others. AI output is not professional advice of
                  any kind, including legal, medical, financial, or mental-health advice.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Not for emergencies or crisis support
                </h3>
                <p className="mt-2">
                  The Service and its AI assistant are productivity tools. They are not designed to
                  provide crisis intervention, counseling, or emergency services, and must not be
                  relied on for them. If you or someone else may be in danger or experiencing
                  thoughts of self-harm or suicide, stop using the Service and contact emergency
                  services or a crisis line immediately — in the US, call or text 988 (Suicide
                  &amp; Crisis Lifeline); elsewhere, you can find local helplines at{' '}
                  <a
                    href="https://findahelpline.com"
                    className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                  >
                    findahelpline.com
                  </a>
                  .
                </p>
              </div>
            </div>
          </ContentSection>

          <ContentSection id="text-messages" title="Text Messages (SMS)">
            <p>
              Account holders who opt in at Settings → Phone can text Dial8&apos;s AI assistant and
              receive its replies by text, along with a verification code, a welcome message and
              short notices when it can&apos;t answer. While they&apos;re away from the Dial8 app, the
              assistant also texts them when it needs them or has something for them, including
              requests for their approval with a code to reply with, and a morning summary (nothing
              between 9pm and 8am unless it&apos;s urgent). Message frequency varies. Message and data
              rates may apply. Reply STOP at any time to cancel, START
              to resubscribe, or HELP for help, or email{' '}
              <a
                href="mailto:liam@dial8.ai"
                className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
              >
                liam@dial8.ai
              </a>
              . Carriers are not liable for delayed or undelivered messages. How we handle your
              number and texts is described in our{' '}
              <a
                href="/privacy#text-messages"
                className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
              >
                Privacy Policy
              </a>
              .
            </p>
          </ContentSection>

          <ContentSection id="acceptable-use" title="Acceptable Use">
            <p>You agree not to, and not to permit others to:</p>
            <ul className="mt-4 space-y-2">
              <Bullet>
                Use the Service to violate any law, including recording, privacy, wiretap,
                anti-spam (e.g., CAN-SPAM), or data-protection laws
              </Bullet>
              <Bullet>
                Record any person without consent where consent is required by law
              </Bullet>
              <Bullet>
                Upload content that is unlawful, infringing, or that you lack rights to use
              </Bullet>
              <Bullet>
                Send unsolicited bulk email or deceptive messages through connected email accounts
              </Bullet>
              <Bullet>
                Probe, scan, or breach the Service&apos;s security, or access another user&apos;s
                account or data without authorization
              </Bullet>
              <Bullet>
                Reverse engineer, scrape, resell, or sublicense the Service, or use it to build a
                competing product
              </Bullet>
              <Bullet>
                Use the AI features to generate content that is harmful, deceptive, or abusive, or
                attempt to circumvent their safety measures
              </Bullet>
              <Bullet>
                Interfere with or disrupt the integrity or performance of the Service
              </Bullet>
            </ul>
            <p className="mt-6">
              We may suspend or terminate accounts that violate this section, with notice where
              practicable.
            </p>
          </ContentSection>

          <ContentSection id="third-party" title="Third-Party Services">
            <p>
              The Service integrates with third-party services and is built on third-party
              infrastructure — for example Google and Microsoft (email and calendar sync via OAuth),
              Stripe (payments), Supabase (database and storage), Vercel (hosting), Deepgram
              (transcription), and Anthropic (AI). Your use of a third-party service through Native Intelligence
              is also subject to that service&apos;s own terms and privacy policy. The third
              parties that process your data on our behalf, and what they receive, are listed in
              our{' '}
              <a
                href="/privacy"
                className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
              >
                Privacy Policy
              </a>
              . We are not responsible for third-party services we do not control, and an outage or
              policy change by a provider may affect features that depend on it.
            </p>
          </ContentSection>

          <ContentSection id="ip" title="Intellectual Property">
            <p>
              The Service — including its software, design, and branding, but excluding Your
              Content — is owned by Bridgebound Studio and its licensors and is protected by
              intellectual-property laws. We grant you a limited, non-exclusive, non-transferable
              license to use the Service in accordance with these Terms. Open-source components we
              publish are licensed under their respective open-source licenses.
            </p>
          </ContentSection>

          <ContentSection id="testimonials" title="Feedback & Testimonials">
            <p>
              If you send us feedback or suggestions, you grant us the right to use them without
              restriction or compensation. We only publish genuine reviews and testimonials from
              real users, we do not fabricate or purchase testimonials, and we will only attribute
              a testimonial to you by name with your consent. If we ever offer an incentive for a
              review, we require the connection to be disclosed and never condition it on the
              review being positive.
            </p>
          </ContentSection>

          <ContentSection id="disclaimers" title="Disclaimers">
            <p>
              THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE.&quot; TO THE
              MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED,
              INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND
              ANY WARRANTY THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT AI OUTPUT
              WILL BE ACCURATE OR RELIABLE. Some jurisdictions do not allow the exclusion of
              implied warranties, so some of the above may not apply to you.
            </p>
          </ContentSection>

          <ContentSection id="liability" title="Limitation of Liability">
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW: (a) NEITHER PARTY WILL BE LIABLE FOR ANY
              INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST
              PROFITS, REVENUE, OR DATA, EVEN IF ADVISED OF THE POSSIBILITY; AND (b) OUR TOTAL
              LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF
              THE AMOUNTS YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM AROSE OR US $100. THESE
              LIMITS DO NOT APPLY TO LIABILITY THAT CANNOT BE LIMITED BY LAW, YOUR PAYMENT
              OBLIGATIONS, OR EITHER PARTY&apos;S WILLFUL MISCONDUCT.
            </p>
            <p className="mt-4">
              You agree to indemnify us against third-party claims arising from Your Content, your
              violation of these Terms, or your violation of law — including recording without
              required consent.
            </p>
          </ContentSection>

          <ContentSection id="termination" title="Termination">
            <p>
              You may stop using the Service and delete your account at any time. We may suspend
              or terminate your access if you materially breach these Terms, if required by law,
              or if we discontinue the Service (in which case we will give you reasonable notice
              and, for prepaid periods, a pro-rata refund). Upon termination, you may export Your
              Content for 30 days, after which we delete it as described in the &quot;Your
              Content&quot; section. Sections that by their nature should survive termination
              (including ownership, disclaimers, limitation of liability, and dispute terms) do
              survive.
            </p>
          </ContentSection>

          <ContentSection id="disputes" title="Disputes & Governing Law">
            <p>
              These Terms are governed by the laws of the State of California, USA, without regard
              to conflict-of-laws rules. Before filing a claim, you agree to contact us at{' '}
              <a
                href="mailto:liam@dial8.ai"
                className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
              >
                liam@dial8.ai
              </a>{' '}
              and give us 30 days to work with you to resolve the dispute informally. Any dispute
              not resolved informally will be resolved by binding arbitration on an individual
              basis under the rules of the American Arbitration Association, except that either
              party may bring qualifying claims in small-claims court or seek injunctive relief
              for intellectual-property misuse in court.
            </p>
            <p className="mt-4 font-semibold text-gray-950 dark:text-white">
              You and Native Intelligence each waive the right to a jury trial and to participate in a class
              action.
            </p>
            <p className="mt-4">
              You may opt out of arbitration by emailing liam@dial8.ai within 30 days of first
              accepting these Terms. Nothing in this section limits rights you have under the
              consumer-protection laws of your place of residence that cannot be waived by
              contract.
            </p>
          </ContentSection>

          <ContentSection id="general" title="General Terms">
            <ul className="space-y-4">
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Changes to these Terms:</strong>{' '}
                We may update these Terms from time to time. For material changes we will notify
                you (for example by email or in-app notice) at least 30 days before they take
                effect. If you continue using the Service after the effective date, the updated
                Terms apply; if you do not agree, cancel before then.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Entire agreement:</strong> These
                Terms and the Privacy Policy are the entire agreement between you and us regarding
                the Service.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Severability & waiver:</strong>{' '}
                If any provision is found unenforceable, the rest remains in effect. Failure to
                enforce a provision is not a waiver of it.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Assignment:</strong> You may not
                assign these Terms without our consent; we may assign them in connection with a
                merger, acquisition, or sale of assets.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Force majeure:</strong> Neither
                party is liable for delays or failures caused by events beyond its reasonable
                control.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Export & sanctions:</strong> You
                may not use the Service in violation of applicable export-control or sanctions
                laws.
              </Bullet>
            </ul>
          </ContentSection>

          <ContentSection id="contact" title="Contact Us">
            <p>Questions about these Terms? Contact us at:</p>
            <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-6 dark:border-gray-800 dark:bg-gray-900/50">
              <p className="font-semibold text-gray-950 dark:text-white">
                Bridgebound Studio (Native Intelligence)
              </p>
              <p className="mt-2">
                Email:{' '}
                <a
                  href="mailto:liam@dial8.ai"
                  className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                >
                  liam@dial8.ai
                </a>
              </p>
              <p className="mt-1">
                Website:{' '}
                <a
                  href="https://dial8.ai"
                  className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                >
                  https://dial8.ai
                </a>
              </p>
            </div>
          </ContentSection>
        </main>
      </div>
      <Footer />
    </PageLayout>
  )
}
