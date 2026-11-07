'use client'

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { ContentSection, PageHeader, PageLayout, type Section } from '@/components/page-layout'
import { clsx } from 'clsx'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { useState } from 'react'

const sections: Section[] = [
  { id: 'vision', label: 'The Vision' },
  { id: 'founder', label: 'Founder' },
  { id: 'join', label: 'Join Us' },
  { id: 'investors', label: 'Investors' },
  { id: 'contact', label: 'Get in Touch' },
]

type FormState = 'idle' | 'loading' | 'success' | 'error'

function ContactForm() {
  const [formData, setFormData] = useState({ name: '', email: '', message: '', type: 'team' })
  const [formState, setFormState] = useState<FormState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const posthog = usePostHog()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.email || !formData.email.includes('@') || !formData.name) {
      setErrorMessage('Please fill in your name and a valid email.')
      setFormState('error')
      return
    }
    setFormState('loading')
    setErrorMessage('')
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })
      if (!response.ok) throw new Error('Failed to send')
      setFormState('success')
      posthog?.capture('about_contact_submitted', { type: formData.type })
      setFormData({ name: '', email: '', message: '', type: 'team' })
    } catch {
      setFormState('error')
      setErrorMessage('Something went wrong. Please try again.')
    }
  }

  if (formState === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-green-200 bg-green-50 p-8 text-center dark:border-green-800/30 dark:bg-green-900/10"
      >
        <div className="inline-flex items-center gap-2 text-green-800 dark:text-green-400">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-lg font-medium">Message sent!</span>
        </div>
        <p className="mt-2 text-sm text-green-700 dark:text-green-400/80">
          Thanks for reaching out. We&apos;ll get back to you soon.
        </p>
      </motion.div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="contact-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Name
          </label>
          <input
            id="contact-name"
            type="text"
            value={formData.name}
            onChange={(e) => { setFormData({ ...formData, name: e.target.value }); if (formState === 'error') setFormState('idle') }}
            placeholder="Your name"
            className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 placeholder:text-gray-500 focus:border-gray-900 focus:outline-hidden focus:ring-1 focus:ring-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-gray-500 dark:focus:ring-gray-500"
          />
        </div>
        <div>
          <label htmlFor="contact-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Email
          </label>
          <input
            id="contact-email"
            type="email"
            value={formData.email}
            onChange={(e) => { setFormData({ ...formData, email: e.target.value }); if (formState === 'error') setFormState('idle') }}
            placeholder="Your email"
            className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 placeholder:text-gray-500 focus:border-gray-900 focus:outline-hidden focus:ring-1 focus:ring-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-gray-500 dark:focus:ring-gray-500"
          />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          I&apos;m reaching out to...
        </label>
        <div className="flex gap-2">
          {(['team', 'investor'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setFormData({ ...formData, type })}
              className={clsx(
                'rounded-full px-4 py-1.5 text-xs font-medium uppercase tracking-wider transition-all',
                formData.type === type
                  ? 'bg-gray-950 text-white dark:bg-white dark:text-gray-950'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-400 dark:hover:bg-white/15'
              )}
            >
              {type === 'team' ? 'Join the team' : 'Invest'}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="contact-message" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Message
        </label>
        <textarea
          id="contact-message"
          value={formData.message}
          onChange={(e) => setFormData({ ...formData, message: e.target.value })}
          placeholder={
            formData.type === 'team'
              ? "Tell me about yourself—what you've built, what drives you, and why this resonates with you."
              : 'Tell me about your investment thesis and why this vision excites you.'
          }
          rows={5}
          className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 placeholder:text-gray-500 focus:border-gray-900 focus:outline-hidden focus:ring-1 focus:ring-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-gray-500 dark:focus:ring-gray-500 resize-none"
        />
      </div>
      <button
        type="submit"
        disabled={formState === 'loading'}
        className={clsx(
          'inline-flex w-full items-center justify-center rounded-full px-4 py-[calc(var(--spacing)*2-1px)]',
          'border border-transparent bg-gray-950 shadow-md',
          'whitespace-nowrap text-base font-medium text-white',
          'hover:bg-gray-800 disabled:opacity-40',
          'dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200'
        )}
      >
        {formState === 'loading' ? 'Sending...' : 'Send Message'}
      </button>
      {formState === 'error' && errorMessage && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </motion.p>
      )}
    </form>
  )
}

