'use client'

import { PageLayout, type Section } from '@/components/page-layout';
import { Navbar } from '@/components/navbar';
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
      <Navbar />
      <div className="min-h-screen pt-28">
        {children}
      </div>
      <Footer />
    </PageLayout>
  );
}
