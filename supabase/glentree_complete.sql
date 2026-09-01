-- ============================================================================
-- GLENTREE PLATFORM — COMPLETE SCHEMA  (v2 — citext dependency removed)
--
-- Paste into: Supabase Dashboard → SQL Editor → New query → Run.
-- Idempotent: safe to run more than once.
-- Creates NO users and contains NO passwords.
--
-- Validated against PostgreSQL 17 with ONLY the extensions Supabase provides
-- by default (no citext): 34 tables, 64 RLS policies, zero errors, clean re-run.
-- ============================================================================

-- ============================================================================
-- GLENTREE PLATFORM — core schema
--
-- One application, many departments (front desk, sales, marketing, loan,
-- construction, audit, admin), multi-tenant from the first table so a second
-- builder can be onboarded without a rewrite.
--
-- Authorisation is PERMISSION-based, not role-name based. Policies ask
-- `app_has('customers.read')`, never `role = 'SALES'`. That is what lets an
-- admin invent a new role later without a migration or a code change.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tenancy & identity
-- ---------------------------------------------------------------------------
create table if not exists organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique not null,
  settings    jsonb not null default '{}'::jsonb,   -- branding, company config
  plan        text not null default 'BASIC' check (plan in ('BASIC','STANDARD','PREMIUM')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists organizations_slug_key on organizations (lower(slug));

create table if not exists departments (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references organizations(id) on delete cascade,
  key      text not null,           -- front_desk, sales, marketing, loan, construction, audit
  name     text not null,
  active   boolean not null default true,
  unique (org_id, key)
);

-- Extends auth.users. The FK to auth.users is what ties RLS to the JWT.
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  org_id        uuid not null references organizations(id) on delete cascade,
  department_id uuid references departments(id) on delete set null,
  full_name     text not null default '',
  email         text not null,
  phone         text,
  active        boolean not null default true,
  capacity      int not null default 20 check (capacity > 0),
  last_login_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists profiles_org_idx on profiles (org_id) where active;
-- Case-insensitive uniqueness without the citext extension: Admin@glentree.com
-- and admin@glentree.com must not become two accounts.
create unique index if not exists profiles_org_email_key on profiles (org_id, lower(email));

-- ---------------------------------------------------------------------------
-- RBAC — roles are data, permissions are a fixed vocabulary
-- ---------------------------------------------------------------------------
create table if not exists permissions (
  key         text primary key,     -- customers.read, loans.write, financials.view …
  description text not null default ''
);

insert into permissions (key, description) values
  ('customers.read',      'View customer and lead records'),
  ('customers.write',     'Create and edit customers and leads'),
  ('inquiries.create',    'Register walk-ins and inquiries'),
  ('sales.read',          'View sales pipeline and activity'),
  ('sales.write',         'Work sales cases, log calls, change stage'),
  ('loans.read',          'View loan cases and status'),
  ('loans.write',         'Work loan cases and checklists'),
  ('documents.read',      'View customer documents'),
  ('documents.verify',    'Accept or reject documents'),
  ('marketing.read',      'View marketing content and media'),
  ('marketing.publish',   'Publish to connected social accounts'),
  ('construction.read',   'View construction sites and updates'),
  ('construction.upload', 'Check in/out and upload site updates'),
  ('pricing.read',        'View pricing sheets and quotes'),
  ('pricing.negotiate',   'Change negotiable pricing components'),
  ('analytics.view',      'View operational analytics'),
  ('financials.view',     'View revenue, profit and cost data'),
  ('audit.view',          'Read the audit log'),
  ('users.manage',        'Create, disable and assign users'),
  ('workflows.manage',    'Configure workflows and business rules')
on conflict (key) do nothing;

create table if not exists roles (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  key         text not null,        -- admin, sales, marketing, loan, construction, audit, front_desk
  name        text not null,
  description text not null default '',
  -- System roles cannot be deleted; custom ones added by an admin can.
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (org_id, key)
);

create table if not exists role_permissions (
  role_id        uuid not null references roles(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table if not exists user_roles (
  profile_id uuid not null references profiles(id) on delete cascade,
  role_id    uuid not null references roles(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references profiles(id) on delete set null,
  primary key (profile_id, role_id)
);

-- ---------------------------------------------------------------------------
-- Authorisation helpers. Every policy funnels through these.
-- ---------------------------------------------------------------------------
create or replace function app_profile() returns profiles
  language sql stable security definer set search_path = public as $$
    select * from profiles where id = auth.uid() and active limit 1;
  $$;

create or replace function app_org() returns uuid
  language sql stable as $$ select (app_profile()).org_id $$;

create or replace function app_has(perm text) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1
      from user_roles ur
      join role_permissions rp on rp.role_id = ur.role_id
      where ur.profile_id = auth.uid() and rp.permission_key = perm
    );
  $$;

-- ---------------------------------------------------------------------------
-- Projects, units, customers
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  location   text,
  status     text not null default 'ACTIVE',
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists units (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  unit_ref    text not null,
  unit_type   text,
  area_sqft   numeric not null check (area_sqft > 0),
  floor       int not null default 0,
  facing      text,
  corner      boolean not null default false,
  status      text not null default 'AVAILABLE',
  unique (project_id, unit_ref)
);

create table if not exists customers (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  full_name           text not null default 'Unknown',
  phone               text not null,
  whatsapp_phone      text,
  email               text,
  source              text not null default 'walk_in',
  stage               text not null default 'INQUIRY',
  status              text not null default 'new',
  owner_id            uuid references profiles(id) on delete set null,
  loan_officer_id     uuid references profiles(id) on delete set null,
  department_id       uuid references departments(id) on delete set null,
  project_id          uuid references projects(id) on delete set null,
  interested_unit_id  uuid references units(id) on delete set null,
  property_type       text,
  budget_min          numeric,
  budget_max          numeric,
  preferred_location  text,
  preferred_facing    text,
  size_requirement    text,
  requirements        text,
  interest_level      text,
  loan_required       text not null default 'UNKNOWN' check (loan_required in ('YES','NO','UNKNOWN')),
  sentiment           text not null default 'NEUTRAL',
  sentiment_confidence numeric(3,2) not null default 0.5,
  intent              text not null default 'INFORMATIONAL',
  lead_score          int not null default 0 check (lead_score between 0 and 100),
  ai_enabled_sales    boolean not null default true,
  ai_enabled_loan     boolean not null default true,
  opted_out           boolean not null default false,
  next_action_at      timestamptz,
  last_interaction_at timestamptz,
  notes               text not null default '',
  tags                text[] not null default '{}',
  created_by          uuid references profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One phone is one customer. Without this, WhatsApp and the front desk each
  -- create their own record and the lifecycle forks.
  constraint customers_org_phone_key unique (org_id, phone)
);
create index if not exists customers_owner_idx on customers (owner_id) where owner_id is not null;
create index if not exists customers_stage_idx on customers (org_id, stage);
create index if not exists customers_email_idx on customers (org_id, lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- Workflow engine — one engine, many departments
-- ---------------------------------------------------------------------------
create table if not exists workflow_definitions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  key         text not null,        -- sales, loan, document, construction, marketing, audit
  name        text not null,
  entity_type text not null,        -- customer, loan_case, construction_update …
  active      boolean not null default true,
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (org_id, key)
);

create table if not exists workflow_stages (
  id            uuid primary key default gen_random_uuid(),
  definition_id uuid not null references workflow_definitions(id) on delete cascade,
  key           text not null,
  name          text not null,
  sort_order    int not null default 0,
  -- SLA in hours; aging alerts fire off this.
  sla_hours     int,
  entry_actions jsonb not null default '[]'::jsonb,
  exit_criteria jsonb not null default '{}'::jsonb,
  is_terminal   boolean not null default false,
  unique (definition_id, key)
);

create table if not exists workflow_instances (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  definition_id uuid not null references workflow_definitions(id) on delete cascade,
  entity_type   text not null,
  entity_id     uuid not null,
  customer_id   uuid references customers(id) on delete cascade,
  stage_id      uuid references workflow_stages(id) on delete set null,
  status        text not null default 'ACTIVE' check (status in ('ACTIVE','BLOCKED','COMPLETED','CANCELLED')),
  -- A sub-workflow (loan inside sales) points at its parent so the parent can
  -- wait for it to come back green.
  parent_id     uuid references workflow_instances(id) on delete cascade,
  entered_stage_at timestamptz not null default now(),
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists workflow_instances_entity_idx on workflow_instances (entity_type, entity_id);
create index if not exists workflow_instances_aging_idx on workflow_instances (org_id, entered_stage_at) where status = 'ACTIVE';

create table if not exists workflow_tasks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  instance_id   uuid references workflow_instances(id) on delete cascade,
  customer_id   uuid references customers(id) on delete cascade,
  title         text not null,
  description   text not null default '',
  kind          text not null default 'CALL',
  assigned_to   uuid references profiles(id) on delete set null,
  assigned_role uuid references roles(id) on delete set null,
  priority      text not null default 'NORMAL' check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  status        text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  due_at        timestamptz,
  completed_at  timestamptz,
  created_by_ai boolean not null default false,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists workflow_tasks_inbox_idx on workflow_tasks (assigned_to, status, due_at);

-- ---------------------------------------------------------------------------
-- Loan
-- ---------------------------------------------------------------------------
create table if not exists loan_cases (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  customer_id       uuid not null references customers(id) on delete cascade,
  officer_id        uuid references profiles(id) on delete set null,
  lender_id         uuid,
  status            text not null default 'INITIATED',
  property_value    numeric,
  requested_amount  numeric,
  down_payment      numeric,
  ltv_percent       numeric,
  customer_income   numeric,
  employment_info   text,
  notes             text[] not null default '{}',
  ready_at          timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  closed_at         timestamptz
);
create unique index if not exists loan_cases_one_active on loan_cases (customer_id)
  where status not in ('COMPLETED','REJECTED','CANCELLED');

-- Lender rules — configurable, read by the future analysis module. Nothing
-- evaluates these yet; the table exists so adding that module needs no migration.
create table if not exists lender_rules (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  lender     text not null,
  label      text not null,
  kind       text not null,   -- MIN_INCOME, MAX_LTV, MIN_DOWN_PAYMENT, MIN_EMPLOYMENT_MONTHS …
  operator   text not null check (operator in ('gte','lte','eq','in','exists')),
  value      text not null,
  severity   text not null default 'WARNING' check (severity in ('BLOCKING','WARNING','INFO')),
  enabled    boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists document_requirements (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  loan_case_id  uuid not null references loan_cases(id) on delete cascade,
  doc_type      text not null,
  customer_label text not null,
  description   text not null default '',
  required      boolean not null default true,
  status        text not null default 'NOT_REQUESTED'
                check (status in ('NOT_REQUESTED','REQUESTED','UPLOADED','UNDER_REVIEW','VERIFIED','REJECTED','NOT_REQUIRED')),
  accepted_formats text[] not null default '{pdf,jpg,png}',
  rejection_reason text,
  due_at        timestamptz,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (loan_case_id, doc_type)
);

create table if not exists documents (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  loan_case_id    uuid references loan_cases(id) on delete set null,
  requirement_id  uuid references document_requirements(id) on delete set null,
  storage_path    text not null,           -- private bucket key, never a URL
  filename        text not null,
  mime_type       text not null,
  size_bytes      bigint not null check (size_bytes > 0),
  sha256          text not null,
  uploaded_by     uuid references profiles(id) on delete set null,
  uploaded_via    text not null default 'whatsapp',
  status          text not null default 'RECEIVED' check (status in ('RECEIVED','UNDER_REVIEW','VERIFIED','REJECTED')),
  reviewed_by     uuid references profiles(id) on delete set null,
  reviewed_at     timestamptz,
  rejection_reason text,
  created_at      timestamptz not null default now(),
  unique (customer_id, sha256),
  constraint documents_rejection_reason_required
    check (status <> 'REJECTED' or (rejection_reason is not null and length(trim(rejection_reason)) > 0))
);

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  channel     text not null default 'whatsapp',
  ai_paused   boolean not null default false,
  handler_id  uuid references profiles(id) on delete set null,
  last_message_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (customer_id, channel)
);

create table if not exists conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  direction       text not null check (direction in ('inbound','outbound')),
  author_type     text not null check (author_type in ('customer','ai','human','system')),
  author_id       uuid references profiles(id) on delete set null,
  body            text not null default '',
  document_id     uuid references documents(id) on delete set null,
  external_id     text,
  automated       boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (org_id, external_id)     -- webhook replay protection
);
create index if not exists messages_customer_idx on conversation_messages (customer_id, created_at desc);

create table if not exists sentiment_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  sentiment   text not null,
  confidence  numeric(3,2) not null check (confidence between 0 and 1),
  intent      text not null,
  urgency     text,
  signals     jsonb not null default '{}'::jsonb,
  reason      text not null default '',
  message_id  uuid references conversation_messages(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists followups (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  customer_id    uuid not null references customers(id) on delete cascade,
  loan_case_id   uuid references loan_cases(id) on delete cascade,
  requirement_id uuid references document_requirements(id) on delete cascade,
  kind           text not null,
  lane           text not null check (lane in ('SALES','LOAN')),
  scheduled_at   timestamptz not null,
  attempts       int not null default 0,
  max_attempts   int not null default 3,
  status         text not null default 'SCHEDULED'
                 check (status in ('SCHEDULED','SENT','COMPLETED','CANCELLED','ESCALATED','PAUSED')),
  last_sent_at   timestamptz,
  reason         text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists followups_due_idx on followups (org_id, scheduled_at) where status = 'SCHEDULED';

-- ---------------------------------------------------------------------------
-- Construction — daily check-in / check-out with site photos
-- ---------------------------------------------------------------------------
create table if not exists construction_sites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  name       text not null,
  address    text,
  latitude   numeric,
  longitude  numeric,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists construction_updates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  site_id        uuid not null references construction_sites(id) on delete cascade,
  profile_id     uuid not null references profiles(id) on delete cascade,
  work_date      date not null default current_date,
  checked_in_at  timestamptz not null default now(),
  checked_out_at timestamptz,
  check_in_lat   numeric,
  check_in_lng   numeric,
  progress_note  text not null default '',
  status_summary text,
  percent_complete int check (percent_complete between 0 and 100),
  created_at     timestamptz not null default now(),
  -- One shift per person per site per day; a second check-in is a correction.
  unique (site_id, profile_id, work_date)
);

create table if not exists media_assets (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  storage_path text not null,
  kind        text not null default 'image',
  filename    text not null,
  mime_type   text not null,
  size_bytes  bigint,
  width       int,
  height      int,
  site_id     uuid references construction_sites(id) on delete set null,
  update_id   uuid references construction_updates(id) on delete set null,
  project_id  uuid references projects(id) on delete set null,
  captured_at timestamptz,
  uploaded_by uuid references profiles(id) on delete set null,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists media_site_idx on media_assets (org_id, site_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Marketing & social
-- ---------------------------------------------------------------------------
create table if not exists social_accounts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  platform       text not null,
  external_id    text not null,
  handle         text not null,
  -- Tokens are encrypted application-side before insert; the column never holds
  -- a plaintext token, and no client-facing policy selects it.
  access_token_enc  text,
  refresh_token_enc text,
  token_expires_at  timestamptz,
  scopes         text[] not null default '{}',
  status         text not null default 'CONNECTED' check (status in ('CONNECTED','EXPIRED','ERROR','DISCONNECTED')),
  connected_by   uuid references profiles(id) on delete set null,
  last_error     text,
  created_at     timestamptz not null default now(),
  unique (org_id, platform, external_id)
);

create table if not exists social_posts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  account_id   uuid references social_accounts(id) on delete set null,
  update_id    uuid references construction_updates(id) on delete set null,
  template     text,                 -- daily_update, weekly_update, monthly_update
  caption      text not null default '',
  media_ids    uuid[] not null default '{}',
  scheduled_at timestamptz,
  status       text not null default 'DRAFT'
               check (status in ('DRAFT','SCHEDULED','PUBLISHING','PUBLISHED','FAILED')),
  external_post_id text,
  permalink    text,
  error        text,
  attempts     int not null default 0,
  published_at timestamptz,
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Pricing & negotiation
-- ---------------------------------------------------------------------------
create table if not exists pricing_models (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name       text not null,
  currency   text not null default 'INR',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pricing_components (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  model_id     uuid not null references pricing_models(id) on delete cascade,
  label        text not null,
  kind         text not null check (kind in ('base_per_sft','per_sft','flat','per_floor_per_sft','percentage')),
  value        numeric not null,
  basis        jsonb,                -- percentage basis
  base_floor   int,
  applies_when jsonb,                -- typed condition set, not an expression language
  negotiable   boolean not null default true,
  category     text not null default 'OTHER' check (category in ('BASE','PREFERENTIAL','AMENITY','STATUTORY','OTHER')),
  sort_order   int not null default 0,
  active       boolean not null default true,
  notes        text
);

create table if not exists quotes (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  model_id           uuid not null references pricing_models(id) on delete cascade,
  project_id         uuid not null references projects(id) on delete cascade,
  customer_id        uuid references customers(id) on delete cascade,
  unit_id            uuid references units(id) on delete set null,
  current_version_id uuid,
  status             text not null default 'DRAFT' check (status in ('DRAFT','SHARED','NEGOTIATING','ACCEPTED','LOST')),
  created_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Immutable. A negotiation produces a new row; the old sheet is never
-- overwritten, because "what did we offer last week?" must stay answerable.
create table if not exists quote_versions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  quote_id      uuid not null references quotes(id) on delete cascade,
  version       int not null,
  unit_attrs    jsonb not null,
  overrides     jsonb not null default '[]'::jsonb,
  lines         jsonb not null,
  totals        jsonb not null,
  supersedes_id uuid references quote_versions(id) on delete set null,
  note          text,
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (quote_id, version)
);
alter table quotes drop constraint if exists quotes_current_version_fk;
alter table quotes add constraint quotes_current_version_fk
  foreign key (current_version_id) references quote_versions(id) on delete set null;

create or replace function quote_versions_immutable() returns trigger
  language plpgsql as $$ begin
    raise exception 'quote_versions is append-only; create a new version instead';
  end $$;
drop trigger if exists quote_versions_no_update on quote_versions;
create trigger quote_versions_no_update before update or delete on quote_versions
  for each row execute function quote_versions_immutable();

-- ---------------------------------------------------------------------------
-- Notifications, audit, integrations
-- ---------------------------------------------------------------------------
create table if not exists notifications (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  recipient_id   uuid references profiles(id) on delete cascade,
  recipient_role uuid references roles(id) on delete cascade,
  category       text not null,
  event          text not null,
  title          text not null,
  body           text not null default '',
  customer_id    uuid references customers(id) on delete cascade,
  severity       text not null default 'INFO' check (severity in ('INFO','WARNING','CRITICAL')),
  read           boolean not null default false,
  created_at     timestamptz not null default now(),
  check (recipient_id is not null or recipient_role is not null)
);
create index if not exists notifications_inbox_idx on notifications (recipient_id, read, created_at desc);

create table if not exists audit_logs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  actor_id    uuid references profiles(id) on delete set null,
  actor_type  text not null default 'human' check (actor_type in ('human','ai','system','customer')),
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  customer_id uuid references customers(id) on delete set null,
  before      jsonb,
  after       jsonb,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_customer_idx on audit_logs (customer_id, created_at desc);
create index if not exists audit_entity_idx on audit_logs (entity, entity_id, created_at desc);

create or replace function audit_append_only() returns trigger
  language plpgsql as $$ begin
    raise exception 'audit_logs is append-only';
  end $$;
drop trigger if exists audit_no_update on audit_logs;
create trigger audit_no_update before update or delete on audit_logs
  for each row execute function audit_append_only();

create table if not exists integrations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  provider   text not null,          -- whatsapp, meta, google, instagram …
  config     jsonb not null default '{}'::jsonb,   -- non-secret config only
  status     text not null default 'NOT_CONFIGURED',
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, provider)
);

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Permission-based throughout. A new role is a row, not a migration.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','departments','profiles','permissions','roles','role_permissions','user_roles',
    'projects','units','customers','workflow_definitions','workflow_stages',
    'workflow_instances','workflow_tasks','loan_cases','lender_rules',
    'document_requirements','documents','conversations','conversation_messages',
    'sentiment_events','followups','construction_sites','construction_updates',
    'media_assets','social_accounts','social_posts','pricing_models',
    'pricing_components','quotes','quote_versions','notifications','audit_logs','integrations'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- The permission catalogue is a shared vocabulary: readable by any signed-in
-- user so the UI can render role editors, writable by nobody through the API.
drop policy if exists permissions_read on permissions;
create policy permissions_read on permissions for select using (auth.uid() is not null);

-- Everyone signed in sees their own org's shell records.
drop policy if exists org_self on organizations;
create policy org_self on organizations for select using (id = app_org());

drop policy if exists profiles_same_org on profiles;
create policy profiles_same_org on profiles for select using (org_id = app_org());
drop policy if exists profiles_admin_write on profiles;
create policy profiles_admin_write on profiles for all
  using (org_id = app_org() and app_has('users.manage'))
  with check (org_id = app_org() and app_has('users.manage'));

-- Customers: readable with customers.read, but a non-manager only sees their own.
drop policy if exists customers_read on customers;
create policy customers_read on customers for select using (
  org_id = app_org() and app_has('customers.read')
  and (app_has('analytics.view') or owner_id = auth.uid() or loan_officer_id = auth.uid() or created_by = auth.uid())
);
drop policy if exists customers_write on customers;
create policy customers_write on customers for insert with check (
  org_id = app_org() and (app_has('customers.write') or app_has('inquiries.create'))
);
drop policy if exists customers_update on customers;
create policy customers_update on customers for update using (
  org_id = app_org() and app_has('customers.write')
  and (app_has('analytics.view') or owner_id = auth.uid() or loan_officer_id = auth.uid())
);

-- Documents: the department boundary. Sales does not get customer bank
-- statements merely by holding customers.read.
drop policy if exists documents_read on documents;
create policy documents_read on documents for select using (
  org_id = app_org() and app_has('documents.read')
);
drop policy if exists documents_write on documents;
create policy documents_write on documents for all
  using (org_id = app_org() and app_has('documents.verify'))
  with check (org_id = app_org() and app_has('documents.verify'));

drop policy if exists requirements_rw on document_requirements;
create policy requirements_rw on document_requirements for all
  using (org_id = app_org() and app_has('loans.read'))
  with check (org_id = app_org() and app_has('loans.write'));

-- Loan case headline status is visible to sales (loans.read) so they can answer
-- "where is my application?"; only loans.write may change it.
drop policy if exists loan_cases_read on loan_cases;
create policy loan_cases_read on loan_cases for select using (org_id = app_org() and app_has('loans.read'));
drop policy if exists loan_cases_write on loan_cases;
create policy loan_cases_write on loan_cases for all
  using (org_id = app_org() and app_has('loans.write'))
  with check (org_id = app_org() and app_has('loans.write'));

-- Pricing: reading a sheet and changing one are different permissions.
drop policy if exists pricing_read on pricing_components;
create policy pricing_read on pricing_components for select using (org_id = app_org() and app_has('pricing.read'));
drop policy if exists pricing_write on pricing_components;
create policy pricing_write on pricing_components for all
  using (org_id = app_org() and app_has('workflows.manage'))
  with check (org_id = app_org() and app_has('workflows.manage'));

drop policy if exists quote_versions_read on quote_versions;
create policy quote_versions_read on quote_versions for select using (org_id = app_org() and app_has('pricing.read'));
drop policy if exists quote_versions_insert on quote_versions;
create policy quote_versions_insert on quote_versions for insert
  with check (org_id = app_org() and app_has('pricing.negotiate'));

-- Social tokens: only marketing.publish, and never exposed to the browser
-- because the app reads them through the service role in a server action.
drop policy if exists social_accounts_rw on social_accounts;
create policy social_accounts_rw on social_accounts for all
  using (org_id = app_org() and app_has('marketing.publish'))
  with check (org_id = app_org() and app_has('marketing.publish'));

-- Construction: field staff write their own updates; everyone with read sees them.
drop policy if exists construction_updates_read on construction_updates;
create policy construction_updates_read on construction_updates for select
  using (org_id = app_org() and (app_has('construction.read') or app_has('marketing.read')));
drop policy if exists construction_updates_write on construction_updates;
create policy construction_updates_write on construction_updates for all
  using (org_id = app_org() and app_has('construction.upload') and profile_id = auth.uid())
  with check (org_id = app_org() and app_has('construction.upload') and profile_id = auth.uid());

drop policy if exists audit_read on audit_logs;
create policy audit_read on audit_logs for select using (org_id = app_org() and app_has('audit.view'));
drop policy if exists audit_insert on audit_logs;
create policy audit_insert on audit_logs for insert with check (org_id = app_org());

drop policy if exists notifications_own on notifications;
create policy notifications_own on notifications for all
  using (org_id = app_org() and (recipient_id = auth.uid()
         or recipient_role in (select role_id from user_roles where profile_id = auth.uid())))
  with check (org_id = app_org());

-- Join tables carry no org_id of their own; they are scoped through the parent
-- row. Writing them into the generic loop below would reference a column that
-- does not exist, so they get explicit policies.
drop policy if exists role_permissions_read on role_permissions;
create policy role_permissions_read on role_permissions for select using (
  exists (select 1 from roles r where r.id = role_permissions.role_id and r.org_id = app_org())
);
drop policy if exists role_permissions_write on role_permissions;
create policy role_permissions_write on role_permissions for all using (
  app_has('users.manage')
  and exists (select 1 from roles r where r.id = role_permissions.role_id and r.org_id = app_org())
) with check (
  app_has('users.manage')
  and exists (select 1 from roles r where r.id = role_permissions.role_id and r.org_id = app_org())
);

drop policy if exists user_roles_read on user_roles;
create policy user_roles_read on user_roles for select using (
  profile_id = auth.uid()
  or exists (select 1 from profiles p where p.id = user_roles.profile_id and p.org_id = app_org() and app_has('customers.read'))
);
drop policy if exists user_roles_write on user_roles;
create policy user_roles_write on user_roles for all using (
  app_has('users.manage')
  and exists (select 1 from profiles p where p.id = user_roles.profile_id and p.org_id = app_org())
) with check (
  app_has('users.manage')
  and exists (select 1 from profiles p where p.id = user_roles.profile_id and p.org_id = app_org())
);

drop policy if exists workflow_stages_read on workflow_stages;
create policy workflow_stages_read on workflow_stages for select using (
  exists (select 1 from workflow_definitions d where d.id = workflow_stages.definition_id and d.org_id = app_org())
);
drop policy if exists workflow_stages_write on workflow_stages;
create policy workflow_stages_write on workflow_stages for all using (
  app_has('workflows.manage')
  and exists (select 1 from workflow_definitions d where d.id = workflow_stages.definition_id and d.org_id = app_org())
) with check (
  app_has('workflows.manage')
  and exists (select 1 from workflow_definitions d where d.id = workflow_stages.definition_id and d.org_id = app_org())
);

-- Remaining operational tables: org-scoped, gated on a sensible permission.
do $$
declare r record;
begin
  for r in select * from (values
    ('departments','customers.read','users.manage'),
    ('roles','customers.read','users.manage'),
    ('projects','customers.read','workflows.manage'),
    ('units','customers.read','workflows.manage'),
    ('workflow_definitions','customers.read','workflows.manage'),
    ('workflow_instances','customers.read','customers.write'),
    ('workflow_tasks','customers.read','customers.write'),
    ('lender_rules','loans.read','workflows.manage'),
    ('conversations','customers.read','customers.write'),
    ('conversation_messages','customers.read','customers.write'),
    ('sentiment_events','customers.read','customers.write'),
    ('followups','customers.read','customers.write'),
    ('construction_sites','construction.read','workflows.manage'),
    ('media_assets','marketing.read','construction.upload'),
    ('social_posts','marketing.read','marketing.publish'),
    ('pricing_models','pricing.read','workflows.manage'),
    ('quotes','pricing.read','pricing.negotiate'),
    ('integrations','analytics.view','workflows.manage')
  ) as t(tbl, read_perm, write_perm) loop
    execute format('drop policy if exists %I_read on %I', r.tbl, r.tbl);
    execute format(
      'create policy %I_read on %I for select using (org_id = app_org() and app_has(%L))',
      r.tbl, r.tbl, r.read_perm);
    execute format('drop policy if exists %I_write on %I', r.tbl, r.tbl);
    execute format(
      'create policy %I_write on %I for all using (org_id = app_org() and app_has(%L)) with check (org_id = app_org() and app_has(%L))',
      r.tbl, r.tbl, r.write_perm, r.write_perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Private storage buckets. Nothing customer-facing is public.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values
  ('customer-documents', 'customer-documents', false),
  ('construction-media', 'construction-media', false)
on conflict (id) do nothing;

drop policy if exists customer_documents_read on storage.objects;
create policy customer_documents_read on storage.objects for select
  using (bucket_id = 'customer-documents' and app_has('documents.read'));

drop policy if exists construction_media_read on storage.objects;
create policy construction_media_read on storage.objects for select
  using (bucket_id = 'construction-media' and (app_has('construction.read') or app_has('marketing.read')));

drop policy if exists construction_media_write on storage.objects;
create policy construction_media_write on storage.objects for insert
  with check (bucket_id = 'construction-media' and app_has('construction.upload'));

-- ═══════════════════════ BOOTSTRAP DATA ═══════════════════════
-- ============================================================================
-- GLENTREE BOOTSTRAP — org, departments, roles, and a real pricing sheet.
--
-- Idempotent: safe to re-run. Creates no users and no customers. Staff accounts
-- are provisioned through Supabase Auth (see scripts/provision-users.ts), so no
-- password ever appears in a migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------
insert into organizations (name, slug, plan, settings)
values ('Glentree', 'glentree', 'PREMIUM', jsonb_build_object(
  'currency', 'INR',
  'timezone', 'Asia/Kolkata',
  'domain', 'glentree.com'
))
on conflict (slug) do nothing;

do $$
declare org uuid;
begin
  select id into org from organizations where slug = 'glentree';

  -- -------------------------------------------------------------------------
  -- Departments
  -- -------------------------------------------------------------------------
  insert into departments (org_id, key, name) values
    (org, 'front_desk',   'Front Desk / Reception'),
    (org, 'sales',        'Sales'),
    (org, 'marketing',    'Marketing'),
    (org, 'loan',         'Loan Department'),
    (org, 'construction', 'Construction'),
    (org, 'audit',        'Audit'),
    (org, 'management',   'Management')
  on conflict (org_id, key) do nothing;

  -- -------------------------------------------------------------------------
  -- Roles. Permissions are granted per role, so an admin can later create a
  -- new role and pick capabilities without a code change.
  -- -------------------------------------------------------------------------
  insert into roles (org_id, key, name, description, is_system) values
    (org, 'admin',        'Admin',            'Full operational and financial visibility', true),
    (org, 'front_desk',   'Front Desk',       'Registers walk-ins and inquiries', true),
    (org, 'sales',        'Sales',            'Works inquiries through to booking', true),
    (org, 'marketing',    'Marketing',        'Creates and publishes content', true),
    (org, 'loan',         'Loan Officer',     'Runs loan cases and document collection', true),
    (org, 'construction', 'Construction',     'Records daily site updates', true),
    (org, 'audit',        'Audit',            'Read-only review across the operation', true)
  on conflict (org_id, key) do nothing;
end $$;

-- Grant permissions per role.
do $$
declare
  org uuid;
  grants jsonb := jsonb_build_object(
    -- Admin: everything, including money.
    'admin', jsonb_build_array(
      'customers.read','customers.write','inquiries.create','sales.read','sales.write',
      'loans.read','loans.write','documents.read','documents.verify',
      'marketing.read','marketing.publish','construction.read','construction.upload',
      'pricing.read','pricing.negotiate','analytics.view','financials.view',
      'audit.view','users.manage','workflows.manage'),

    -- Front desk: registers people. Deliberately no sales pipeline, no money.
    -- The transcript is explicit that a receptionist asking for monthly profit
    -- must be refused, so the permission simply is not granted.
    'front_desk', jsonb_build_array(
      'customers.read','inquiries.create'),

    -- Sales: works customers and quotes. Reads loan status to answer "where is
    -- my application?", but gets no document access.
    'sales', jsonb_build_array(
      'customers.read','customers.write','inquiries.create','sales.read','sales.write',
      'loans.read','pricing.read','pricing.negotiate','construction.read','marketing.read'),

    -- Marketing: content and publishing, plus read access to site photos.
    'marketing', jsonb_build_array(
      'marketing.read','marketing.publish','construction.read','customers.read'),

    -- Loan: the only role besides admin that may see customer documents.
    'loan', jsonb_build_array(
      'customers.read','customers.write','loans.read','loans.write',
      'documents.read','documents.verify','sales.read'),

    -- Construction: uploads from the field, sees its own sites.
    'construction', jsonb_build_array(
      'construction.read','construction.upload'),

    -- Audit: broad read, no write, no publishing.
    'audit', jsonb_build_array(
      'customers.read','sales.read','loans.read','pricing.read',
      'construction.read','marketing.read','analytics.view','audit.view')
  );
  role_key text;
  perm text;
  rid uuid;
begin
  select id into org from organizations where slug = 'glentree';

  for role_key in select jsonb_object_keys(grants) loop
    select id into rid from roles where org_id = org and key = role_key;
    if rid is null then continue; end if;
    for perm in select jsonb_array_elements_text(grants -> role_key) loop
      insert into role_permissions (role_id, permission_key)
      values (rid, perm) on conflict do nothing;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Workflow definitions. The loan workflow is a sub-workflow of sales: it runs
-- its own cycle and reports back completion, at which point sales continues.
-- ---------------------------------------------------------------------------
do $$
declare
  org uuid;
  sales_def uuid;
  loan_def uuid;
  doc_def uuid;
begin
  select id into org from organizations where slug = 'glentree';

  insert into workflow_definitions (org_id, key, name, entity_type)
  values (org, 'sales', 'Sales lifecycle', 'customer')
  on conflict (org_id, key) do nothing;
  select id into sales_def from workflow_definitions where org_id = org and key = 'sales';

  insert into workflow_stages (definition_id, key, name, sort_order, sla_hours) values
    (sales_def, 'inquiry',       'Inquiry',              0, 2),
    (sales_def, 'qualification', 'Sales qualification',  1, 24),
    (sales_def, 'follow_up',     'Follow-up',            2, 48),
    (sales_def, 'site_visit',    'Site visit',           3, 72),
    (sales_def, 'negotiation',   'Negotiation',          4, 72),
    (sales_def, 'booking',       'Booking',              5, 48),
    (sales_def, 'loan',          'Loan processing',      6, null),
    (sales_def, 'completed',     'Completed',            7, null)
  on conflict (definition_id, key) do nothing;
  update workflow_stages set is_terminal = true where definition_id = sales_def and key = 'completed';

  insert into workflow_definitions (org_id, key, name, entity_type)
  values (org, 'loan', 'Loan processing', 'loan_case')
  on conflict (org_id, key) do nothing;
  select id into loan_def from workflow_definitions where org_id = org and key = 'loan';

  insert into workflow_stages (definition_id, key, name, sort_order, sla_hours) values
    (loan_def, 'initiated',        'Loan initiated',          0, 24),
    (loan_def, 'officer_assigned', 'Officer assigned',        1, 24),
    (loan_def, 'info_collection',  'Information collection',  2, 72),
    (loan_def, 'eligibility',      'Eligibility check',       3, 48),
    (loan_def, 'doc_collection',   'Document collection',     4, 168),
    (loan_def, 'verification',     'Document verification',   5, 48),
    (loan_def, 'consent',          'Consent & declarations',  6, 48),
    (loan_def, 'lender',           'Lender processing',       7, 336),
    (loan_def, 'decision',         'Decision',                8, null),
    (loan_def, 'completed',        'Completed',               9, null)
  on conflict (definition_id, key) do nothing;
  update workflow_stages set is_terminal = true where definition_id = loan_def and key = 'completed';

  insert into workflow_definitions (org_id, key, name, entity_type)
  values (org, 'construction', 'Daily site update', 'construction_update')
  on conflict (org_id, key) do nothing;
  select id into doc_def from workflow_definitions where org_id = org and key = 'construction';

  insert into workflow_stages (definition_id, key, name, sort_order, sla_hours) values
    (doc_def, 'checked_in',  'Checked in',   0, 12),
    (doc_def, 'uploaded',    'Update logged',1, null),
    (doc_def, 'checked_out', 'Checked out',  2, null)
  on conflict (definition_id, key) do nothing;
  update workflow_stages set is_terminal = true where definition_id = doc_def and key = 'checked_out';
end $$;

-- ---------------------------------------------------------------------------
-- A project and its pricing sheet.
--
-- Mirrors the structure a buyer is actually handed: a base rate per sft, then
-- preferential-location charges, floor rise charged per sft per floor,
-- amenities and parking, then statutory documentation, registration and GST.
-- Rates below are placeholders — an admin edits them in the app.
-- ---------------------------------------------------------------------------
do $$
declare
  org uuid;
  proj uuid;
  model uuid;
begin
  select id into org from organizations where slug = 'glentree';

  insert into projects (org_id, name, location, metadata)
  values (org, 'Glentree Villas', 'Adibatla', jsonb_build_object('type','villa'))
  on conflict do nothing;
  select id into proj from projects where org_id = org and name = 'Glentree Villas' limit 1;

  insert into pricing_models (org_id, project_id, name)
  values (org, proj, 'Glentree Villas — standard sheet')
  on conflict do nothing;
  select id into model from pricing_models where project_id = proj limit 1;

  if not exists (select 1 from pricing_components where model_id = model) then
    insert into pricing_components
      (org_id, model_id, label, kind, value, basis, base_floor, applies_when, negotiable, category, sort_order)
    values
      (org, model, 'Base price',              'base_per_sft',      5000, null, null, null, true,  'BASE',         10),
      (org, model, 'East facing charge',      'per_sft',            150, null, null,
        jsonb_build_object('facingIn', jsonb_build_array('EAST','NORTH_EAST')),                 true,  'PREFERENTIAL', 20),
      (org, model, 'Corner charge',           'per_sft',            120, null, null,
        jsonb_build_object('cornerOnly', true),                                                 true,  'PREFERENTIAL', 30),
      -- Floor rise: charged per sft for every floor above the ground floor.
      (org, model, 'Floor rise',              'per_floor_per_sft',   25, null, 0,    null,      true,  'PREFERENTIAL', 40),
      (org, model, 'Amenities charge',        'per_sft',            250, null, null, null,      true,  'AMENITY',      50),
      (org, model, 'Clubhouse charge',        'flat',            150000, null, null, null,      true,  'AMENITY',      60),
      (org, model, 'Covered car parking',     'flat',            300000, null, null, null,      true,  'AMENITY',      70),
      (org, model, 'Power backup',            'flat',             75000, null, null, null,      true,  'AMENITY',      80),
      (org, model, 'Water & electricity connection', 'flat',       90000, null, null, null,     true,  'OTHER',        90),
      (org, model, 'Corpus fund',             'flat',            120000, null, null, null,      true,  'OTHER',       100),
      (org, model, 'Maintenance (2 years)',   'per_sft',             36, null, null, null,      true,  'OTHER',       110),
      (org, model, 'Documentation charges',   'flat',             50000, null, null, null,      false, 'STATUTORY',   120),
      -- Statutory rows are charged on the base value, not the all-in subtotal.
      (org, model, 'GST',                     'percentage',           5, '"base_only"'::jsonb, null, null, false, 'STATUTORY', 130),
      (org, model, 'Stamp duty',              'percentage',         5.0, '"base_only"'::jsonb, null, null, false, 'STATUTORY', 140),
      (org, model, 'Registration charges',    'percentage',         1.0, '"base_only"'::jsonb, null, null, false, 'STATUTORY', 150);
  end if;
end $$;

-- ============================================================================
-- VERIFY — expect 34 tables, 64 policies, 20 permissions, 7 roles, 53 grants.
-- ============================================================================
select
  (select count(*) from information_schema.tables
     where table_schema='public' and table_type='BASE TABLE')  as tables,
  (select count(*) from pg_policies where schemaname='public') as rls_policies,
  (select count(*) from permissions)                           as permissions,
  (select count(*) from roles)                                 as roles,
  (select count(*) from role_permissions)                      as grants,
  (select count(*) from pricing_components)                    as pricing_rows,
  (select count(*) from workflow_stages)                       as workflow_stages;

-- Every table must have RLS on. Expect zero rows.
select tablename from pg_tables where schemaname='public' and rowsecurity=false;
