'use client'

import { clsx } from 'clsx'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { useState } from 'react'

type FormState = 'idle' | 'loading' | 'success' | 'error'

export function EarlyAccessForm({
  className,
  source = 'website',
  buttonText = 'Get Early Access',
  successMessage = "You're on the list!",
  successDetail = "We'll be in touch soon with early access details.",
}: {
  className?: string
  source?: string
  buttonText?: string
  successMessage?: string
  successDetail?: string
}) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<FormState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const posthog = usePostHog()

  // Honeypot field - bots will fill this, humans won't see it
  const [honeypot, setHoneypot] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!email || !email.includes('@')) {
      setErrorMessage('Please enter a valid email address')
      setState('error')
      return
    }

    setState('loading')
    setErrorMessage('')

    try {
      const response = await fetch('/api/early-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, honeypot, source }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Something went wrong')
      }

      setState('success')
      posthog?.capture('waitlist_signup', { source })
      posthog?.identify(email, { email, source })
      setEmail('')
    } catch (error) {
      setState('error')
      setErrorMessage(error instanceof Error ? error.message : 'Something went wrong')
    }
  }

  if (state === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={clsx('text-center', className)}
      >
        <div className="inline-flex items-center gap-2 rounded-full bg-green-100 px-4 py-2 text-green-800 dark:bg-green-900/30 dark:text-green-400">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="font-medium">{successMessage}</span>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {successDetail}
        </p>
      </motion.div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className={clsx('w-full max-w-md', className)}>
      {/* Honeypot field - hidden from users, bots will fill it */}
      <input
        type="text"
        name="website"
        value={honeypot}
        onChange={(e) => setHoneypot(e.target.value)}
        className="absolute -left-[9999px] opacity-0 pointer-events-none"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            if (state === 'error') setState('idle')
          }}
          placeholder="Enter your email"
          className={clsx(
            'flex-1 rounded-full border bg-background px-4 py-3 text-base text-foreground placeholder:text-muted-foreground',
            'focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2',
            state === 'error'
              ? 'border-red-500'
              : 'border-border'
          )}
          disabled={state === 'loading'}
        />
        <button
          type="submit"
          disabled={state === 'loading'}
          className={clsx(
            'inline-flex items-center justify-center rounded-full px-6 py-3 text-base font-medium',
            'bg-primary text-primary-foreground shadow-md transition-colors',
            'hover:bg-primary/90 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {state === 'loading' ? (
            <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          ) : (
            buttonText
          )}
        </button>
      </div>
      {state === 'error' && errorMessage && (
        <motion.p
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-2 text-center text-sm text-red-600 dark:text-red-400"
        >
          {errorMessage}
        </motion.p>
      )}
    </form>
  )
}