export default function About() {
  return (
    <PageLayout sections={sections}>
      <div>
        <Navbar />
        <PageHeader
          eyebrow="About Dial8"
          title="Your information should work for you, not the other way around."
          description="We're building the future of personal information management—an agentic workspace where everything you do gets captured, organized, and made accessible without the overhead."
        />

        <main className="pb-24">
          {/* The Vision */}
          <ContentSection id="vision" title="The Vision" isFirst>
            <div className="space-y-6">
              <p>
                We&apos;re building an agentic workspace that&apos;s personal to you. A place where everything
                you say, commit to, and work on is captured automatically and organized in real
                time&mdash;so you never have to manage information again.
              </p>
              <p>
                Think back a month. What was that conversation you had with Nick about his forecasting
                mechanism? With Dial8, you just ask&mdash;and it pulls it right up. Every meeting, every
                decision, every commitment. Accessible through text or voice, like a natural conversation
                with your own memory.
              </p>
              <p>
                But we&apos;re not stopping at individuals. We imagine a world where teams share workspaces.
                Where a call about a project automatically delegates action items to the right people.
                Where commitments made in conversation appear on dashboards in real time. Where you can
                open a project folder, ask &ldquo;what&apos;s the latest?&rdquo;, and get caught up
                instantly&mdash;even if you missed the last ten calls.
              </p>
              <p>
                And then we take it further: personal AI agents that specialize in different areas of
                your life. Agents that collaborate with other people&apos;s agents. That build things together
                based on shared context. That do the work&mdash;so people can come together and review it.
              </p>
              <p className="font-semibold text-gray-950 dark:text-white">
                We&apos;re building a more human information management system. One where you live your life,
                do your work, and everything gets captured, sorted, and made accessible&mdash;without
                the overhead.
              </p>
            </div>
          </ContentSection>

          {/* Founder */}
          <ContentSection id="founder" title="Founder">
            <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
              <div className="h-20 w-20 shrink-0 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center overflow-hidden">
                <span className="text-2xl font-medium text-gray-400 dark:text-gray-500">LA</span>
              </div>
              <div>
                <h3 className="text-xl font-semibold text-gray-950 dark:text-white">
                  Liam Alizadeh
                </h3>
                <p className="mt-1 text-sm font-medium uppercase tracking-wider text-muted-foreground">
                  Founder
                </p>
              </div>
            </div>
            <p className="mt-6">
              We&apos;re building the future of personal information management out of New York City. Our
              goal is to build a lean, high-impact company&mdash;a small team of exceptional people
              who each bring the full picture to everything they do.
            </p>
          </ContentSection>

          {/* Join the Team */}
          <ContentSection id="join" title="Join the Team">
            <div className="space-y-4">
              <p>
                We believe the best products are built by well-rounded people&mdash;those who are strong
                across product, engineering, design, and business. People who can hold the full picture
                and execute anywhere.
              </p>
              <p>
                If you&apos;ve built amazing products, if you share our vision for the future of work, and
                if you want to be part of building something meaningful&mdash;we&apos;d love to hear from you.
              </p>
              <p className="font-semibold text-gray-950 dark:text-white">
                We&apos;re looking for co-builders who want to take this from zero to one together.
              </p>
            </div>
          </ContentSection>

          {/* Investors */}
          <ContentSection id="investors" title="Investors">
            <div className="space-y-4">
              <p>
                We&apos;re building the operating system for how people manage information. A platform where
                individuals, teams, and AI agents collaborate seamlessly&mdash;where the overhead of
                managing work disappears entirely.
              </p>
              <p>
                If you believe in this idea and want to be an early investor in the future of human-AI
                collaboration, we&apos;d love to hear from you.
              </p>
              <p className="font-semibold text-gray-950 dark:text-white">
                We&apos;re open to early conversations with investors who share our vision.
              </p>
            </div>
          </ContentSection>

          {/* Contact Form */}
          <ContentSection id="contact" title="Get in Touch">
            <p className="mb-8">
              Whether you want to help build this or back it&mdash;start here.
            </p>
            <div className="max-w-lg">
              <ContactForm />
            </div>
          </ContentSection>
        </main>
      </div>
      <Footer />
    </PageLayout>
  )
}
