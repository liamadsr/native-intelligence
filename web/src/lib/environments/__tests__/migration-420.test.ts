/**
 * Migration 420 (docs/plans/environments.md §4, phase E1): what Postgres
 * enforces and vitest can't run. It pins the tables' CHECKs, the SELECT-only
 * row security and the column grant that keeps env_vars and setup_script from
 * every client, each reference trigger's rule, the backfill and its order
 * (the triggers come after it), and the merge's environments step, with
 * merge_workspace and its preflight otherwise 402's text exactly.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASE_BRANCH_FORBIDDEN_RE,
  BASE_BRANCH_RE,
  DEFAULT_CLOUD_NAME,
  ENV_TEXT_MAX_BYTES,
  MAC_ENVIRONMENT_FALLBACK_NAME,
  NO_ENVIRONMENT_NETWORK_ACCESS,
} from '../types'

const read = (f: string) => readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
const SQL = read('420_environments.sql')
const M402 = read('402_merge_workspaces.sql')
/** The file without comments, one space for every run of whitespace. */
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')

/** From `start` to the first `end` after it. */
function slice(text: string, start: string, end: string): string {
  const at = text.indexOf(start)
  if (at < 0) throw new Error(`not found: ${start}`)
  const to = text.indexOf(end, at + start.length)
  if (to < 0) throw new Error(`no end after: ${start}`)
  return text.slice(at, to + end.length)
}
/** A function's text, from its create to its closing `$$;`. */
const fn = (text: string, name: string) => slice(text, `create or replace function public.${name}(`, '$$;')
const FN = (text: string, name: string) => slice(text, `CREATE OR REPLACE FUNCTION public.${name}(`, '$$;')
const squash = (s: string) => s.replace(/\s+/g, ' ')
const ENV_TABLE = slice(BODY, 'create table if not exists public.environment (', ' );')

