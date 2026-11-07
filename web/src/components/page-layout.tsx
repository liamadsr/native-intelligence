'use client'

import { clsx } from 'clsx'
import { motion, AnimatePresence } from 'framer-motion'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

export interface Section {
  id: string
  label: string
  href?: string
}

interface PageLayoutProps {
  children: React.ReactNode
  sections?: Section[]
}

// Consistent page header component for all interior pages
interface PageHeaderProps {
  eyebrow?: string
  title: string
  description?: string
  meta?: string // For things like "Last Updated: ..."
}

export function PageHeader({ eyebrow, title, description, meta }: PageHeaderProps) {
  return (
    <div className="pt-32 pb-16 lg:pt-40 lg:pb-20 px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {eyebrow && (
            <p className="font-mono text-xs/5 font-semibold uppercase tracking-widest text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <h1
            className={clsx(
              'text-pretty text-4xl font-medium tracking-tighter text-foreground sm:text-5xl',
              eyebrow && 'mt-2'
            )}
          >
            {title}
          </h1>
          {description && (
            <p className="mt-4 text-lg text-muted-foreground">
              {description}
            </p>
          )}
          {meta && (
            <p className="mt-4 text-sm text-muted-foreground">
              {meta}
            </p>
          )}
        </motion.div>
      </div>
    </div>
  )
}

// Consistent content section component for interior pages
interface ContentSectionProps {
  id: string
  title?: string
  children: React.ReactNode
  isFirst?: boolean
}

export function ContentSection({ id, title, children, isFirst = false }: ContentSectionProps) {
  return (
    <section id={id} className="py-16 lg:py-20 relative scroll-mt-20">
      {!isFirst && (
        <div className="absolute top-0 left-0 right-0 flex items-center justify-center px-6 lg:px-8">
          <div className="w-full max-w-4xl">
            <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
          </div>
        </div>
      )}
      <div className="px-6 lg:px-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5 }}
        className="mx-auto max-w-4xl"
      >
        {title && (
          <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            {title}
          </h2>
        )}
        <div className={clsx(title && 'mt-6', 'text-base leading-7 text-foreground/80')}>
          {children}
        </div>
      </motion.div>
      </div>
    </section>
  )
}

