'use client'

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { ContentSection, PageHeader, PageLayout, type Section } from '@/components/page-layout'

const sections: Section[] = [
  { id: 'introduction', label: 'Introduction' },
  { id: 'information-collected', label: 'Information Collected' },
  { id: 'how-we-use', label: 'How We Use Info' },
  { id: 'ai-processing', label: 'AI Processing' },
  { id: 'text-messages', label: 'Text Messages (SMS)' },
  { id: 'third-parties', label: 'Third-Party Processors' },
  { id: 'sharing', label: 'Sharing & Disclosure' },
  { id: 'retention-deletion', label: 'Retention & Deletion' },
  { id: 'security', label: 'Data Security' },
  { id: 'your-rights', label: 'Your Rights' },
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

export default function Privacy() {
  return (
    <PageLayout sections={sections}>
      <div>
        <Navbar />
        <PageHeader
          title="Privacy Policy"
          meta="Last Updated: October 24, 2026"
        />

        <main className="pb-24">
          <ContentSection id="introduction" title="Introduction" isFirst>
            <p>
              Dial8, operated by Bridgebound Studio (&quot;we,&quot; &quot;our,&quot; or
              &quot;us&quot;), is committed to protecting your privacy. This Privacy Policy
              explains what information we collect when you use our website and applications, how
              we use it, who we share it with, and the choices you have.
            </p>
            <p className="mt-4 font-semibold text-gray-950 dark:text-white">
              In short: we collect the data you give us and the data needed to run the product, we
              use AI providers to process your content under strict contracts, we never sell your
              data, and you can delete it at any time.
            </p>
          </ContentSection>

          <ContentSection id="information-collected" title="Information We Collect">
            <p className="font-semibold text-gray-950 dark:text-white">
              We collect user data. Specifically:
            </p>
            <div className="mt-6 space-y-6">
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Account information</h3>
                <p className="mt-2">
                  When you create an account we collect your name, email address, and workspace
                  details. If you sign in with Google or Microsoft, we receive basic profile
                  information from that provider.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Meeting recordings and transcripts
                </h3>
                <p className="mt-2">
                  When you use meeting capture, the audio you record is streamed for transcription
                  and processed in real time —{' '}
                  <strong className="text-gray-950 dark:text-white">
                    audio is never stored on our servers
                  </strong>
                  . The recording stays on your device. What we store are the transcripts and the
                  notes, summaries, action items, and other content derived from them. Recordings
                  are only made when you start them.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Content you create and upload
                </h3>
                <p className="mt-2">
                  Notes, documents, tasks, projects, CRM contacts, and files you upload to the
                  Service.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Connected account data
                </h3>
                <p className="mt-2">
                  If you connect your email or calendar (Google or Microsoft) or other integrations,
                  we sync the data needed to provide those features — such as email messages,
                  calendar events, and contacts — with your permission, via OAuth. You can
                  disconnect an integration at any time in Settings.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Payment information</h3>
                <p className="mt-2">
                  Payments are processed by Stripe. We receive your subscription status and billing
                  history; we do not store your full payment card number.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">Usage and device data</h3>
                <p className="mt-2">
                  We collect log data and product analytics (via PostHog) about how you use the
                  apps — such as pages visited, features used, device and browser type — to improve
                  the product and diagnose problems.
                </p>
              </div>
            </div>
          </ContentSection>

          <ContentSection id="how-we-use" title="How We Use Your Information">
            <p>We use the information we collect to:</p>
            <ul className="mt-4 list-inside space-y-2 pl-4">
              <Bullet>Provide the Service: transcribe recordings, generate summaries and action items, sync email and calendar, and power search and the AI assistant</Bullet>
              <Bullet>Create and manage your account and workspaces</Bullet>
              <Bullet>Process subscriptions and billing</Bullet>
              <Bullet>Provide customer support and respond to your inquiries</Bullet>
              <Bullet>
                Send service communications — account notifications, receipts, renewal reminders,
                security alerts, and product updates
              </Bullet>
              <Bullet>Improve and optimize the applications</Bullet>
              <Bullet>Protect against fraudulent, unauthorized, or illegal activity</Bullet>
              <Bullet>Comply with legal obligations</Bullet>
            </ul>
          </ContentSection>

          <ContentSection id="ai-processing" title="How We Use AI">
            <p>
              Dial8 uses artificial intelligence to deliver core features. This means some of your
              content is processed by AI systems:
            </p>
            <ul className="mt-4 space-y-4">
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Transcription:</strong> meeting
                audio is transcribed to text by Deepgram in real time; we do not retain the audio
                after transcription. When local transcription is turned on and ready in the Dial8
                desktop app, meeting audio is instead transcribed on your device and is not sent to
                a transcription provider — unless on-device transcription is unavailable or stops
                during a recording, in which case Dial8 switches to Deepgram and tells you.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Language models:</strong>{' '}
                transcripts, notes, emails, and related content are processed by large language
                models (primarily Anthropic&apos;s Claude) to generate summaries, extract action
                items and decisions, draft replies, and answer your questions in the assistant.
              </Bullet>
            </ul>
            <p className="mt-6">
              Your content is sent to these providers only as needed to deliver the feature you are
              using.{' '}
              <strong className="text-gray-950 dark:text-white">
                We do not use your content to train generalized AI models, and our AI providers are
                contractually prohibited from using data we send them to train their models.
              </strong>{' '}
              AI output can be inaccurate — review it before relying on it.
            </p>
          </ContentSection>

          <ContentSection id="text-messages" title="Text Messages (SMS)">
            <p>
              You can choose to text your Dial8 AI agent from your phone. To turn this on, you add
              your mobile number in Settings → Phone, check the box agreeing to receive texts from
              Dial8, and confirm the number with a one-time code we text you. Texting is optional.
              Dial8 texts only numbers that opted in this way, apart from answers to HELP and START
              and a single reply when a number that isn&apos;t linked to a Dial8 account texts us
              first.
            </p>
            <div className="mt-6 space-y-6">
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">What we send</h3>
                <p className="mt-2">
                  The verification code, a welcome message, the agent&apos;s replies to the texts
                  you send, short notices when the agent can&apos;t answer (for example when a
                  request fails or a usage limit is reached), and answers to HELP and START. While
                  you&apos;re away from the Dial8 app, the agent also texts you when it needs you or
                  has something for you, including requests for your approval with a short code you
                  reply with to approve or decline, and a morning summary. Nothing is texted between
                  9pm and 8am unless it&apos;s urgent. The texts are written by an AI assistant, not a
                  person. Message frequency varies. Message and data rates may apply.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">What we collect</h3>
                <p className="mt-2">
                  Your mobile number, when you verified it, and when and to which wording you agreed
                  to receive texts. The texts you send and the agent&apos;s replies are saved in your
                  Dial8 chat, like any other conversation with the agent, and are processed by our
                  AI providers as described in{' '}
                  <a
                    href="#ai-processing"
                    className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                  >
                    How We Use AI
                  </a>
                  . We also keep a delivery record of each text in or out (the number, the time,
                  the kind of message and Twilio&apos;s message ID, not its words), which we use
                  for rate limits, to prevent abuse, and to honor opt-outs. This delivery record
                  stays after you remove your number or delete your account, so that we keep
                  honoring an opt-out.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Opting out
                </h3>
                <p className="mt-2">
                  Reply STOP at any time and we stop texting that number. Reply START to turn texts
                  back on, or HELP for help, or email{' '}
                  <a
                    href="mailto:liam@dial8.ai"
                    className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                  >
                    liam@dial8.ai
                  </a>
                  . You can also remove your number in Settings → Phone.
                  We keep a record of an opt-out so that we do not text that number again.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  No sharing for marketing
                </h3>
                <p className="mt-2">
                  We do not sell, rent, or share your mobile number with third parties or
                  affiliates for their marketing or promotional purposes. Text messaging opt-in
                  data and consent are never shared with any third party, except with the providers
                  that deliver our texts (Twilio and the mobile carriers) as needed to send them.
                </p>
              </div>
            </div>
          </ContentSection>

          <ContentSection id="third-parties" title="Third-Party Data Processors">
            <p>
              We use a small set of third-party service providers (subprocessors) to run Dial8.
              Each receives only the data needed for its function:
            </p>
            <ul className="mt-4 space-y-4">
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Supabase</strong> — database,
                authentication, and file storage (stores your account data and content in private,
                access-controlled storage)
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Vercel</strong> — application
                hosting and delivery
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Deepgram</strong> — speech-to-text
                transcription of meeting audio
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Anthropic</strong> — AI language
                model processing (summaries, extraction, assistant)
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Stripe</strong> — payment
                processing and billing
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Google / Microsoft</strong> —
                sign-in and email/calendar sync, when you connect them
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Twilio</strong> — text message
                (SMS) delivery, when you link a phone number
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">PostHog</strong> — product
                analytics
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Inngest</strong> — background job
                processing (e.g., email sync workflows)
              </Bullet>
            </ul>
            <p className="mt-6">
              Each provider is bound by agreements limiting its use of your data to providing
              services to us. We will update this list as our providers change.
            </p>
            <div className="mt-8">
              <h3 className="font-semibold text-gray-950 dark:text-white">
                Google API Services disclosure
              </h3>
              <p className="mt-2">
                Dial8&apos;s use and transfer of information received from Google APIs adheres to
                the{' '}
                <a
                  href="https://developers.google.com/terms/api-services-user-data-policy"
                  className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                >
                  Google API Services User Data Policy
                </a>
                , including the Limited Use requirements. Google user data is used only to provide
                the email and calendar features you enable, is never sold or used for advertising,
                and is not used to train generalized AI models.
              </p>
            </div>
          </ContentSection>

          <ContentSection id="sharing" title="Information Sharing and Disclosure">
            <p className="font-semibold text-gray-950 dark:text-white">
              We do not sell, trade, or rent your personal information to third parties.
            </p>
            <p className="mt-4">
              Beyond the service providers listed above, we may share your information only in the
              following limited circumstances:
            </p>
            <ul className="mt-4 space-y-4">
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Your workspace:</strong> content
                you place in a shared workspace is visible to the teammates you share it with,
                according to the visibility settings you choose.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Legal requirements:</strong> if
                required by law or in response to valid requests by public authorities.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Business transfers:</strong> if
                we are involved in a merger, acquisition, or sale of assets, in which case this
                policy continues to apply to your data.
              </Bullet>
              <Bullet>
                <strong className="text-gray-950 dark:text-white">Protection of rights:</strong> to
                protect and defend the rights, property, or safety of Dial8, our users, or others.
              </Bullet>
            </ul>
            <p className="mt-4">
              None of these categories includes text messaging originator opt-in data and consent:
              we do not share it with any third party (see{' '}
              <a
                href="#text-messages"
                className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
              >
                Text Messages (SMS)
              </a>
              ).
            </p>
          </ContentSection>

          <ContentSection id="retention-deletion" title="Data Retention & Deletion">
            <p>
              We retain your information for as long as your account is active or as needed to
              provide the Service, comply with legal obligations, resolve disputes, and enforce our
              agreements.
            </p>
            <div className="mt-6 space-y-4">
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Deleting your uploads and content
                </h3>
                <p className="mt-2">
                  You can delete transcripts, files, and other content within the app at any time.
                  Deleted content is removed from our production systems within 30 days and from
                  encrypted backups within 90 days. We do not keep copies of deleted uploads for
                  any other purpose.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Deleting your account
                </h3>
                <p className="mt-2">
                  You can request deletion of your account and all associated data at any time by
                  contacting{' '}
                  <a
                    href="mailto:liam@dial8.ai"
                    className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                  >
                    liam@dial8.ai
                  </a>
                  . We honor deletion requests within 30 days, subject to narrow legal retention
                  requirements (such as billing records).
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Disconnecting integrations
                </h3>
                <p className="mt-2">
                  When you disconnect a connected account (such as Gmail or Outlook), we stop
                  syncing and delete the associated OAuth tokens. You can additionally revoke
                  Dial8&apos;s access from your Google or Microsoft account settings.
                </p>
              </div>
            </div>
          </ContentSection>

          <ContentSection id="security" title="Data Security">
            <p>
              We implement technical and organizational measures to protect your information,
              including encryption in transit (TLS) and at rest, private access-controlled storage
              for uploaded files (no publicly accessible storage buckets — and meeting audio is
              never stored on our servers at all),
              row-level access controls in our database, and least-privilege access for our
              systems. No method of transmission or storage is 100% secure, and we cannot
              guarantee absolute security, but we work continuously to protect your data and will
              notify you as required by law in the event of a breach affecting your information.
            </p>
            <div className="mt-8 space-y-4">
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">
                  Children&apos;s Privacy
                </h3>
                <p className="mt-2">
                  Our services are not directed to individuals under the age of 13, and we do not
                  knowingly collect personal information from children under 13. If we become aware
                  that we have, we will delete it.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-gray-950 dark:text-white">International Users</h3>
                <p className="mt-2">
                  Your information may be transferred to, stored, and processed in the United
                  States and other countries where our service providers operate, which may have
                  different data protection laws than your country of residence. Where required, we
                  rely on appropriate safeguards for such transfers.
                </p>
              </div>
            </div>
          </ContentSection>

          <ContentSection id="your-rights" title="Your Rights">
            <p>Depending on where you live, you have the right to:</p>
            <ul className="mt-4 space-y-2">
              <Bullet>Access the personal information we hold about you</Bullet>
              <Bullet>Request correction of inaccurate information</Bullet>
              <Bullet>
                Request deletion of your personal information, subject to certain exceptions
              </Bullet>
              <Bullet>Receive a copy of your data in a portable format</Bullet>
              <Bullet>Object to or restrict certain processing of your data</Bullet>
              <Bullet>
                Withdraw consent where we rely on consent to process your information
              </Bullet>
              <Bullet>
                Not be discriminated against for exercising any of these rights
              </Bullet>
            </ul>
            <p className="mt-6">
              To exercise these rights, contact us using the information below. We will respond
              within the timeframes required by applicable law (for example, GDPR or the
              California Consumer Privacy Act). We do not sell or share personal information for
              cross-context behavioral advertising.
            </p>
            <div className="mt-8">
              <h3 className="font-semibold text-gray-950 dark:text-white">
                Changes to This Privacy Policy
              </h3>
              <p className="mt-2">
                We may update this Privacy Policy from time to time. We will notify you of material
                changes by posting the new policy on this page, updating the &quot;Last
                Updated&quot; date, and — for significant changes — notifying you by email or
                in-app notice. Your continued use of our services after any modifications indicates
                your acceptance of the updated policy.
              </p>
            </div>
          </ContentSection>

          <ContentSection id="contact" title="Contact Us">
            <p>
              If you have any questions, concerns, or requests regarding this Privacy Policy or our
              data practices, please contact us at:
            </p>
            <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-6 dark:border-gray-800 dark:bg-gray-900/50">
              <p className="font-semibold text-gray-950 dark:text-white">
                Bridgebound Studio (Dial8)
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
            <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-6 dark:border-gray-800 dark:bg-gray-900/50">
              <p className="text-sm leading-6">
                By using Dial8, you acknowledge that you have read, understood, and agree to be
                bound by this Privacy Policy and our{' '}
                <a
                  href="/terms"
                  className="text-cyan-600 hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
                >
                  Terms of Service
                </a>
                . If you do not agree, please do not use our services.
              </p>
            </div>
          </ContentSection>
        </main>
      </div>
      <Footer />
    </PageLayout>
  )
}
