-- ---------------------------------------------------------------------------
-- 0007 — Audit-log integrity, storage tenant scoping, and active-profile checks
--
-- Idempotent. Apply AFTER 0006. Both are safe to re-run.
--
-- Three defects from the security audit, all of them in the database layer and
-- none of them fixable in application code:
--
--  1. `audit_logs` accepted forged inserts. The read policy required
--     `audit.view`, but the insert policy required nothing beyond belonging to
--     the org — and there was no UPDATE or DELETE policy at all, which reads as
--     "append-only" but is not enforced. Any authenticated user could write
--     entries attributing actions to a colleague. An audit log that anyone can
--     write to is worse than none, because it is trusted in an investigation.
--
--  2. Storage policies checked a permission but never the organisation. A user
--     holding `documents.read` in org A could read org B's customer identity
--     documents — the exact cross-tenant leak the table policies prevent.
--
--  3. No storage policy checked whether the profile is still `active`. A
--     deactivated employee keeps a valid session until it expires, and
--     public.app_has() reads grants that a disabled profile still holds.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Audit log: attributable inserts, and genuinely append-only.
-- ---------------------------------------------------------------------------

-- An entry must name the actor who wrote it, and that actor must be the caller.
drop policy if exists audit_insert on public.audit_logs;
create policy audit_insert on public.audit_logs for insert with check (
  org_id = public.app_org()
  and (actor_id is null or actor_id = auth.uid())
);

-- Postgres denies any command with no permissive policy, so the absence of an
-- UPDATE/DELETE policy already blocks rewrites through PostgREST. These exist to
-- make that explicit and survive someone later adding a broad `for all` policy.
drop policy if exists audit_no_update on public.audit_logs;
create policy audit_no_update on public.audit_logs for update using (false) with check (false);

drop policy if exists audit_no_delete on public.audit_logs;
create policy audit_no_delete on public.audit_logs for delete using (false);

-- ---------------------------------------------------------------------------
-- 2 + 3. Storage: scope every bucket to the caller's org and require an active
-- profile. Object keys are written as `<org_id>/<uuid>.<ext>` by the upload
-- paths, so the first path segment is the tenant.
-- ---------------------------------------------------------------------------

-- app_org() is called from policies on storage.objects, which the storage
-- service evaluates under its own search_path. The original definition pinned
-- none and was not security definer, so its unqualified call to app_profile()
-- could fail to resolve at runtime exactly as it failed to resolve at apply
-- time. Pin it, and qualify the inner call. Behaviour is otherwise unchanged.
create or replace function public.app_org() returns uuid
  language sql stable security definer set search_path = public as $$
    select (public.app_profile()).org_id
  $$;

-- True only when the caller's profile exists AND is still active. app_profile()
-- already filters on `active`, so a deactivated user resolves to NULL here.
create or replace function public.app_active() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and active);
  $$;

drop policy if exists customer_documents_read on storage.objects;
create policy customer_documents_read on storage.objects for select
  using (
    bucket_id = 'customer-documents'
    and public.app_active()
    and public.app_has('documents.read')
    and (storage.foldername(name))[1] = public.app_org()::text
  );

drop policy if exists construction_media_read on storage.objects;
create policy construction_media_read on storage.objects for select
  using (
    bucket_id = 'construction-media'
    and public.app_active()
    and (public.app_has('construction.read') or public.app_has('marketing.read'))
    and (storage.foldername(name))[1] = public.app_org()::text
  );

drop policy if exists construction_media_write on storage.objects;
create policy construction_media_write on storage.objects for insert
  with check (
    bucket_id = 'construction-media'
    and public.app_active()
    and public.app_has('construction.upload')
    and (storage.foldername(name))[1] = public.app_org()::text
  );

-- Marketing media (created in 0006) gets the same active-profile requirement.
drop policy if exists marketing_media_read on storage.objects;
create policy marketing_media_read on storage.objects for select
  using (
    bucket_id = 'marketing-media'
    and public.app_active()
    and public.app_has('marketing.read')
    and (storage.foldername(name))[1] = public.app_org()::text
  );

drop policy if exists marketing_media_write on storage.objects;
create policy marketing_media_write on storage.objects for insert
  with check (
    bucket_id = 'marketing-media'
    and public.app_active()
    and (public.app_has('marketing.publish') or public.app_has('construction.upload'))
    and (storage.foldername(name))[1] = public.app_org()::text
  );

-- Chat attachments (0006) likewise.
drop policy if exists message_media_read on storage.objects;
create policy message_media_read on storage.objects for select
  using (
    bucket_id = 'message-media'
    and public.app_active()
    and (storage.foldername(name))[1] = public.app_org()::text
  );

drop policy if exists message_media_write on storage.objects;
create policy message_media_write on storage.objects for insert
  with check (
    bucket_id = 'message-media'
    and public.app_active()
    and (storage.foldername(name))[1] = public.app_org()::text
  );

-- marketing_media_delete was created in 0005 with a permission check but no org
-- check, and neither 0006 nor the sections above touched it — so it survived as
-- the last policy on storage.objects through which one tenant could destroy
-- another's objects. Same shape as the rest: active profile, permission, org.
drop policy if exists marketing_media_delete on storage.objects;
create policy marketing_media_delete on storage.objects for delete
  using (
    bucket_id = 'marketing-media'
    and public.app_active()
    and public.app_has('marketing.publish')
    and (storage.foldername(name))[1] = public.app_org()::text
  );
