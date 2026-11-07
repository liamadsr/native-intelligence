import type { SkillEvalCase } from '../types'

/**
 * The Browser core (rewritten in 327, the cloud browser in 425): the last
 * rung of the ladder, a bounded goal, never for Dial8's own data.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'in my browser, find the three cheapest nonstop flights from JFK to LAX on Oct 10 with times and prices',
    loads: ['browser-playbook'],
    tools: ['run_browser_task'],
    avoid: ['get_browser_text'],
  },
  {
    request: 'log into our Stripe dashboard in the browser and pull last month’s MRR',
    loads: ['browser-playbook'],
    tools: ['run_browser_task'],
    why: 'Behind the person’s login, which no tool reaches; the person signs in themselves if the page asks.',
  },
  {
    request: "what's overdue on my plate?",
    loads: [],
    tools: ['list_actions'],
    avoid: ['run_browser_task', 'open_browser'],
    why: "Dial8's own data: never the browser.",
  },
  {
    request: 'open the Atlas spec doc in the browser and summarize it',
    loads: [],
    tools: ['search_tools', 'list_documents', 'get_document'],
    avoid: ['run_browser_task'],
    why: 'A Dial8 document is read with its tools, not by URL.',
  },
  {
    request: 'what does the page I have open in the browser say about pricing?',
    loads: ['browser-playbook'],
    tools: ['get_browser_text'],
    params: { get_browser_text: { max_chars: 3000 } },
    avoid: ['run_browser_task'],
    why: 'What is already open is read first, cheapest.',
  },
  {
    request: 'search the web for the latest Next.js release notes',
    loads: [],
    tools: ['web_search'],
    avoid: ['run_browser_task'],
    why: 'Public information: web search before the browser.',
  },
  {
    request: 'the Gmail connector is broken, just read my inbox through the browser instead',
    loads: [],
    tools: [],
    avoid: ['run_browser_task'],
    why: 'A broken connector: say so and ask, never work around it in the browser.',
  },
  {
    request: 'in the browser, submit my expense report on Expensify',
    loads: ['browser-playbook'],
    tools: [],
    avoid: ['run_browser_task'],
    why: 'Submits: ask in chat first.',
  },
]
