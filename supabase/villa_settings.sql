-- Operational settings for the villa business: one row per brand.
--
-- These were compile-time constants in src/lib/voice/queue.ts, which meant
-- changing the calling window required a developer and a deploy. They are
-- operational decisions, not engineering ones, so they live here.
--
-- Additive only: this creates a new table and touches nothing that exists.

create table if not exists villa_settings (
  brand_id              text primary key,

  -- Nobody is called outside these hours, in the zone below. This is the
  -- difference between a sales call and a nuisance call.
  calling_start_hour    smallint     not null default 9,
  calling_end_hour      smallint     not null default 20,
  calling_time_zone     text         not null default 'Asia/Kolkata',

  -- Brands share one outbound number, so this is a global ceiling, not a
  -- per-brand allowance. Above a handful, callers hear a busy tone and the
  -- provider bills for it anyway.
  max_concurrent_calls  smallint     not null default 1,

  -- A no-answer gets one more try, later. A refusal gets none.
  max_attempts          smallint     not null default 2,
  retry_backoff_minutes smallint     not null default 60,

  -- A dial that never reported back; past this the entry is unstuck.
  call_timeout_minutes  smallint     not null default 15,

  updated_at            timestamptz  not null default now(),
  updated_by            text,

  -- Enforced here as well as in the application: a settings row is reachable
  -- by anything holding the service key, and an end hour before the start
  -- hour would silently stop the queue dialling at all.
  constraint villa_settings_hours_ordered  check (calling_start_hour < calling_end_hour),
  constraint villa_settings_hours_in_day   check (calling_start_hour >= 0 and calling_end_hour <= 24),
  constraint villa_settings_concurrency    check (max_concurrent_calls between 1 and 10),
  constraint villa_settings_attempts       check (max_attempts between 1 and 5),
  constraint villa_settings_backoff        check (retry_backoff_minutes between 5 and 1440),
  constraint villa_settings_timeout        check (call_timeout_minutes between 2 and 120)
);

-- Read and written only by the server, which uses the service role. No anon
-- access: these rows decide when real phones ring.
alter table villa_settings enable row level security;
alter table villa_settings force row level security;

-- Today's behaviour, written down, so nothing changes until someone edits it.
insert into villa_settings (brand_id) values ('brd_mtiajnoil4a2')
on conflict (brand_id) do nothing;
