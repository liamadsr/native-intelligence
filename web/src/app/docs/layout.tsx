import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { History, Home, Map, Newspaper, Tag } from 'lucide-react';
import { source } from '@/lib/source';
import { Logo } from '@/components/logo';
import type { ReactNode } from 'react';

/**
 * The docs keep their own side panel, because it lists the docs' pages. What
 * it shares with the rest of the public site (components/site/site-shell.tsx):
 * the same logo, leading home, the site's other pages above the docs' tree,
 * and the same two buttons.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      <DocsLayout
        tree={source.pageTree}
        nav={{
          title: <Logo className="[&>span]:text-base" />,
          url: '/',
        }}
        links={[
          { text: 'Home', url: '/', icon: <Home /> },
          { text: 'Pricing', url: '/pricing', icon: <Tag /> },
          { text: 'Blog', url: '/blog', icon: <Newspaper /> },
          { text: 'Roadmap', url: '/roadmap', icon: <Map /> },
          { text: 'Release notes', url: '/release-notes', icon: <History /> },
        ]}
        sidebar={{
          defaultOpenLevel: 1,
          // The site's two buttons, as the shell draws them (the links list above only draws rows).
          footer: (
            <div className="flex gap-2 pb-1">
              <a
                href="/login?mode=signin"
                className="inline-flex h-9 flex-1 items-center justify-center rounded-full border border-border bg-background/40 px-3 text-sm font-medium whitespace-nowrap text-foreground transition-colors hover:bg-accent"
              >
                Sign in
              </a>
              <a
                href="/login?mode=signup"
                className="inline-flex h-9 flex-1 items-center justify-center rounded-full border border-transparent bg-primary px-3 text-sm font-medium whitespace-nowrap text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
              >
                Sign up free
              </a>
            </div>
          ),
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
