'use client'

import { motion } from 'framer-motion'

const logos = [
  { alt: 'calandar', src: '/logo-timeline/calandar.svg' },
  { alt: 'chrome', src: '/logo-timeline/chrome.svg' },
  { alt: 'Notes', src: '/logo-timeline/Notes.svg' },
  { alt: 'discord', src: '/logo-timeline/discord.svg' },
  { alt: 'edge', src: '/logo-timeline/edge.svg' },
  { alt: 'Reminders', src: '/logo-timeline/Reminders.svg' },
  { alt: 'Message', src: '/logo-timeline/Message.svg' },
  { alt: 'excel', src: '/logo-timeline/excel.svg' },
  { alt: 'facebook', src: '/logo-timeline/facebook.svg' },
  { alt: 'Safari', src: '/logo-timeline/Safari.svg' },
  { alt: 'figma', src: '/logo-timeline/figma.svg' },
  { alt: 'github', src: '/logo-timeline/github.svg' },
  { alt: 'gmail', src: '/logo-timeline/gmail.svg' },
  { alt: 'google-calendar', src: '/logo-timeline/google-calendar.svg' },
  { alt: 'google-drive', src: '/logo-timeline/google-drive.svg' },
  { alt: 'googlenotes', src: '/logo-timeline/googlenotes.svg' },
  { alt: 'hangouts', src: '/logo-timeline/hangouts.svg' },
  { alt: 'keynotes', src: '/logo-timeline/keynotes.svg' },
  { alt: 'linkedin', src: '/logo-timeline/linkedin.svg' },
  { alt: 'loom', src: '/logo-timeline/loom.svg' },
  { alt: 'Mail', src: '/logo-timeline/Mail.svg' },
  { alt: 'med', src: '/logo-timeline/med.svg' },
  { alt: 'onenote', src: '/logo-timeline/onenote.svg' },
  { alt: 'outlook', src: '/logo-timeline/outlook.svg' },
  { alt: 'powerpoint', src: '/logo-timeline/powerpoint.svg' },
  { alt: 'reddit', src: '/logo-timeline/reddit.svg' },
  { alt: 'signal', src: '/logo-timeline/signal.svg' },
  { alt: 'skype', src: '/logo-timeline/skype.svg' },
  { alt: 'slack', src: '/logo-timeline/slack.svg' },
  { alt: 'snap', src: '/logo-timeline/snap.svg' },
  { alt: 'teams', src: '/logo-timeline/teams.svg' },
  { alt: 'telagram', src: '/logo-timeline/telagram.svg' },
  { alt: 'Threads', src: '/logo-timeline/Threads.svg' },
  { alt: 'whatsapp', src: '/logo-timeline/whatsapp.svg' },
  { alt: 'word', src: '/logo-timeline/word.svg' },
  { alt: 'x', src: '/logo-timeline/x.svg' },
  { alt: 'zoom', src: '/logo-timeline/zoom.svg' },


]

export function LogoCloud({
  className,
}: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div className={`${className} relative overflow-hidden`}>
      <div className="flex w-full">
        <motion.div 
          className="flex shrink-0 gap-0"
          animate={{
            x: ['0%', '-50%'],
          }}
          transition={{
            duration: logos.length * 1.5,
            ease: "linear",
            repeat: Infinity,
            repeatType: "loop",
          }}
          style={{ paddingRight: '0' }}
        >
          {[...logos, ...logos].map((logo, idx) => (
            <div
              key={idx}
              className="relative w-16 h-16 shrink-0 flex items-center justify-center"
            >
              <div className="w-12 h-12 relative ring-2 ring-gray-200/30 rounded-lg p-2">
                <img
                  src={logo.src}
                  alt={logo.alt}
                  className="absolute inset-0 w-full h-full object-contain"
                />
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  )
}
