import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

export default function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      {children}
    </RootProvider>
  );
}
