import { notFound } from 'next/navigation';
import Link from 'next/link';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { blog } from '@/lib/source';
import { BlogPostWrapper } from './wrapper';
import { StructuredData, blogPostingSchema } from '@/components/structured-data';

export default async function BlogPostPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  const page = blog.getPage([params.slug]);

  if (!page) notFound();
  const Mdx = page.data.body;

  const postUrl = `https://dial8.ai/blog/${params.slug}`;
  const jsonLd = blogPostingSchema({
    title: page.data.title,
    description: page.data.description,
    date: page.data.date,
    author: page.data.author,
    url: postUrl,
  });

  // Extract h2 headings from TOC for the sidebar sections
  const sections = page.data.toc
    .filter((item) => item.depth === 2)
    .map((item) => ({
      id: item.url.replace('#', ''),
      label: typeof item.title === 'string' ? item.title : item.url.replace('#', '').replace(/-/g, ' '),
    }));

  return (
    <BlogPostWrapper sections={sections}>
      <StructuredData id="blog-posting-schema" data={jsonLd} />
      <article className="mx-auto w-full max-w-4xl px-6 py-12">
        <Link
          href="/blog"
          className="mb-8 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back to blog
        </Link>

        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            {page.data.title}
          </h1>
          {page.data.description && (
            <p className="mt-3 text-lg text-muted-foreground">
              {page.data.description}
            </p>
          )}
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <span>{page.data.author}</span>
            <span>&middot;</span>
            <time dateTime={String(page.data.date)}>
              {new Date(page.data.date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </time>
          </div>
        </header>

        <div className="prose prose-gray max-w-none dark:prose-invert">
          <Mdx components={defaultMdxComponents} />
        </div>
      </article>
    </BlogPostWrapper>
  );
}

export function generateStaticParams(): { slug: string }[] {
  return blog.getPages().map((page) => ({
    slug: page.slugs[0],
  }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  const page = blog.getPage([params.slug]);
  if (!page) notFound();

  const url = `https://dial8.ai/blog/${params.slug}`;
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: `/blog/${params.slug}` },
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      url,
      type: 'article',
      publishedTime: page.data.date ? String(page.data.date) : undefined,
      authors: page.data.author ? [page.data.author] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title: page.data.title,
      description: page.data.description,
    },
  };
}
