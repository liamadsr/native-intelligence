/**
 * The public site's side panel: every page a visitor can go to, grouped.
 * components/site/site-shell.tsx draws it; the feature entries are the same
 * slugs lib/marketing/features/index.ts has content for (a test holds the two
 * together), so a feature added to one and not the other fails loudly.
 */
import {
  ArrowRightLeft,
  AudioLines,
  BookOpen,
  Brain,
  Building2,
  Calendar,
  CalendarClock,
  Clapperboard,
  FileText,
  GitPullRequest,
  GraduationCap,
  HardDrive,
  History,
  Home,
  Layers,
  LayoutGrid,
  ListChecks,
  Mail,
  Map,
  MessagesSquare,
  Monitor,
  Newspaper,
  Plug,
  SearchCheck,
  Sunrise,
  Sparkles,
  Table2,
  Tag,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

/** The docs page that says how each piece of a team's work comes across. */
export const SWITCHING_GUIDE = '/docs/getting-started/switching'

export interface SiteNavItem {
  name: string
  href: string
  icon: LucideIcon
}

export interface SiteNavGroup {
  /** No label: the links that sit above the first group. */
  label?: string
  items: SiteNavItem[]
}

const feature = (slug: string, name: string, icon: LucideIcon): SiteNavItem => ({
  name,
  href: `/features/${slug}`,
  icon,
})

export const TOP_FEATURES: SiteNavItem[] = [
  feature('mail', 'Mail', Mail),
  feature('tasks', 'Tasks', ListChecks),
  feature('chat', 'Chat', MessagesSquare),
  feature('docs', 'Docs', FileText),
  feature('meetings', 'Meetings', AudioLines),
  feature('crm', 'CRM', Building2),
  feature('agents', 'Agents', Sparkles),
  feature('tables', 'Tables', Table2),
  feature('calendar', 'Calendar', Calendar),
  feature('coding', 'Coding', GitPullRequest),
]

export const MORE_FEATURES: SiteNavItem[] = [
  feature('drive', 'Drive', HardDrive),
  feature('flows', 'Flows', Workflow),
  feature('skills', 'Skills', GraduationCap),
  feature('booking-links', 'Booking links', CalendarClock),
  feature('studio', 'Studio', Clapperboard),
  feature('seo', 'SEO', SearchCheck),
  feature('desktop-app', 'Desktop app', Monitor),
  feature('mcp', 'MCP', Plug),
]

/** Every feature with a deep-dive page, in the panel's order. */
export const FEATURE_NAV: SiteNavItem[] = [...TOP_FEATURES, ...MORE_FEATURES]

export const SITE_NAV: SiteNavGroup[] = [
  { items: [{ name: 'Home', href: '/', icon: Home }] },
  { label: 'Top features', items: TOP_FEATURES },
  {
    label: 'The workspace',
    items: [
      { name: 'Always-on agent', href: '/#always-on', icon: Sunrise },
      { name: 'One workspace', href: '/#workspace', icon: LayoutGrid },
      { name: 'Shared memory', href: '/#memory', icon: Brain },
    ],
  },
  { label: 'More features', items: MORE_FEATURES },
  {
    // Other tools are named here and in the docs only as what you leave or
    // import from. The connections that keep one running alongside are a
    // docs matter (the switching guide), never a marketing one.
    label: 'Switch',
    items: [
      { name: 'Replace your apps', href: '/replace-apps', icon: Layers },
      { name: 'Moving in', href: '/#integrations', icon: Plug },
      { name: 'Switching guide', href: SWITCHING_GUIDE, icon: ArrowRightLeft },
    ],
  },
  {
    label: 'More',
    items: [
      { name: 'Pricing', href: '/pricing', icon: Tag },
      { name: 'Docs', href: '/docs', icon: BookOpen },
      { name: 'Blog', href: '/blog', icon: Newspaper },
      { name: 'Roadmap', href: '/roadmap', icon: Map },
      { name: 'Release notes', href: '/release-notes', icon: History },
      { name: 'About', href: '/about', icon: Users },
    ],
  },
]
