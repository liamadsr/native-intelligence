'use client'

import { PageLayout, type Section } from '@/components/page-layout';
import { Footer } from '@/components/footer';

export function BlogPostWrapper({
  sections,
  children,
}: {
  sections: Section[];
  children: React.ReactNode;
}) {
  return (
    <PageLayout sections={sections}>
      <div className="min-h-screen pt-6 lg:pt-10">
        {children}
      </div>
      <Footer />
    </PageLayout>
  );
}
