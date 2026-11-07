export interface ReleaseNote {
  version: string
  date: string // YYYY-MM-DD format
  title?: string // Optional custom title, defaults to "What's New in Dial8 {version}"
  warning?: string // Optional breaking-change / compatibility warning shown prominently
  changes: {
    features?: string[]
    improvements?: string[]
    fixes?: string[]
  }
}

export const releases: ReleaseNote[] = [
  {
    version: '2.15.0',
    date: '2026-02-28',
    warning: 'This update requires macOS 26 or later. If you are running an older version of macOS, do not update — your current version of Dial8 will continue to work.',
    changes: {
      features: [
        'Meeting capture — Dial8 now records meetings and automatically extracts action items so nothing falls through the cracks',
        'Email and calendar integration — connect your email and calendar to see upcoming meetings and stay on top of follow-ups',
        'Action items dashboard — a single view of everything that needs your attention, pulled from calls, meetings, and emails',
        'Folders — organise your conversations and action items into folders',
      ],
    },
  },
  {
    version: '2.14.0',
    date: '2024-11-20',
    changes: {
      features: [
        'Added email sign up as an option for creating new accounts',
      ],
      fixes: [
        'Fixed repeated reconnection attempts with certain headphones',
      ],
    },
  },
  {
    version: '2.13.0',
    date: '2024-11-14',
    changes: {
      fixes: [
        'Fixed login issue',
      ],
    },
  },
  {
    version: '2.12.0',
    date: '2024-11-14',
    changes: {
      fixes: [
        'Fixed Quality voice mode reverting to Instant without explanation. Thanks @ARGeek123 and @draedus12 for reporting!',
        'Added proper error messaging when Quality models haven\'t been downloaded',
        'Quality voices now work correctly after model download and selection',
        'Auto-selects first available Quality voice when switching to Quality mode',
        'Fixed duplicate voice names appearing in voice selection menu. Thanks @Cheifbrody for reporting!',
        'Closing the main window now keeps the app running in the menu bar instead of quitting. Thanks @adithradh for reporting!',
      ],
    },
  },
  {
    version: '2.11.0',
    date: '2024-11-13',
    changes: {
      fixes: [
        'Fixed Google OAuth window spinning indefinitely after granting access. Thanks @draedus12 for reporting!',
        'Fixed update notifications to only appear when a new version is available. Thanks @Mstormer, @draedus12, and @adithradh for reporting!',
      ],
    },
  },
]

// Helper function to get the latest release
export function getLatestRelease(): ReleaseNote {
  return releases[0]
}

// Helper function to format release for display
export function formatReleaseTitle(release: ReleaseNote): string {
  return release.title || `What's New in Dial8 ${release.version}`
}

// Helper function to get all changes as a flat list (for Sparkle)
export function getAllChangesFlat(release: ReleaseNote): string[] {
  const allChanges: string[] = []

  if (release.changes.features) {
    allChanges.push(...release.changes.features)
  }
  if (release.changes.improvements) {
    allChanges.push(...release.changes.improvements)
  }
  if (release.changes.fixes) {
    allChanges.push(...release.changes.fixes)
  }

  return allChanges
}
