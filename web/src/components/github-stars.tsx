'use client'

import { useEffect, useState } from 'react'

export function GitHubStars() {
  const [stars, setStars] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchStars() {
      try {
        const response = await fetch('https://api.github.com/repos/liamadsr/dial8-open-source')
        if (response.ok) {
          const data = await response.json()
          setStars(data.stargazers_count)
        }
      } catch (error) {
        console.error('Failed to fetch GitHub stars:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchStars()
  }, [])

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium">
        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
          <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/>
        </svg>
        <span className="w-5 h-3 rounded animate-pulse opacity-30 bg-current"></span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 text-sm font-medium">
      <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
        <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/>
      </svg>
      <span>{stars !== null ? formatStarCount(stars) : '—'}</span>
    </span>
  )
}

function formatStarCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return count.toString()
}