describe('migration 420: the shape', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('says it goes to DEV, then PROD, before the code that reads it (deployed right after), and is additive', () => {
    expect(SQL).toContain('Apply to DEV, then PROD, BEFORE the code that reads it, and deploy right')
    expect(squash(SQL.replace(/\n--/g, ' '))).toContain('an edit made on the old Settings page between applying this and deploying is not carried over')
    expect(BODY).not.toMatch(/\bdrop (table|column)\b/i)
    // The only deletes: a moved project's personal defaults, the merge's
    // colliding personal defaults, and 402's own delete of the merged-away
    // workspace (in its copied text). Nothing a person made is deleted.
    expect([...BODY.matchAll(/\bdelete from public\.\w+/gi)].map((m) => m[0])).toEqual([
      'delete from public.environment_default',
      'delete from public.environment_default',
      'DELETE FROM public.workspace',
    ])
    expect(BODY).toContain('delete from public.environment_default d where d.project_id = new.id and d.workspace_id is distinct from new.workspace_id;')
    expect(BODY).toContain('delete from public.environment_default s where s.workspace_id = p_source and exists (')
  })

  it('environment: the two kinds, each with exactly its own columns', () => {
    expect(ENV_TABLE).toContain("kind text not null check (kind in ('mac', 'cloud'))")
    expect(ENV_TABLE).toContain('name text not null check (char_length(name) between 1 and 80)')
    expect(ENV_TABLE).toContain("network_access text check (network_access in ('trusted', 'restricted', 'isolated'))")
    expect(ENV_TABLE).toContain(
      "check ( (kind = 'mac' and owner_user_id is not null and device_id is not null and workspace_id is null and shared is null and network_access is null and env_vars is null and setup_script is null) or (kind = 'cloud' and owner_user_id is null and device_id is null and workspace_id is not null and shared is not null and network_access is not null) )",
    )
    expect(ENV_TABLE).toContain('owner_user_id uuid references auth.users (id) on delete cascade')
    expect(ENV_TABLE).toContain('workspace_id uuid references public.workspace (id) on delete cascade')
    expect(ENV_TABLE).toContain('created_by uuid references auth.users (id) on delete set null')
    // 64 KB each (ENV_TEXT_MAX_BYTES), checked in bytes.
    expect(ENV_TABLE).toContain('env_vars text check (octet_length(env_vars) <= 65536)')
    expect(ENV_TABLE).toContain('setup_script text check (octet_length(setup_script) <= 65536)')
    expect(ENV_TEXT_MAX_BYTES).toBe(65536)
  })

  it('one environment per Mac, removed with its device', () => {
    expect(ENV_TABLE).toContain('constraint environment_device_fk foreign key (owner_user_id, device_id) references public.user_device (user_id, id) on delete cascade')
    expect(ENV_TABLE).toContain('constraint environment_one_per_mac unique (owner_user_id, device_id)')
    expect(BODY).toContain("create index if not exists environment_workspace on public.environment (workspace_id) where kind = 'cloud';")
  })

  it('device_folder_setting: keyed by the folder, with the branch and repo patterns', () => {
    const t = squash(slice(SQL, 'create table if not exists public.device_folder_setting (', '\n);'))
    expect(t).toContain('device_folder_id uuid primary key references public.device_folder (id) on delete cascade')
    expect(t).toContain("base_branch text check (base_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$' and base_branch !~ '(^HEAD$|^refs/|[.][.]|//|@[{]|[.]lock$|/$|[.]$)')")
    expect(t).toContain("repo_full_name text check (repo_full_name ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$')")
  })

  it('environment_default: one per (person, workspace, project), with a primary key the merge export pages by', () => {
    const t = squash(slice(SQL, 'create table if not exists public.environment_default (', '\n);'))
    expect(t).toContain('id uuid primary key default gen_random_uuid()')
    expect(t).toContain('environment_id uuid not null references public.environment (id) on delete cascade')
    expect(t).toContain('project_id uuid references public.projects (id) on delete cascade')
    expect(BODY).toContain("create unique index if not exists environment_default_one on public.environment_default (user_id, workspace_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid));")
  })

  it('the five references: named foreign keys, each indexed; set null when the environment goes, except a run’s', () => {
    for (const [table, column, action] of [
      ['workspace', 'default_cloud_environment_id', 'set null'],
      ['projects', 'environment_id', 'set null'],
      ['chat_conversations', 'environment_id', 'set null'],
      // A run's environment can't vanish under it (a workspace delete takes its runs in the same statement).
      ['agent_run', 'environment_id', 'no action'],
      ['local_agent_session', 'environment_id', 'set null'],
    ]) {
      expect(BODY).toContain(
        `alter table public.${table} add column if not exists ${column} uuid constraint ${table}_${column}_fkey references public.environment (id) on delete ${action};`,
      )
      expect(BODY).toMatch(new RegExp(`create index if not exists \\w+ on public\\.${table} \\(${column}\\) where ${column} is not null;`))
    }
  })

  it('"Remove this Mac" is a column, not a delete', () => {
    expect(BODY).toContain('alter table public.user_device add column if not exists removed_at timestamptz;')
  })

  it('a Mac’s capabilities (E2): a short list its heartbeat writes, empty by default', () => {
    expect(BODY).toContain(
      "alter table public.user_device add column if not exists capabilities text[] not null default '{}' constraint user_device_capabilities_check check (cardinality(capabilities) <= 16);",
    )
  })

  it('an edit job’s base branch (E3): device_folder_setting’s pattern, on an edit job only', () => {
    const setting = /base_branch text check \((base_branch ~ '[^']+' and base_branch !~ '[^']+')\)/.exec(BODY)![1]
    expect(BODY).toContain(
      `alter table public.local_agent_session add column if not exists base_branch text constraint local_agent_session_base_branch_check check ( base_branch is null or ( mode = 'edit' and ${setting} ) );`,
    )
    // The server's pattern is the same (types.ts BASE_BRANCH_RE / BASE_BRANCH_FORBIDDEN_RE).
    expect(setting).toBe("base_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$' and base_branch !~ '(^HEAD$|^refs/|[.][.]|//|@[{]|[.]lock$|/$|[.]$)'")
    expect(BASE_BRANCH_RE.source).toBe('^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$')
    expect(BASE_BRANCH_FORBIDDEN_RE.source).toBe('(^HEAD$|^refs\\/|[.][.]|\\/\\/|@[{]|[.]lock$|\\/$|[.]$)')
  })

  it('updated_at on the three new tables, with the repo’s function', () => {
    for (const t of ['environment', 'device_folder_setting', 'environment_default']) {
      expect(BODY).toContain(`create trigger ${t}_updated_at before update on public.${t} for each row execute function public.update_updated_at();`)
    }
  })
})

