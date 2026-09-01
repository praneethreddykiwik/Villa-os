-- ============================================================================
-- INTERNAL MESSAGING
--
-- Staff-to-staff messaging: a broadcast "Everyone" channel plus direct threads,
-- with replies, emoji reactions, read receipts, presence and realtime delivery.
--
-- Differences from the reference implementation, and why:
--
--  * Rides on the existing `profiles` table rather than creating its own. One
--    person is one row; a second profiles table would fork identity.
--  * Rows carry `org_id`, so messaging obeys the same tenant boundary as
--    everything else.
--  * Media (photos, voice notes) goes to a private Storage bucket and the
--    message body carries the object path. The reference stores base64 inline;
--    that breaks in two concrete ways — Postgres rows bloat by ~35% over the
--    raw file, and Supabase Realtime drops payloads over ~1 MB, so a photo
--    would save but never broadcast. The wire format is otherwise identical and
--    the parser still reads legacy base64 bodies.
-- ============================================================================

create table if not exists messages (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  sender_id      uuid not null references profiles(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('user','everyone')),
  recipient_id   uuid references profiles(id) on delete cascade,
  body           text not null,
  created_at     timestamptz not null default now(),
  edited_at      timestamptz,
  deleted_at     timestamptz,
  -- A direct message must name its recipient; a broadcast must not.
  constraint messages_recipient_shape check (
    (recipient_type = 'user' and recipient_id is not null)
    or (recipient_type = 'everyone' and recipient_id is null)
  )
);

create index if not exists messages_sender_idx    on messages (sender_id, created_at desc);
create index if not exists messages_recipient_idx on messages (recipient_id, created_at desc);
create index if not exists messages_org_created_idx on messages (org_id, created_at desc);
-- The broadcast channel is read constantly; give it its own partial index.
create index if not exists messages_everyone_idx on messages (org_id, created_at desc)
  where recipient_type = 'everyone';

create table if not exists message_reads (
  message_id uuid not null references messages(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  read_at    timestamptz not null default now(),
  primary key (message_id, profile_id)
);
create index if not exists message_reads_profile_idx on message_reads (profile_id, message_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table messages      enable row level security;
alter table message_reads enable row level security;

-- Read: your own sends, direct messages addressed to you, and the org broadcast.
-- Note this is narrower than the reference, which let any authenticated user
-- read every direct message between other people.
drop policy if exists messages_read on messages;
create policy messages_read on messages for select using (
  org_id = app_org()
  and (
    sender_id = auth.uid()
    or recipient_id = auth.uid()
    or recipient_type = 'everyone'
  )
);

-- Send: only as yourself, only inside your org.
drop policy if exists messages_insert on messages;
create policy messages_insert on messages for insert with check (
  org_id = app_org() and sender_id = auth.uid()
);

-- Edit: only your own message. Reactions are stored in the body, so a reaction
-- from someone else is applied through the add_reaction() function below rather
-- than by granting everyone UPDATE on everyone's messages.
drop policy if exists messages_update on messages;
create policy messages_update on messages for update
  using (org_id = app_org() and sender_id = auth.uid())
  with check (org_id = app_org() and sender_id = auth.uid());

drop policy if exists message_reads_own on message_reads;
create policy message_reads_own on message_reads for all
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Reactions
--
-- Toggling a reaction means rewriting another person's message body, which no
-- sane UPDATE policy should allow. This definer function does the narrow thing
-- instead: it may only touch the reactions map, only on a message the caller is
-- allowed to read.
-- ---------------------------------------------------------------------------
create or replace function toggle_message_reaction(p_message_id uuid, p_emoji text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  msg           messages%rowtype;
  me            profiles%rowtype;
  payload       jsonb;
  prefix        text := '';
  inner_text    text;
  reactions     jsonb;
  holders       jsonb;
  is_image      boolean := false;
begin
  select * into me from profiles where id = auth.uid() and active;
  if me.id is null then raise exception 'not authenticated'; end if;

  select * into msg from messages where id = p_message_id;
  if msg.id is null then raise exception 'message not found'; end if;

  -- Same visibility rule as the select policy.
  if not (msg.org_id = me.org_id and (
        msg.sender_id = me.id or msg.recipient_id = me.id or msg.recipient_type = 'everyone')) then
    raise exception 'not permitted';
  end if;

  if msg.body like '[IMAGE_MSG]:%' then
    is_image := true;
    payload := (substring(msg.body from 13))::jsonb;
  elsif msg.body like '[MSG_PAYLOAD]:%' then
    payload := (substring(msg.body from 15))::jsonb;
  else
    payload := jsonb_build_object('text', msg.body);
  end if;

  reactions := coalesce(payload -> 'reactions', '{}'::jsonb);
  holders   := coalesce(reactions -> p_emoji, '[]'::jsonb);

  if holders @> to_jsonb(me.id::text) then
    holders := (select coalesce(jsonb_agg(v), '[]'::jsonb)
                from jsonb_array_elements(holders) v where v <> to_jsonb(me.id::text));
  else
    holders := holders || to_jsonb(me.id::text);
  end if;

  if jsonb_array_length(holders) = 0 then
    reactions := reactions - p_emoji;
  else
    reactions := jsonb_set(reactions, array[p_emoji], holders);
  end if;

  payload := jsonb_set(payload, '{reactions}', reactions);
  prefix := case when is_image then '[IMAGE_MSG]:' else '[MSG_PAYLOAD]:' end;

  update messages set body = prefix || payload::text where id = p_message_id;
  return reactions;
end $$;

revoke all on function toggle_message_reaction(uuid, text) from public;
grant execute on function toggle_message_reaction(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime + private media bucket
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

insert into storage.buckets (id, name, public)
values ('message-media', 'message-media', false)
on conflict (id) do nothing;

drop policy if exists message_media_read on storage.objects;
create policy message_media_read on storage.objects for select
  using (bucket_id = 'message-media' and auth.uid() is not null);

drop policy if exists message_media_write on storage.objects;
create policy message_media_write on storage.objects for insert
  with check (bucket_id = 'message-media' and auth.uid() is not null);
