-- ---------------------------------------------------------------------------
-- 0006 — Tenant-scope the chat attachment bucket
--
-- Idempotent. Safe to re-run.
--
-- `message_media_read` and `message_media_write` were gated on nothing more
-- than `auth.uid() is not null`. Any authenticated user — every staff member of
-- every organisation — could therefore list, download and overwrite every
-- object in the bucket, including attachments on direct messages they are not a
-- party to. The `messages` table itself is scoped correctly (sender, recipient
-- or org broadcast), so the row telling you a photo exists was private while
-- the photo was not.
--
-- Keys are written as `<org_id>/<uuid>.<ext>` by uploadMedia() in
-- src/lib/messaging/api.ts, so the first path segment is the tenant and can be
-- compared against public.app_org() directly.
--
-- This scopes to the organisation rather than to the individual conversation.
-- Per-conversation scoping would need the object key to carry the message id,
-- which would be a storage-layout change; org scoping removes the cross-tenant
-- exposure now without a migration of existing objects.
--
-- SEARCH_PATH NOTE (added after this migration failed to apply)
--
-- Every object below is schema-qualified. public.app_org(), public.app_has() and audit_logs
-- all live in `public`, but Supabase's migration runner executes with
-- `search_path = ''`, so an unqualified `public.app_org()` resolved to nothing and the
-- migration died with "function public.app_org() does not exist" — which reads as a
-- missing dependency but is really a name-resolution failure. Qualifying makes
-- the file correct under any search_path, which a policy on a table in another
-- schema needs to be regardless.
-- ---------------------------------------------------------------------------

drop policy if exists message_media_read on storage.objects;
create policy message_media_read on storage.objects for select
  using (
    bucket_id = 'message-media'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = public.app_org()::text
  );

drop policy if exists message_media_write on storage.objects;
create policy message_media_write on storage.objects for insert
  with check (
    bucket_id = 'message-media'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = public.app_org()::text
  );

-- Nothing deletes chat attachments today, and an unscoped DELETE would let one
-- tenant destroy another's. Restrict it to the owner's own org so that adding a
-- delete feature later cannot become a cross-tenant one by omission.
drop policy if exists message_media_delete on storage.objects;
create policy message_media_delete on storage.objects for delete
  using (
    bucket_id = 'message-media'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = public.app_org()::text
  );

-- ---------------------------------------------------------------------------
-- The same omission in the construction bucket: read was any authenticated
-- user, with no org check. Site photographs are customer-adjacent.
-- ---------------------------------------------------------------------------
drop policy if exists construction_media_read on storage.objects;
create policy construction_media_read on storage.objects for select
  using (
    bucket_id = 'construction-media'
    and public.app_has('construction.read')
    and (storage.foldername(name))[1] = public.app_org()::text
  );
