create table if not exists users (
  tg_id          bigint primary key,
  username       text,
  first_name     text,
  last_name      text,
  language_code  text,
  is_premium     boolean not null default false,
  start_param    text,
  sub_status     text,
  sub_checked_at timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

create table if not exists subscription_log (
  id         bigserial primary key,
  tg_id      bigint  not null references users(tg_id) on delete cascade,
  channel    text    not null,
  status     text    not null,
  subscribed boolean not null,
  source     text    not null,
  created_at timestamptz not null default now()
);
create index if not exists subscription_log_tg_idx on subscription_log (tg_id, created_at desc);

create table if not exists tickets (
  id            bigserial primary key,
  tg_id         bigint not null references users(tg_id) on delete cascade,
  source        text   not null,
  topic         text,
  context       text,
  message       text   not null,
  status        text   not null default 'new',
  admin_chat_id bigint,
  admin_msg_id  bigint,
  answer        text,
  answered_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists tickets_status_idx on tickets (status, created_at desc);
create index if not exists tickets_admin_msg_idx on tickets (admin_chat_id, admin_msg_id);

create table if not exists events (
  id         bigserial primary key,
  tg_id      bigint references users(tg_id) on delete cascade,
  type       text  not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_type_idx on events (type, created_at desc);
create index if not exists events_tg_idx on events (tg_id, created_at desc);
