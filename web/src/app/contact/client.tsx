'use client'

import { useState } from 'react'
import { usePostHog } from 'posthog-js/react'
import { Container } from '@/components/container'
import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { Heading } from '@/components/text'
import { Button } from '@/components/button'

export default function Contact() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    message: ''
  })
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const posthog = usePostHog()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setStatus('idle')

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      })

      if (response.ok) {
        setStatus('success')
        setFormData({ name: '', email: '', message: '' })
        posthog?.capture('contact_form_submitted')
      } else {
        setStatus('error')
      }
    } catch (error) {
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value
    }))
  }

  return (
    <div className="overflow-hidden">
      <div className="relative">
        <Container className="relative">
          <Navbar />
          <div className="pb-24 pt-16 sm:pb-32 sm:pt-24">
            <div className="mx-auto max-w-2xl">
              <Heading as="h1" className="text-center">
                Contact Us
              </Heading>
              <p className="mt-6 text-center text-lg text-muted-foreground">
                Have a question or feedback? We&apos;d love to hear from you.
              </p>

              <form onSubmit={handleSubmit} className="mt-12 space-y-6">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Name
                  </label>
                  <input
                    type="text"
                    id="name"
                    name="name"
                    required
                    value={formData.name}
                    onChange={handleChange}
                    className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 focus:border-gray-900 focus:outline-hidden focus:ring-1 focus:ring-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:focus:border-gray-500 dark:focus:ring-gray-500"
                  />
                </div>

                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Email
                  </label>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    required
                    value={formData.email}
                    onChange={handleChange}
                    className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 focus:border-gray-900 focus:outline-hidden focus:ring-1 focus:ring-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:focus:border-gray-500 dark:focus:ring-gray-500"
                  />
                </div>

                <div>
                  <label htmlFor="message" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Message
                  </label>
                  <textarea
                    id="message"
                    name="message"
                    required
                    rows={5}
                    value={formData.message}
                    onChange={handleChange}
                    className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 focus:border-gray-900 focus:outline-hidden focus:ring-1 focus:ring-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:focus:border-gray-500 dark:focus:ring-gray-500"
                  />
                </div>

                <div>
                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full justify-center"
                  >
                    {loading ? 'Sending...' : 'Send Message'}
                  </Button>
                </div>

                {status === 'success' && (
                  <p className="text-center text-sm text-green-600">
                    Thank you for your message! We&apos;ll get back to you soon.
                  </p>
                )}

                {status === 'error' && (
                  <p className="text-center text-sm text-red-600">
                    Something went wrong. Please try again later.
                  </p>
                )}
              </form>
            </div>
          </div>
        </Container>
      </div>
      <Footer />
    </div>
  )
}