// The sample world a product's components are shown in: a sales team using the product with Acme, Northwind,
// Globex… Values are chosen by field name (an `email` looks like an email, `created_at` like a recent date, a person's
// `name` like a name), so the same rules serve the build (sample props and API responses read from the app's types) and
// the stage in the browser (rows for a database query, from the columns it selects). No Node or browser APIs here.

// ------------------------------------------------------------------------------------------------------------- world
export const PEOPLE = ['Maya Chen', 'Jordan Lee', 'Priya Patel', 'Sam Rivera', 'Alex Kim', 'Taylor Brooks'];
export const JOBS = ['VP Sales', 'Account Executive', 'Head of Operations', 'Sales Engineer', 'CTO', 'Customer Success Lead'];
export const COMPANIES = ['Acme Corp', 'Northwind', 'Globex', 'Initech', 'Umbrella Health', 'Stark Logistics'];
export const DOMAINS = ['acme.com', 'northwind.io', 'globex.com', 'initech.co', 'umbrella.health', 'stark.co'];
export const SENTENCES = [
  'Can we get the revised pricing over by Thursday?',
  'Great call today. Sending the recap and next steps now.',
  'Acme wants to start with 20 seats and expand in Q1.',
  'Let’s loop in their security team before the next call.',
  'Northwind asked for a SOC 2 report before they sign.',
  'Globex prefers annual billing with a 30-day pilot.',
];
export const SUMMARIES = [
  'Maya walked Acme through pricing. They want a 20-seat pilot starting in November and need SSO before rollout.',
  'Northwind is evaluating two vendors. Security review is the blocker; Jordan will send the SOC 2 report today.',
  'Globex liked the live agent demo. Next step is a technical deep dive with their sales ops team on Tuesday.',
  'Weekly pipeline sync: three deals moved to negotiation, Initech slipped to next quarter.',
];
export const TITLES: [RegExp, string[]][] = [
  [/workflow_state|board_column|column|lane/, ['Todo', 'In Progress', 'In Review', 'Done']],
  [/campaign/, ['Q4 enterprise outreach', 'Webinar follow-ups', 'Expansion: Northwind', 'Re-engage closed-lost']],
  [/meeting|capture|call|recording|transcript|event|session/, ['Discovery call — Acme Corp', 'Pricing review with Northwind', 'Weekly pipeline sync', 'Demo for Globex']],
  [/action|task|todo|issue|ticket|item|followup|follow_up/, ['Send the revised pricing deck to Acme', 'Book a technical deep dive with Globex', 'Share the SOC 2 report with Northwind', 'Update the CRM after the Initech demo']],
  [/project/, ['Q4 pipeline', 'Enterprise onboarding', 'API v2 rollout', 'Website relaunch']],
  [/agent|bot|assistant|teammate/, ['Sales assistant', 'Meeting notetaker', 'Follow-up writer', 'Account researcher']],
  [/doc|note|page|brief|article|report|canon/, ['Acme — account plan', 'Discovery call notes', 'Q4 pricing proposal', 'Security review checklist']],
  [/skill|recipe|tool/, ['Write a follow-up email', 'Summarize the call', 'Update the CRM', 'Research the account']],
  [/flow|workflow|sequence|automation|step/, ['New lead → intro email', 'Post-demo follow-up', 'Weekly pipeline digest', 'Renewal reminder']],
  [/label|tag|topic|category/, ['Enterprise', 'Pricing', 'Security', 'Follow-up']],
  [/initiative|milestone|cycle|goal|objective|okr|sprint/, ['Close Q4 enterprise deals', 'Launch self-serve onboarding', 'Cycle 14', 'Cut time-to-first-call']],
  [/package|knowledge|playbook/, ['Competitor battlecard', 'Pricing & discounts', 'Objection handling', 'Product overview']],
  [/claim|fact|decision|memory|insight|learning|finding/, ['Acme is evaluating two vendors before November', 'Northwind needs SOC 2 before signing', 'Deals above $40k need VP approval', 'Globex prefers annual billing']],
  [/integration|provider|connection|connector|app/, ['Slack', 'HubSpot', 'Google Calendar', 'Linear']],
  [/team|workspace|group|channel/, ['Sales', 'Growth', 'Customer Success', 'Leadership']],
  [/eval|test|case|suite|run/, ['Follow-up quality', 'Call summary accuracy', 'CRM field coverage', 'Objection handling']],
  [/email|mail|draft|message|thread|conversation|chat/, ['Re: Pricing for the Acme pilot', 'Next steps after today’s demo', 'SOC 2 report for Northwind', 'Quick question on seats']],
  [/prospect|lead|deal|opportunity|account/, ['Acme Corp — 20-seat pilot', 'Northwind expansion', 'Globex annual plan', 'Initech renewal']],
];
export const ENTITY = /campaign|meeting|capture|call|recording|transcript|event|session|action|task|todo|issue|ticket|followup|project|agent|bot|assistant|teammate|doc|note|page|brief|article|report|canon|skill|recipe|flow|workflow|sequence|automation|label|tag|topic|initiative|milestone|cycle|goal|package|knowledge|playbook|claim|fact|decision|memory|insight|integration|provider|connection|connector|team|workspace|eval|suite|email|message|thread|conversation|chat|comment|reply|notification|prospect|lead|deal|opportunity|contact|person|member|user|owner|assignee|author|speaker|attendee|participant|company|organization|org|account|customer/;
export const PERSONISH = /contact|person|member|user|owner|assignee|author|speaker|attendee|participant|sender|recipient|creator|invitee|rep|host|guest|profile|teammate|people/;
export const COMPANYISH = /company|organization|org\b|customer|account/;

