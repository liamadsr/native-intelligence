import Link from 'next/link';
import { blog } from '@/lib/source';
import { PageLayout } from '@/components/page-layout';
import { Navbar } from '@/components/navbar';
import { Footer } from '@/components/footer';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Latest news, product updates, and writing from the Dial8 team.',
  alternates: { canonical: '/blog' },
  openGraph: {
    title: 'Dial8 Blog',
    description: 'Latest news, product updates, and writing from the Dial8 team.',
    url: 'https://dial8.ai/blog',
    type: 'website',
  },
};

export default function BlogIndex() {
  const posts = blog
    .getPages()
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime());

  const sections = posts.map((post) => ({
    id: post.slugs[0],
    label: post.data.title,
  }));

  return (
    <PageLayout sections={sections}>
      <Navbar />
      <div className="min-h-screen pt-28">
        <main className="mx-auto w-full max-w-4xl px-6 py-12">
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            Blog
          </h1>
          <p className="mt-2 text-lg text-muted-foreground">
            Latest news and updates from Dial8.
          </p>

          <div className="mt-10 grid gap-6">
            {posts.map((post) => (
              <Link
                id={post.slugs[0]}
                key={post.url}
                href={post.url}
                className="group block scroll-mt-32 rounded-xl border border-border p-6 transition-colors hover:border-muted-foreground/25 hover:bg-accent"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="text-xl font-semibold text-foreground group-hover:text-foreground/80">
                      {post.data.title}
                    </h2>
                    <p className="mt-1 text-muted-foreground">
                      {post.data.description}
                    </p>
                  </div>
                  <div className="shrink-0 text-sm text-muted-foreground">
                    <span>{post.data.author}</span>
                    <span className="mx-2">&middot;</span>
                    <time dateTime={String(post.data.date)}>
                      {new Date(post.data.date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </time>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {posts.length === 0 && (
            <p className="mt-10 text-center text-muted-foreground">
              No blog posts yet. Check back soon!
            </p>
          )}
        </main>
      </div>
      <Footer />
    </PageLayout>
  );
}