function NavLinks() {
  const pathname = usePathname()

  const links = [
    { href: '/', label: 'Home' },
    { href: '/release-notes', label: 'Release Notes' },
    { href: '/about', label: 'About' },
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms', label: 'Terms' },
  ]

  return (
    <ul className="flex flex-col gap-2">
      {links.map((link) => (
        <li key={link.href}>
          <Link
            href={link.href}
            className={clsx(
              'text-sm font-medium transition-colors',
              pathname === link.href
                ? 'text-foreground'
                : 'text-muted-foreground/60 hover:text-muted-foreground'
            )}
          >
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function SidebarNav({ sections }: { sections?: Section[] }) {
  const pathname = usePathname()
  const hasLinks = sections?.some((s) => s.href)
  const [activeSection, setActiveSection] = useState<string>(sections?.[0]?.id || '')

  useEffect(() => {
    if (!sections || sections.length === 0 || hasLinks) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id)
          }
        })
      },
      {
        rootMargin: '-20% 0px -60% 0px',
        threshold: 0,
      }
    )

    sections.forEach((section) => {
      const element = document.getElementById(section.id)
      if (element) {
        observer.observe(element)
      }
    })

    return () => observer.disconnect()
  }, [sections, hasLinks])

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <nav className="hidden lg:flex fixed left-8 top-0 bottom-0 z-40 flex-col justify-between py-8">
      <div className="flex-1 flex items-center overflow-hidden">
        {sections && sections.length > 0 && (
          <ul className="flex flex-col gap-1 max-w-[200px] max-h-[60vh] overflow-y-auto scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none]">
            {sections.map((section) => {
              const isActive = hasLinks
                ? pathname === section.href
                : activeSection === section.id

              const content = (
                <>
                  <span
                    className={clsx(
                      'h-px shrink-0 transition-all duration-200',
                      isActive
                        ? 'w-8 bg-foreground'
                        : 'w-4 bg-border group-hover:w-6 group-hover:bg-muted-foreground/50'
                    )}
                  />
                  <span className="truncate">{section.label}</span>
                </>
              )

              return (
                <li key={section.id}>
                  {section.href ? (
                    <Link
                      href={section.href}
                      className={clsx(
                        'group flex items-center gap-3 py-2 text-sm font-medium transition-all duration-200',
                        isActive
                          ? 'text-foreground'
                          : 'text-muted-foreground/60 hover:text-muted-foreground'
                      )}
                    >
                      {content}
                    </Link>
                  ) : (
                    <button
                      onClick={() => scrollToSection(section.id)}
                      className={clsx(
                        'group flex items-center gap-3 py-2 text-sm font-medium transition-all duration-200',
                        isActive
                          ? 'text-foreground'
                          : 'text-muted-foreground/60 hover:text-muted-foreground'
                      )}
                    >
                      {content}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <NavLinks />
    </nav>
  )
}

function MobileNav({ sections, activeSection }: { sections: Section[]; activeSection: string }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const activeIndex = sections.findIndex((s) => s.id === activeSection)

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' })
    }
    setIsExpanded(false)
  }

  const currentSection = sections.find((s) => s.id === activeSection)

  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 flex justify-center pb-6 pointer-events-none">
      <AnimatePresence mode="wait">
        {isExpanded ? (
          <motion.div
            key="expanded"
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ type: 'spring', damping: 30, stiffness: 500 }}
            className="pointer-events-auto w-[calc(100%-2rem)] max-w-md"
          >
            <div className="bg-black/80 backdrop-blur-2xl rounded-3xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden">
              {/* Header */}
              <div className="px-4 pt-4 pb-3 border-b border-white/5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-white/40 uppercase tracking-wider">Sections</span>
                  <button
                    onClick={() => setIsExpanded(false)}
                    className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors"
                  >
                    <svg className="w-4 h-4 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Sections list - hidden scrollbar */}
              <div className="p-2 max-h-[50vh] overflow-y-auto scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none]">
                <div className="space-y-0.5">
                  {sections.map((section, index) => (
                    <motion.button
                      key={section.id}
                      onClick={() => scrollToSection(section.id)}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.01, duration: 0.15 }}
                      className={clsx(
                        'w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-left transition-all',
                        activeSection === section.id
                          ? 'bg-white text-black'
                          : 'text-white/70 active:bg-white/10'
                      )}
                    >
                      <span className={clsx(
                        'w-7 h-7 flex items-center justify-center rounded-full text-xs font-semibold',
                        activeSection === section.id
                          ? 'bg-black text-white'
                          : 'bg-white/10 text-white/50'
                      )}>
                        {index + 1}
                      </span>
                      <span className="text-sm font-medium">{section.label}</span>
                      {activeSection === section.id && (
                        <motion.div
                          layoutId="activeCheck"
                          className="ml-auto"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                        </motion.div>
                      )}
                    </motion.button>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="collapsed"
            onClick={() => setIsExpanded(true)}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            whileTap={{ scale: 0.98 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="pointer-events-auto flex items-center gap-3 px-4 py-2.5 bg-black/70 backdrop-blur-2xl rounded-full border border-white/10 shadow-lg shadow-black/30"
          >
            {/* Progress ring */}
            <div className="relative w-8 h-8">
              <svg className="w-8 h-8 -rotate-90" viewBox="0 0 32 32">
                <circle
                  cx="16"
                  cy="16"
                  r="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-white/10"
                />
                <motion.circle
                  cx="16"
                  cy="16"
                  r="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  className="text-white"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: (activeIndex + 1) / sections.length }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                  style={{
                    strokeDasharray: '75.4',
                    strokeDashoffset: '0',
                  }}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white">
                {activeIndex + 1}
              </span>
            </div>

            {/* Label - fixed width to prevent resizing, centered */}
            <div className="flex flex-col items-center justify-center min-w-[100px]">
              <span className="text-sm font-medium text-white leading-tight text-center">
                {currentSection?.label}
              </span>
            </div>

            {/* Expand indicator */}
            <svg className="w-4 h-4 text-white/40 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

function MobileNavWrapper({ sections }: { sections?: Section[] }) {
  const [activeSection, setActiveSection] = useState<string>(sections?.[0]?.id || '')

  useEffect(() => {
    if (!sections || sections.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id)
          }
        })
      },
      {
        rootMargin: '-20% 0px -60% 0px',
        threshold: 0,
      }
    )

    sections.forEach((section) => {
      const element = document.getElementById(section.id)
      if (element) {
        observer.observe(element)
      }
    })

    return () => observer.disconnect()
  }, [sections])

  if (!sections || sections.length === 0) return null

  return <MobileNav sections={sections} activeSection={activeSection} />
}

export function PageLayout({ children, sections }: PageLayoutProps) {
  return (
    <div className="overflow-hidden">
      {/* Left sidebar with vertical line. No fill: the public sky
          (components/sky/public-sky.tsx) shows through it like the rest of
          the page (Liam: no vertical bands or column scrims). */}
      <div className="hidden lg:block fixed left-0 top-0 bottom-0 w-60 z-30">
        <div className="absolute top-0 bottom-0 right-0 w-px bg-linear-to-b from-border/50 via-border to-border/50" />
        {/* App icon - centered in sidebar, links to home */}
        <div className="absolute top-8 left-0 right-0 flex justify-center z-40">
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <Link href="/" title="Go to homepage">
              {/* Always the dark app icon — the light/marble variant is retired. */}
              <img
                src="/screenshots/Icon-macOS-Dark-1024x1024@2x-dark.png"
                alt="Dial8"
                className="w-20 h-20 hover:scale-105 transition-transform"
              />
            </Link>
          </motion.div>
        </div>
      </div>
      <SidebarNav sections={sections} />
      <MobileNavWrapper sections={sections} />
      <div className="lg:pl-60">{children}</div>
    </div>
  )
}