export const pick = <T,>(list: T[], i: number) => list[((i % list.length) + list.length) % list.length]!;
export const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export const singular = (s: string) => s.replace(/ies$/, 'y').replace(/(ss|x|ch|sh)es$/, '$1').replace(/s$/, '');
/** The thing a name is about: the last entity word in the first hint that has one (EventAttendee → attendee). */
export const entityOf = (...hints: (string | undefined)[]) => { for (const h of hints) { const all = h ? [...words(singular(h)).matchAll(new RegExp(ENTITY.source, 'g'))] : []; if (all.length) return all.at(-1)![0]; } return ''; };
export const titleFor = (entity: string, i: number) => { for (const [re, list] of TITLES) if (re.test(entity)) return pick(list, i); return pick(TITLES[2]![1], i); };
export const BASE = Date.parse('2026-10-20T15:00:00Z'), DAY = 86_400_000;
/** The stage's "now": sample dates are around it, so "5 min ago" and "in 2 days" read the same every time. */
export const SAMPLE_NOW = BASE + 30 * 60_000;
export const dateFor = (key: string, i: number) => new Date(BASE + (/due|start|scheduled|expire|next|until|end|deadline|remind|upcoming/.test(key) ? (i + 1) : -(i + 1) * 0.6) * DAY + i * 3_600_000 + (/end|finish|stop/.test(key) ? 2_700_000 : 0)).toISOString();
export const uuid = (i: number, salt = 0) => `9b1c${(4096 + salt * 37 + i).toString(16).padStart(4, '0')}-6a2e-4c1f-9d3b-${(0xa1b2c3d4e5f6 + i * 7919 + salt).toString(16).slice(-12)}`;

