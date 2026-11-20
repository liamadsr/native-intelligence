import type { FeaturePage } from './types'

export const seo: FeaturePage = {
  slug: 'seo',
  name: 'SEO',
  title: 'Site audits, keywords and rank tracking in your workspace.',
  lead: 'Audit your site, research keywords, track where you rank, see who links to you and check whether AI assistants mention you. Every page is also something you can ask for in chat.',
  metaTitle: 'SEO: audits, keywords and rankings in one place',
  metaDescription:
    'Audit your website, research keywords, track rankings, check backlinks and local results, and see whether AI assistants mention your brand.',
  intro: [
    'Search work tends to sit apart from the rest of the company: a report someone pulls once a month, a list of fixes in a spreadsheet nobody owns. The findings rarely turn into tasks.',
    'The SEO area puts it next to everything else. An audit’s findings say what to fix and how, keyword lists sit beside the docs you write from them, and the assistant can answer “who ranks above us for this search?” in the same chat where you plan the work.',
  ],
  sections: [
    {
      id: 'audit',
      nav: 'Site audit',
      title: 'Find what is broken on your site.',
      body: 'An audit reads your site the way a search engine does and lists what it finds, most serious first, with what each finding means and how to fix it. It runs in the background, and you can stop it and keep what it found.',
      points: [
        'Broken links and pages, redirect chains',
        'Missing or duplicate titles and descriptions',
        'Heading and canonical problems, thin content',
        'Pages search engines are told to skip, and pages nothing links to',
      ],
    },
    {
      id: 'keywords',
      nav: 'Keywords',
      title: 'See what people search for.',
      body: 'Type a topic to get related searches with monthly volume, difficulty, intent and cost per click. Open one to see who ranks for it today, then save and tag the ones you want to keep.',
    },
    {
      id: 'rankings',
      nav: 'Rankings',
      title: 'Track where you rank.',
      body: 'A tracker follows a list of keywords for one site, in one country and language, on mobile, desktop or both. Check by hand or daily, weekly or monthly, and watch how many keywords sit in the top 3 and top 10 over time.',
    },
    {
      id: 'search-performance',
      nav: 'Performance',
      title: 'Your own clicks and impressions.',
      body: 'Connect your site’s search and analytics accounts, and the page shows clicks, impressions, click rate and average position by search and by page. It lists the searches where a small improvement would win the most traffic.',
    },
    {
      id: 'competitors',
      nav: 'Competitors',
      title: 'See who you compete with in search.',
      body: 'Enter any domain to see its estimated traffic, the keywords it ranks for and the sites that compete with it. Look up its backlinks too: who links to it, from which pages, newest or strongest first.',
    },
    {
      id: 'ai-visibility',
      nav: 'AI visibility',
      title: 'Find out if AI assistants mention you.',
      body: 'A tracker asks AI assistants, ChatGPT and Claude among them, the questions your customers ask. It records whether your brand or a competitor is mentioned, and which sources each answer cites. Read every answer in full.',
    },
    {
      id: 'local',
      nav: 'Local',
      title: 'See where you show up on the map.',
      body: 'Add your business as it appears on the map to see its profile and reviews. A grid scan runs the same search from points around your address and shows where you rank at each one.',
    },
    {
      id: 'costs',
      nav: 'Costs',
      title: 'You see the cost before it spends.',
      body: 'Some lookups come from a search-data provider that charges per lookup. Each workspace has a monthly budget, a lookup that costs more than a few cents shows its estimate and waits for your yes, and results are kept so looking again spends nothing.',
    },
  ],
  faq: [
    {
      q: 'Can I ask for this in chat instead of clicking around?',
      a: 'Yes. Ask “audit our website and tell me the three things to fix first” or “how did our search clicks change this month?” and the assistant runs it, with the same cost rules as the pages.',
    },
    {
      q: 'Will the audit slow our site down?',
      a: 'It reads about one page a second, follows your robots.txt and identifies itself as NativeIntelligenceBot, so you can allow or block it there.',
    },
    {
      q: 'Can a background run spend our search-data budget?',
      a: 'No. The assistant never starts paid lookups in scheduled or background runs on its own. A schedule that spends shows its estimate and waits for your yes.',
    },
    {
      q: 'How much does it cost?',
      a: 'Start with a 7-day free trial. The pricing page has the details.',
    },
  ],
  related: ['studio', 'docs', 'agents'],
}
