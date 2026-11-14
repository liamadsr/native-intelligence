import { Link } from '@/components/link'
import { COMPETITORS, VS_COMPETITOR_SLUGS } from '@/data/vs-competitors'
import { cn } from '@/lib/utils'

/**
 * The row of links to every /vs comparison page. It sits at the foot of each
 * comparison (the page's own vendor in plain text) and under the pricing table,
 * so every comparison is one click from a page the home page links to.
 */
export function CompareLinks({
  current,
  label = 'Compare Native Intelligence with',
  centered = false,
}: {
  current?: string
  label?: string
  centered?: boolean
}) {
  return (
    <div className={cn(centered && 'text-center')}>
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <nav
        aria-label="Comparisons"
        className={cn(
          'mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm',
          centered && 'justify-center',
        )}
      >
        {VS_COMPETITOR_SLUGS.map((slug, i) => {
          const c = COMPETITORS[slug]
          return (
            <span key={slug} className="flex items-center gap-2">
              {i > 0 && (
                <span className="text-border" aria-hidden>
                  ·
                </span>
              )}
              {slug === current ? (
                <span className="font-medium text-foreground">{c.name}</span>
              ) : (
                <Link
                  href={`/vs/${slug}`}
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {c.name}
                </Link>
              )}
            </span>
          )
        })}
      </nav>
    </div>
  )
}