export function stringFor(key: string, entity: string, i: number): string | undefined {
  const k = words(key);
  const person = PERSONISH.test(entity) || PERSONISH.test(k), company = COMPANYISH.test(entity) && !person;
  if (/^parent|reply_to|in_reply|thread_parent|cursor|next_page|next_token|continuation|page_token/.test(k)) return undefined;
  if (/^identifier$|_identifier$|^ticket_key$|^issue_key$|^short_id$/.test(k)) return `GEN-${24 + i}`;
  if (/(^|_)(uu)?id$|_ids?$/.test(k) || k === 'key' && !entity) return uuid(i, k.length);
  if (/email|^(to|cc|bcc)$/.test(k)) return `${pick(PEOPLE, i).split(' ')[0]!.toLowerCase()}@${pick(DOMAINS, i)}`;
  if (/^(attendee|participant|recipient|member|assignee|owner|author|speaker|sender|guest|invitee|person|people|organizer|host)s?$/.test(k)) return pick(PEOPLE, i);
  if (/avatar|image|photo|picture|icon|logo|thumbnail|cover|favicon|src$|_src/.test(k)) return undefined;
  if (/url|href|link|website|homepage|uri/.test(k)) return `https://${pick(DOMAINS, i)}`;
  if (/(^|_)(on|day)$|^date$|_date$|birthday/.test(k)) return dateFor(k, i).slice(0, 10);
  if (/(^|_)(at|time|timestamp|since|until)$|_at$|date|deadline|due|starts?_|ends?_|scheduled|expires|last_seen|seen|^(start|end|starts|ends|begin|finish|when)$/.test(k)) return dateFor(k, i);
  if (/first_name|given/.test(k)) return pick(PEOPLE, i).split(' ')[0];
  if (/last_name|family|surname/.test(k)) return pick(PEOPLE, i).split(' ')[1];
  if (/initials/.test(k)) return pick(PEOPLE, i).split(' ').map(w => w[0]).join('');
  if (/user_?name|handle|login|slug/.test(k)) return person ? pick(PEOPLE, i).split(' ')[0]!.toLowerCase() : titleFor(entity, i).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  if (/display_name|full_name|person|contact_name|owner_name|author_name|speaker|user_name|member_name|assignee_name|sender_name|from_name/.test(k)) return pick(PEOPLE, i);
  if (/company|organization|org_name|account_name|customer/.test(k)) return pick(COMPANIES, i);
  if (/job|position|job_title|headline/.test(k) || (k === 'title' && person)) return pick(JOBS, i);
  if (/domain/.test(k)) return pick(DOMAINS, i);
  if (/phone|mobile|tel/.test(k)) return `+1 (415) 555-01${String(30 + i).padStart(2, '0')}`;
  if (/color|colour|hex|tint/.test(k)) return pick(['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9'], i);
  if (/^name$|_name$|^label$/.test(k)) return person || !entity ? pick(PEOPLE, i) : company ? pick(COMPANIES, i) : titleFor(entity, i);
  if (/title|subject|heading|headline|name|caption/.test(k)) return titleFor(entity || k, i);
  if (/summary|overview|abstract|recap|tldr|description|desc$|about|bio|context|rationale|reason|explanation|details?$/.test(k)) return pick(SUMMARIES, i);
  if (/body|content|text|message|note|excerpt|snippet|quote|comment|reply|answer|prompt|question|query|input|value|transcript|utterance|line|draft|markdown|html/.test(k)) return pick(SENTENCES, i);
  if (/status|state/.test(k)) return pick(['active', 'open', 'in_progress', 'done'], i);
  if (/priority|severity|urgency/.test(k)) return pick(['high', 'medium', 'urgent', 'low'], i);
  if (/role/.test(k)) return pick(['admin', 'member', 'member', 'owner'], i);
  if (/stage|phase/.test(k)) return pick(['Discovery', 'Demo', 'Negotiation', 'Closed won'], i);
  if (/kind|type|variant|mode|category|format/.test(k)) return entity || 'default';
  if (/source|channel|medium|origin/.test(k)) return pick(['meeting', 'email', 'slack', 'call'], i);
  if (/provider|platform|service|integration|vendor/.test(k)) return pick(['google', 'slack', 'hubspot', 'linear'], i);
  if (/model/.test(k)) return 'claude';
  if (/currency/.test(k)) return 'USD';
  if (/plan|tier|edition/.test(k)) return pick(['Growth', 'Pro', 'Enterprise'], i);
  if (/direction/.test(k)) return pick(['outbound', 'inbound'], i);
  if (/sentiment|tone|mood/.test(k)) return pick(['positive', 'neutral'], i);
  if (/visibility|scope|access|permission/.test(k)) return 'workspace';
  if (/time_?zone|tz/.test(k)) return 'America/New_York';
  if (/locale|lang/.test(k)) return 'en';
  if (/version/.test(k)) return `2.${4 + i}.0`;
  if (/sha|hash|commit|digest/.test(k)) return `a1b2c3${i}`;
  if (/path|route|pathname/.test(k)) return `/account/${entity || 'home'}`;
  if (/location|address|city|place|venue/.test(k)) return pick(['San Francisco, CA', 'New York, NY', 'Zoom', 'Google Meet'], i);
  if (/unit/.test(k)) return 'seats';
  if (/placeholder|hint|help/.test(k)) return 'Ask anything…';
  if (/emoji/.test(k)) return pick(['🎯', '📞', '📈', '✅'], i);
  if (/code|token|secret|password|key/.test(k)) return undefined;
  return titleFor(entity || k, i);
}
export function numberFor(key: string, i: number) {
  const k = words(key);
  if (/(_at|_at_ms|timestamp|_ts|epoch)$|^(created|updated|started|ended|expires|last_seen|last_active|joined|sent|received)(_|$)/.test(k))
    return Math.round(Date.parse(dateFor(k, i)) / (/_s$|sec|unix/.test(k) ? 1000 : 1));
  if (/percent|pct/.test(k)) return pick([72, 45, 88, 61], i);
  if (/progress|ratio|confidence|probability|score|rate|share|similarity|weight|level|volume|opacity/.test(k)) return pick([0.72, 0.45, 0.88, 0.61], i);
  if (/duration|seconds|secs|elapsed|length_s|time_s|offset/.test(k)) return pick([1260, 840, 1980, 420], i);
  if (/_ms$|ms$|millis/.test(k)) return pick([2400, 1200, 900, 3600], i);
  if (/price|amount|revenue|value|arr|mrr|budget|cost|spend|deal_size|cents/.test(k)) return pick([48000, 24000, 96000, 12000], i);
  if (/year/.test(k)) return 2026;
  if (/month/.test(k)) return 10;
  if (/day/.test(k)) return 20 + i;
  if (/hour/.test(k)) return 9 + i;
  if (/index|position|order|rank|sort|step|page|number|num$|^n$|idx/.test(k)) return i;
  if (/width|height|size|px/.test(k)) return 320;
  if (/count|total|num_|members|attendees|seats|items|limit|max|capacity|unread|new_/.test(k)) return pick([12, 3, 24, 7], i);
  if (/lat/.test(k)) return 37.77 + i * 0.01;
  if (/lng|lon/.test(k)) return -122.42 + i * 0.01;
  return pick([3, 5, 8, 2], i);
}
export function booleanFor(key: string, forProps: boolean, i = 0) {
  const k = words(key);
  if (/more|has_next|next_page|truncated|partial|capped|overflow|limited|rate_limit/.test(k)) return false;
  if (/resolved|done|complete|checked|read$|is_read|seen|dismissed|accepted/.test(k) && !forProps) return i % 2 === 1;
  if (/loading|pending|disabled|error|fail|empty|hidden|collapsed|skeleton|readonly|read_only|submitting|saving|deleting|busy|stale|archived|deleted|minimi[sz]ed|compact|mobile|muted|locked|blocked|dismissed|revoked|expired|offline|is_new|first_run|onboarding/.test(k)) return false;
  if (/open|visible|show|expanded|active|selected|enabled|connected|ready|success|complete|available|checked|on$|live|online|verified|has_|is_?current|is_?primary|confirmed|done|resolved|recording|speaking|playing|focused|hover/.test(k)) return true;
  return forProps ? undefined : false;
}


