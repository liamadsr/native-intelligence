import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { source } from '@/lib/source';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      <DocsLayout
        tree={source.pageTree}
        nav={{
          title: (
            <div className="flex items-center gap-2.5">
              {/* Always the dark app icon — the light/marble variant is retired. */}
              <img
                src="/screenshots/Icon-macOS-Dark-1024x1024@2x-dark.png"
                alt="Dial8"
                className="size-7"
              />
              <span className="font-semibold">Dial8 Docs</span>
            </div>
          ),
          url: '/docs',
        }}
        sidebar={{
          defaultOpenLevel: 1,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
