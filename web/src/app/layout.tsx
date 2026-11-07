import '@/styles/tailwind.css'
import type { Metadata } from 'next'
import { PostHogProvider } from './providers'
import { DeepLinkHandler } from '@/components/desktop/deep-link-handler'
import { CloseStaleBotsOverlay } from '@/components/desktop/close-stale-bots-overlay'
import { DesktopNativeFeel } from '@/components/desktop/desktop-native-feel'
import { ThemeScript } from '@/components/theme-script'
import { SystemThemeListener } from '@/components/system-theme-listener'
import { CacheBusterScript } from '@/components/desktop/cache-buster-script'
import { Inter, Noto_Serif } from 'next/font/google'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const notoSerif = Noto_Serif({ subsets: ['latin'], variable: '--font-heading' })

// Site-wide defaults. The homepage overrides both with its own sales metadata
// (src/app/page.tsx); these are what every page WITHOUT its own title falls
// back to, plus the og:/twitter: cards for those pages.
const SITE_TITLE = 'Dial8 — the end-to-end AI sales platform'
const SITE_DESCRIPTION =
  'Dial8 gives every rep your whole team’s knowledge live on the call — no bot joins the meeting — then updates the CRM, queues follow-ups, and feeds what the call taught back to the team.'

export const metadata: Metadata = {
  metadataBase: new URL('https://dial8.ai'),
  title: {
    template: '%s - Dial8',
    default: SITE_TITLE,
  },
  description: SITE_DESCRIPTION,
  applicationName: 'Dial8',
  authors: [{ name: 'Dial8' }],
  creator: 'Dial8',
  publisher: 'Dial8',
  alternates: {
    canonical: '/',
  },
  icons: {
    icon: [{ url: '/icon.png', type: 'image/png' }],
    apple: '/icon.png',
  },
  // OpenGraph/Twitter social-card images are provided by the
  // opengraph-image.tsx / twitter-image.tsx file conventions in this dir.
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: 'website',
    siteName: 'Dial8',
    url: 'https://dial8.ai',
  },
  twitter: {
    card: 'summary_large_image',
    site: '@Dial8_ai',
    creator: '@Dial8_ai',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`h-full ${inter.variable} ${notoSerif.variable}`} suppressHydrationWarning>
      <head>
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Dial8 Blog"
          href="/blog/feed.xml"
        />
        <ThemeScript />
        <CacheBusterScript />
      </head>
      <body className="flex min-h-screen flex-col bg-background text-foreground antialiased" suppressHydrationWarning>
        {/* PostHogProvider must stay <body>'s ONLY child: a client component
            beside siblings in a server layout is a forked child to React's
            useId, and if its chunk lands a moment after hydration reaches it,
            React's replay drops that fork from every useId in the app (see
            account/(dashboard)/layout.tsx). The listeners — all render null —
            ride inside it instead. */}
        <PostHogProvider>
          <SystemThemeListener />
          <DesktopNativeFeel />
          <DeepLinkHandler />
          <CloseStaleBotsOverlay />
          {children}
        </PostHogProvider>
      </body>
    </html>
  )
}