// --------------------------------------------------------------------------------------------- rows from a select
type Column = { name: string; table?: string; fk?: string; inner?: Column[] };
/** Parse a PostgREST select ("id, title, owner:member!owner_id(id, display_name), labels:item_label(label(id, name))"). */
export function parseSelect(select: string): Column[] {
  const out: Column[] = [], text = select.replace(/\s+/g, ' ').trim();
  let depth = 0, start = 0;
  const push = (part: string) => {
    part = part.trim(); if (!part) return;
    const open = part.indexOf('(');
    const head = (open >= 0 ? part.slice(0, open) : part).replace(/::\w+/g, '').replace(/^\.\.\./, '').trim();
    const [alias, target] = head.includes(':') ? [head.split(':')[0]!.trim(), head.split(':')[1]!.trim()] : [head, head];
    const [table, fk] = target.split('!').map(x => x.trim());
    if (open >= 0) out.push({ name: alias || table!, table, fk: fk?.split('!')[0], inner: parseSelect(part.slice(open + 1, part.lastIndexOf(')'))) });
    else out.push({ name: alias, table });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++; else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { push(text.slice(start, i)); start = i + 1; }
  }
  push(text.slice(start));
  return out;
}
const JSONISH = /^(metadata|settings|config|options|context_data|payload|data|details|send_window|preferences|filters|state_data|extra|raw|properties|meta)$/;
/** A value for a database column, by its name and the table it belongs to. */
export function columnValue(name: string, table: string, i: number): unknown {
  const k = words(name), entity = entityOf(table, name) || singular(table);
  if (k === 'count') return numberFor('count', i);
  if (/(^|_)ids$/.test(k)) return [uuid(i, 7), uuid(i + 1, 7)];
  if (/(^|_)id$/.test(k) || k === 'uuid') return uuid(i, k.length + table.length);
  if (/^(is|has|needs|can|should|auto|all|was)_|_enabled$|_processed$|^(enabled|active|archived|pinned|starred|unread|deleted|verified|confirmation|ai_processed|auto_send|all_day|visible|public|draft)$/.test(k)) return booleanFor(k, false, i) ?? false;
  if (JSONISH.test(k)) return {};
  if (k === 'tags' || /_tags$/.test(k)) return [pick(['Enterprise', 'Pricing', 'Security', 'Expansion'], i), 'Follow-up'];
  if (/participants|attendees|recipients|emails$/.test(k)) return [0, 1].map(j => ({ name: pick(PEOPLE, i + j), email: stringFor('email', 'person', i + j) }));
  if (table.includes('workflow_state') && k === 'category') return pick(['unstarted', 'started', 'started', 'completed'], i);
  if (/(count|number|seconds|duration|estimate|sort_order|position|total|size|strength|score|amount|price|order|rank|index|minutes|hours|cents|step|level|version_number)$|^(number|estimate|priority_rank)$/.test(k)) return numberFor(k, i);
  if (k === 'priority') return pick([1, 2, 0, 3], i);
  return stringFor(k, entity, i) ?? null;
}
const plural = (name: string) => /s$/.test(name) && !/(ss|status|us|is)$/.test(name);
/** Rows for a select: related records repeat (three of each), so boards and groups have real columns. */
export function rowsFromSelect(select: string, table: string, n: number, depth = 0, salt = 0): Record<string, unknown>[] {
  const columns = parseSelect(select);
  const row = (i: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const c of columns) {
      if (c.name === '*' || c.table === '*') { for (const col of ['id', 'name', 'title', 'status', 'created_at', 'updated_at']) out[col] ??= columnValue(col, table, i + salt); continue; }
      if (c.inner) {
        const t = c.table ?? c.name;
        if (depth > 3) { out[c.name] = null; continue; }
        if (plural(c.name)) out[c.name] = rowsFromSelect(c.inner.map(x => x.inner ? `${x.name}:${x.table}(${columnsText(x.inner)})` : x.name).join(', '), t, 2, depth + 1, i);
        else {
          const shared = (i + salt) % 3;
          const one = rowsFromSelect(columnsText(c.inner), t, 1, depth + 1, shared)[0]!;
          if ('id' in one) one.id = uuid(shared, t.length * 11);
          out[c.name] = one;
          if (c.fk) out[c.fk] = one.id ?? uuid(shared, t.length * 11);
        }
        continue;
      }
      if (!(c.name in out)) out[c.name] = columnValue(c.name, table, i + salt);
    }
    return out;
  };
  return Array.from({ length: n }, (_, i) => row(i));
}
const columnsText = (cols: Column[]): string => cols.map(c => c.inner ? `${c.name}:${c.table}${c.fk ? '!' + c.fk : ''}(${columnsText(c.inner)})` : c.name).join(', ');
