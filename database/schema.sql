-- 回答节点碰撞试用站：CloudBase PostgreSQL 初始化脚本（可重复执行）
create table if not exists public.app_users (
  id text primary key,
  name text not null,
  avatar text not null default '',
  provider text not null default 'zhihu',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_sessions (
  token_hash text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists app_sessions_expires_idx on public.app_sessions(expires_at);

-- 每个知乎用户每天最多发起 10 次碰撞。slot 的联合主键既记录失败尝试，
-- 也能在多实例并发时从数据库层保证同一自然日不会超过 10 次。
create table if not exists public.daily_collision_attempts (
  user_id text not null references public.app_users(id) on delete cascade,
  usage_date date not null,
  slot smallint not null check (slot between 1 and 10),
  created_at timestamptz not null default now(),
  primary key (user_id, usage_date, slot)
);
create index if not exists daily_collision_attempts_date_idx on public.daily_collision_attempts(usage_date);

create table if not exists public.oauth_states (
  state_hash text primary key,
  browser_nonce_hash text not null,
  return_to text not null default '/',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists oauth_states_expires_idx on public.oauth_states(expires_at);

create table if not exists public.private_datasets (
  id text primary key,
  payload jsonb not null,
  content_hash text not null,
  imported_at timestamptz not null default now()
);

create table if not exists public.answer_maps (
  answer_id text primary key,
  question_id text not null,
  payload jsonb not null,
  source_hash text not null,
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists answer_maps_question_idx on public.answer_maps(question_id);

create table if not exists public.collision_cache (
  cache_key text primary key,
  question_id text not null,
  answer_ids jsonb not null,
  node_ids jsonb not null,
  result jsonb not null,
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.discoveries (
  id text primary key,
  pair_key text not null unique,
  question_id text not null,
  creator_id text not null references public.app_users(id),
  author text not null,
  payload jsonb not null,
  status text not null default 'published' check (status in ('published','withdrawn','hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists discoveries_question_idx on public.discoveries(question_id, created_at desc);

create table if not exists public.discovery_comments (
  id text primary key,
  discovery_id text not null references public.discoveries(id) on delete cascade,
  user_id text not null references public.app_users(id),
  author text not null,
  text text not null check (char_length(text) between 1 and 500),
  status text not null default 'visible' check (status in ('visible','withdrawn','hidden')),
  created_at timestamptz not null default now()
);
create index if not exists discovery_comments_item_idx on public.discovery_comments(discovery_id, created_at);

create table if not exists public.answer_actions (
  answer_id text not null,
  question_id text not null,
  user_id text not null references public.app_users(id),
  action text not null check (action in ('upvote','like','favorite')),
  created_at timestamptz not null default now(),
  primary key (answer_id, user_id, action)
);

create table if not exists public.answer_map_events (
  id text primary key,
  answer_id text not null,
  question_id text not null,
  user_id text not null references public.app_users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.answer_comments (
  id text primary key,
  answer_id text not null,
  question_id text not null,
  user_id text not null references public.app_users(id),
  author text not null,
  avatar text not null default '',
  text text not null check (char_length(text) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists answer_comments_answer_idx on public.answer_comments(answer_id, created_at);

-- 数据库仅由云托管后端访问。不要给 anon/authenticated 直接授权。
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
