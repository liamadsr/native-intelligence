import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { ArrowRight, History, Home, Map, Newspaper, Tag } from 'lucide-react';
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
          { type: 'button', text: 'Sign in', url: '/login?mode=signin', secondary: true },
          { type: 'button', text: 'Sign up free', url: '/login?mode=signup', icon: <ArrowRight /> },
        ]}
        sidebar={{
          defaultOpenLevel: 1,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
