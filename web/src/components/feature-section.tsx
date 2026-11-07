'use client'

import { clsx } from 'clsx'
import { motion } from 'framer-motion'

interface FeatureItemProps {
  title: string
  description: string
}

export function FeatureItem({ title, description }: FeatureItemProps) {
  return (
    <div>
      <h4 className="font-medium text-gray-950 dark:text-white">{title}</h4>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</p>
    </div>
  )
}

interface FeatureSectionContainerProps {
  id: string
  children: React.ReactNode
  className?: string
  showDivider?: boolean
}

export function FeatureSectionContainer({ id, children, className, showDivider = true }: FeatureSectionContainerProps) {
  return (
    <section
      id={id}
      className={clsx('min-h-screen flex items-center py-24 lg:py-32 relative', className)}
    >
      {showDivider && (
        <div className="absolute top-0 left-0 right-0 flex items-center justify-center px-6 lg:px-8">
          <div className="w-full max-w-6xl">
            <div className="h-px bg-linear-to-r from-transparent via-gray-300 to-transparent dark:via-gray-700" />
          </div>
        </div>
      )}
      <div className="w-full px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </div>
    </section>
  )
}

interface FeatureCardProps {
  children: React.ReactNode
  className?: string
}

export function FeatureCard({ children, className }: FeatureCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      className={clsx(
        'rounded-2xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900/50',
        className
      )}
    >
      {children}
    </motion.div>
  )
}

interface FeatureGridProps {
  children: React.ReactNode
  columns?: 2 | 3
}

export function FeatureGrid({ children, columns = 2 }: FeatureGridProps) {
  return (
    <div
      className={clsx(
        'grid gap-6',
        columns === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3'
      )}
    >
      {children}
    </div>
  )
}

interface SectionHeaderProps {
  badge?: string
  title: string
  description?: string
  align?: 'left' | 'center'
}

export function SectionHeader({ badge, title, description, align = 'left' }: SectionHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      className={clsx('mb-12', align === 'center' && 'text-center')}
    >
      {badge && (
        <span className="inline-block rounded-full bg-gray-100 px-3 py-1 text-xs font-medium uppercase tracking-wider text-gray-600 dark:bg-white/10 dark:text-gray-400">
          {badge}
        </span>
      )}
      <h2 className="mt-4 text-3xl font-medium tracking-tight text-gray-950 dark:text-white sm:text-4xl lg:text-5xl">
        {title}
      </h2>
      {description && (
        <p className={clsx(
          'mt-4 text-lg text-gray-600 dark:text-gray-400',
          align === 'center' ? 'mx-auto max-w-2xl' : 'max-w-xl'
        )}>
          {description}
        </p>
      )}
    </motion.div>
  )
}