describe('migration 420: who reads what', () => {
  it('row security on every new table, with SELECT policies only (writes go through the service role)', () => {
    for (const t of ['environment', 'device_folder_setting', 'environment_default']) {
      expect(BODY).toContain(`alter table public.${t} enable row level security;`)
    }
    const policies = [...BODY.matchAll(/create policy (\w+) on public\.(\w+) for (\w+) to (\w+)/g)].map((m) => [m[1], m[2], m[3], m[4]])
    expect(policies).toEqual([
      ['environment_mac_owner_select', 'environment', 'select', 'authenticated'],
      ['environment_cloud_select', 'environment', 'select', 'authenticated'],
      ['device_folder_setting_owner_select', 'device_folder_setting', 'select', 'authenticated'],
      ['environment_default_own_select', 'environment_default', 'select', 'authenticated'],
    ])
    expect(BODY.match(/create policy/g)).toHaveLength(4)
  })

  it('a Mac and its folder settings: the owner only; a cloud one: members when shared, its creator, admins always', () => {
    expect(BODY).toContain("using (kind = 'mac' and owner_user_id = (select auth.uid()));")
    expect(BODY).toContain(
      "using ( kind = 'cloud' and ( public.get_member_role(workspace_id) in ('owner', 'admin') or (public.is_workspace_member(workspace_id) and (shared or created_by = (select auth.uid()))) ) );",
    )
    expect(BODY).toContain('using (exists ( select 1 from public.device_folder f where f.id = device_folder_id and f.user_id = (select auth.uid()) ));')
    expect(BODY).toContain('using ((select auth.uid()) = user_id);')
  })

  it('env_vars and setup_script: the table grant revoked first, SELECT back on every other column', () => {
    const revokeAll = BODY.indexOf('revoke all on public.environment from anon, authenticated;')
    const grant = BODY.indexOf('grant select (')
    const revokeCols = BODY.indexOf('revoke select (env_vars, setup_script) on public.environment from anon, authenticated;')
    expect(revokeAll).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(revokeAll)
    expect(revokeCols).toBeGreaterThan(grant)
    const granted = /grant select \(([^)]+)\) on public\.environment to authenticated;/.exec(BODY)![1].split(',').map((c) => c.trim())
    const columns = [...ENV_TABLE.matchAll(/[(,] (\w+) (?:uuid|text|boolean|timestamptz)(?=[ ,])/g)].map((m) => m[1])
    expect(columns).toHaveLength(14)
    expect(columns).toContain('env_vars')
    expect(granted.sort()).toEqual(columns.filter((c) => c !== 'env_vars' && c !== 'setup_script').sort())
    // Nothing grants a client a write, and the other two tables lose theirs (defence in depth).
    expect(BODY).not.toMatch(/grant (insert|update|delete|all)\b[^;]* to (anon|authenticated)/i)
    expect(BODY).toContain('revoke insert, update, delete on public.device_folder_setting from anon, authenticated;')
    expect(BODY).toContain('revoke insert, update, delete on public.environment_default from anon, authenticated;')
  })
})

