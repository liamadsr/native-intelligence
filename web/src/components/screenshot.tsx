'use client'

import { clsx } from 'clsx'
import { motion, AnimatePresence } from 'framer-motion'
import { useState, useEffect } from 'react'

export function Screenshot({
  width,
  height,
  src,
  srcDark,
  className,
}: {
  width: number
  height: number
  src: string
  srcDark?: string
  className?: string
}) {
  const [isEnlarged, setIsEnlarged] = useState(false)

  useEffect(() => {
    if (!isEnlarged) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsEnlarged(false)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isEnlarged])

  return (
    <>
      <div className={clsx(className, 'cursor-zoom-in')} onClick={() => setIsEnlarged(true)}>
        {srcDark ? (
          <>
            {/* Light mode image */}
            <img
              alt=""
              src={src}
              width={width}
              height={height}
              className="w-full h-auto rounded-xl shadow-2xl ring-1 ring-black/10 dark:hidden"
            />
            {/* Dark mode image */}
            <img
              alt=""
              src={srcDark}
              width={width}
              height={height}
              className="w-full h-auto rounded-xl shadow-2xl ring-1 ring-black/10 hidden dark:block"
            />
          </>
        ) : (
          <img
            alt=""
            src={src}
            width={width}
            height={height}
            className="w-full h-auto rounded-xl shadow-2xl ring-1 ring-black/10"
          />
        )}
      </div>

      {/* Fullscreen modal */}
      <AnimatePresence>
        {isEnlarged && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsEnlarged(false)}
            className="fixed inset-0 z-100 flex items-center justify-center bg-black/95 backdrop-blur-xs cursor-zoom-out p-4"
          >
            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.9 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="relative max-w-[95vw] max-h-[95vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close button */}
              <button
                onClick={() => setIsEnlarged(false)}
                className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors text-white z-10"
                aria-label="Close"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              {srcDark ? (
                <>
                  {/* Light mode enlarged image */}
                  <img
                    alt=""
                    src={src}
                    className="w-auto h-auto max-w-full max-h-[95vh] rounded-lg shadow-2xl dark:hidden"
                  />
                  {/* Dark mode enlarged image */}
                  <img
                    alt=""
                    src={srcDark}
                    className="w-auto h-auto max-w-full max-h-[95vh] rounded-lg shadow-2xl hidden dark:block"
                  />
                </>
              ) : (
                <img
                  alt=""
                  src={src}
                  className="w-auto h-auto max-w-full max-h-[95vh] rounded-lg shadow-2xl"
                />
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