describe('migration 420: what a reference may point at', () => {
  it('a project, and a workspace default: a shared, live cloud environment of that same workspace', () => {
    const shared = squash(fn(SQL, '_environment_shared_in'))
    expect(shared).toContain("e.kind = 'cloud' and e.shared and e.archived_at is null and e.workspace_id = p_workspace")
    const project = squash(fn(SQL, 'environment_check_project_ref'))
    expect(project).toContain('if public._environment_shared_in(new.environment_id, new.workspace_id) then return new;')
    expect(project).toContain("using errcode = '42501'")
    const ws = squash(fn(SQL, 'environment_check_workspace_default'))
    expect(ws).toContain('if public._environment_shared_in(new.default_cloud_environment_id, new.id) then return new;')
    expect(BODY).toContain('create trigger projects_environment_check before insert or update of environment_id, workspace_id on public.projects')
    expect(BODY).toContain('create trigger workspace_default_cloud_environment_check before insert or update of default_cloud_environment_id on public.workspace')
  })

  it('a chat: its owner’s own Mac, or a cloud one of its workspace they can see; a person default the same, Mac only with a project', () => {
    const usable = squash(fn(SQL, '_environment_usable'))
    expect(usable).toContain("(e.kind = 'mac' and e.owner_user_id = p_user)")
    expect(usable).toContain("not p_mac_only and e.kind = 'cloud' and e.workspace_id = p_workspace and (e.shared or e.created_by = p_user) and exists (select 1 from public.member m where m.workspace_id = p_workspace and m.user_id = p_user)")
    expect(usable).toContain('e.archived_at is null')
    expect(squash(fn(SQL, 'environment_check_chat_ref'))).toContain('public._environment_usable(new.environment_id, new.user_id, new.workspace_id, false)')
    const def = squash(fn(SQL, 'environment_check_default_ref'))
    expect(def).toContain('public._environment_usable(new.environment_id, new.user_id, new.workspace_id, new.project_id is not null)')
    expect(def).toContain('select 1 from public.projects p where p.id = new.project_id and p.workspace_id = new.workspace_id')
    expect(BODY).toContain('create trigger chat_conversations_environment_check before insert or update of environment_id, workspace_id, user_id on public.chat_conversations')
    expect(BODY).toContain('create trigger environment_default_check before insert or update on public.environment_default')
  })

  it('a run: a live cloud environment of its own workspace (a member may insert any run)', () => {
    const run = squash(fn(SQL, 'environment_check_run_ref'))
    expect(run).toContain("e.id = new.environment_id and e.kind = 'cloud' and e.archived_at is null and e.workspace_id = new.workspace_id")
    expect(BODY).toContain('create trigger agent_run_environment_check before insert or update of environment_id on public.agent_run')
  })

  it('a project that moves workspace leaves its personal defaults behind (move_project), a merge aside', () => {
    const moved = squash(fn(SQL, 'environment_drop_moved_project_defaults'))
    expect(moved).toContain('if public._wsmerge_active() or new.workspace_id is not distinct from old.workspace_id then return null;')
    expect(BODY).toContain('create trigger projects_environment_defaults_moved after update of workspace_id on public.projects')
  })

  it('every check steps aside inside a merge, lets null through, and refuses a new bad reference with 42501', () => {
    for (const name of ['environment_check_project_ref', 'environment_check_workspace_default', 'environment_check_chat_ref', 'environment_check_default_ref', 'environment_check_run_ref', 'environment_guard_identity']) {
      const body = squash(fn(SQL, name))
      expect(body, name).toContain('public._wsmerge_active()')
      expect(body, name).toContain('security definer set search_path = public, pg_temp')
      expect(body, name).toContain("errcode = '42501'")
    }
  })

  it('a project or chat that changes workspace with its reference unchanged drops it (move_project), a changed one is refused', () => {
    for (const name of ['environment_check_project_ref', 'environment_check_chat_ref']) {
      const body = squash(fn(SQL, name))
      const sever = body.indexOf("if tg_op = 'UPDATE' and new.environment_id is not distinct from old.environment_id then new.environment_id := null; return new; end if;")
      expect(sever, name).toBeGreaterThan(-1)
      expect(body.indexOf('raise exception'), name).toBeGreaterThan(sever)
    }
  })

  it('an environment’s kind, owner, Mac and workspace are fixed, and one a project or the default uses stays shared and live', () => {
    const guard = squash(fn(SQL, 'environment_guard_identity'))
    expect(guard).toContain('new.kind is distinct from old.kind or new.owner_user_id is distinct from old.owner_user_id or new.device_id is distinct from old.device_id or new.workspace_id is distinct from old.workspace_id')
    const used = '( exists (select 1 from public.projects p where p.environment_id = old.id) or exists (select 1 from public.workspace w where w.default_cloud_environment_id = old.id) )'
    expect(guard).toContain(`old.shared and not new.shared and ${used}`)
    expect(guard).toContain(`old.archived_at is null and new.archived_at is not null and ${used}`)
    expect(BODY).toContain('create trigger environment_guard before update of kind, owner_user_id, device_id, workspace_id, shared, archived_at on public.environment')
  })

  it('no client may call the helpers or the trigger functions', () => {
    for (const sig of [
      '_environment_usable(uuid, uuid, uuid, boolean)',
      '_environment_shared_in(uuid, uuid)',
      'environment_check_project_ref()',
      'environment_check_workspace_default()',
      'environment_check_chat_ref()',
      'environment_check_default_ref()',
      'environment_guard_identity()',
      'environment_check_run_ref()',
      'environment_drop_moved_project_defaults()',
      '_wsmerge_environments(uuid, uuid)',
    ]) {
      expect(BODY).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`)
    }
  })
})

describe('migration 420: the backfill', () => {
  const at = (s: string) => {
    const i = BODY.indexOf(s)
    if (i < 0) throw new Error(`not in the migration: ${s}`)
    return i
  }

  it('in order: Macs, cloud environments, projects, Default cloud; the reference triggers only after', () => {
    const steps = [
      at("insert into public.environment (kind, name, owner_user_id, device_id, created_at, updated_at) select 'mac'"),
      at('from public.cloud_environment c on conflict (id) do nothing;'),
      at('alter table public.projects disable trigger project_updated_at;'),
      at('update public.projects p set environment_id = p.cloud_env_id'),
      at('with made as ('),
      at('alter table public.projects enable trigger project_updated_at;'),
      at('create trigger projects_environment_check'),
    ]
    expect(steps.every((s, i) => i === 0 || s > steps[i - 1])).toBe(true)
    const lastBackfill = at('alter table public.workspace enable trigger workspace_updated_at;')
    for (const trigger of ['projects_environment_check', 'workspace_default_cloud_environment_check', 'chat_conversations_environment_check', 'environment_default_check', 'environment_guard', 'agent_run_environment_check', 'projects_environment_defaults_moved']) {
      expect(at(`create trigger ${trigger}`), trigger).toBeGreaterThan(lastBackfill)
    }
  })

  it('a Mac environment per Mac, named after it, re-runnable', () => {
    expect(BODY).toContain(
      `select 'mac', left(coalesce(nullif(btrim(d.name, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13)), ''), '${MAC_ENVIRONMENT_FALLBACK_NAME}'), 80), d.user_id, d.id, d.created_at, d.created_at from public.user_device d on conflict (owner_user_id, device_id) do nothing;`,
    )
  })

  it('a cloud environment per cloud_environment: same id, shared, creator kept, null network read as trusted', () => {
    expect(BODY).toContain(
      "select c.id, 'cloud', left(coalesce(nullif(btrim(c.name), ''), 'Cloud environment'), 80), c.workspace_id, c.created_by, true, coalesce(c.network_access, 'trusted'), c.env_vars, c.setup_script, c.created_at, c.updated_at from public.cloud_environment c",
    )
  })

  it('a project keeps its environment only where it is its own workspace’s and live, and only into an empty one', () => {
    expect(BODY).toContain(
      "update public.projects p set environment_id = p.cloud_env_id from public.environment e where e.id = p.cloud_env_id and e.kind = 'cloud' and e.workspace_id = p.workspace_id and e.archived_at is null and p.environment_id is null;",
    )
  })

  it('"Default cloud" (trusted) where a project has a repo and no environment, or there is any flow, as the workspace default', () => {
    const made = slice(BODY, 'with made as (', 'where w.id = made.workspace_id;')
    expect(made).toContain(`select 'cloud', '${DEFAULT_CLOUD_NAME}', w.id, null, true, '${NO_ENVIRONMENT_NETWORK_ACCESS}' from public.workspace w where w.default_cloud_environment_id is null`)
    expect(made).toContain("p.workspace_id = w.id and p.environment_id is null and nullif(btrim(p.github_repo), '') is not null")
    expect(made).toContain('or exists (select 1 from public.flow f where f.workspace_id = w.id)')
    expect(made).toContain('update public.workspace w set default_cloud_environment_id = made.id from made where w.id = made.workspace_id;')
  })

  it('run twice, "Default cloud" is never made again: a workspace with any cloud environment not copied from cloud_environment is skipped', () => {
    const made = slice(BODY, 'with made as (', 'where w.id = made.workspace_id;')
    expect(made).toContain(
      "and not exists ( select 1 from public.environment e where e.workspace_id = w.id and e.kind = 'cloud' and not exists (select 1 from public.cloud_environment c where c.id = e.id) )",
    )
  })

  it('pauses and restores exactly the two updated_at triggers it would otherwise fire', () => {
    expect(BODY.match(/disable trigger/g)).toHaveLength(2)
    expect(BODY.match(/enable trigger/g)).toHaveLength(2)
    expect(BODY).toContain('alter table public.workspace disable trigger workspace_updated_at;')
  })
})

describe('migration 420: the workspace merge', () => {
  const merge420 = FN(SQL, 'merge_workspace')
  const merge402 = FN(M402, 'merge_workspace')
  const step = '  v_counts := v_counts || public._wsmerge_environments(p_source, p_destination);\n'

  it('merge_workspace is 402’s text with the environments step before the default projects fold, and nothing else', () => {
    expect(merge420).toContain(step + '  v_counts := v_counts || public._wsmerge_default_projects(p_source, p_destination);')
    expect(merge420.replace(step, '')).toBe(merge402)
    // The newest definition of merge_workspace in the repo is this one (402's test follows it).
    expect(SQL.indexOf('CREATE OR REPLACE FUNCTION public.merge_workspace(')).toBeGreaterThan(SQL.indexOf('create or replace function public._wsmerge_environments('))
  })

  it('the preflight is 402’s text counting environment, saying what happens to the default, and the dropped defaults', () => {
    const pre420 = FN(SQL, 'merge_workspace_preflight')
    const pre402 = FN(M402, 'merge_workspace_preflight')
    expect(pre420).not.toContain('cloud_environment e')
    expect(squash(pre420)).toContain("'default_cloud_environment', jsonb_build_object( 'outcome', CASE WHEN v_src.default_cloud_environment_id IS NULL THEN 'none' WHEN v_dst.default_cloud_environment_id IS NULL THEN 'source_adopted' ELSE 'destination_keeps' END,")
    expect(pre420).toContain("'environment_default', (SELECT count(*) FROM public.environment_default s WHERE s.workspace_id = p_source")
    // Everything else is 402's, line for line.
    const lines420 = pre420.split('\n')
    const lines402 = pre402.split('\n')
    const added = lines420.filter((l) => !lines402.includes(l))
    const removed = lines402.filter((l) => !lines420.includes(l))
    expect(removed.map((l) => l.trim())).toEqual([
      "'cloud_environments', (SELECT count(*) FROM public.cloud_environment e WHERE e.workspace_id = p_source),",
      'AND d.user_id = s.user_id AND d.entity_type = s.entity_type AND d.entity_id = s.entity_id))));',
    ])
    expect(added).toHaveLength(15)
    // Every cloud environment the merge moves, archived ones too (it moves them all).
    expect(pre420).toContain("'cloud_environments', (SELECT count(*) FROM public.environment e WHERE e.workspace_id = p_source AND e.kind = 'cloud'),")
    expect(squash(pre420)).toContain(`'source_loops', (SELECT count(*) FROM public.flow f WHERE f.workspace_id = p_source AND f.actions @> '[{"type": "run_agent"}]'::jsonb)`)
    expect(squash(pre420)).toContain("'projects_pinned', CASE WHEN v_src.default_cloud_environment_id IS NULL THEN 0")
  })

  it('the step: moves the cloud environments, keeps the destination’s default, drops colliding personal defaults before moving the rest', () => {
    const body = squash(fn(SQL, '_wsmerge_environments'))
    const pin = body.indexOf('update public.projects p set environment_id = s.default_cloud_environment_id, cloud_env_id = null from public.workspace s where s.id = p_source and p.workspace_id = p_source and p.environment_id is null and s.default_cloud_environment_id is not null;')
    expect(pin).toBeGreaterThan(-1)
    const rename = body.indexOf("set name = left(s.name || ' (' || coalesce(v_src_name, 'merged') || ')', 80)")
    expect(rename).toBeGreaterThan(pin)
    const move = body.indexOf('update public.environment set workspace_id = p_dest where workspace_id = p_source;')
    const adopt = body.indexOf('d.default_cloud_environment_id is null and s.default_cloud_environment_id is not null;')
    const drop = body.indexOf('delete from public.environment_default s where s.workspace_id = p_source')
    const restamp = body.indexOf('update public.environment_default s set workspace_id = p_dest')
    expect([rename, move, adopt, drop, restamp].every((x, i, all) => x > -1 && (i === 0 || x > all[i - 1]))).toBe(true)
    // The collision key is the unique index's, after the default projects fold.
    expect(body).toContain('d.project_id is not distinct from coalesce( (select m.dst from pg_temp._wsmerge_projects m where m.src = s.project_id), s.project_id)')
    expect(body).toContain("'environment_defaults_dropped', v_dropped")
  })
})
