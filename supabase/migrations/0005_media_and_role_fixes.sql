-- ---------------------------------------------------------------------------
-- 0005 — Marketing media pipeline, and two authorisation defects
--
-- Idempotent, like 0002 and 0003: re-running it is safe.
--
-- Three things, in order of severity:
--
--  1. `roles_read` required `customers.read` in order to read the role
--     catalogue — but the catalogue is what tells you which permissions you
--     hold. Any role without `customers.read` could authenticate and then
--     resolve to zero permissions, because the query that would have told it
--     otherwise was the query being denied. `construction` is the only shipped
--     role without `customers.read`, so the site engineer signed in
--     successfully and landed on "no role assigned".
--
--  2. `media_assets_write` required `construction.upload`, which the marketing
--     role does not hold. Marketing could therefore read the media library but
--     never add to it — which is the entire job. Uploading a reel was
--     impossible for the one role whose purpose is publishing reels.
--
--  3. There was no bucket for marketing media at all. Site photos
--     (construction-media) and chat attachments (message-media) each had one;
--     video destined for Instagram had nowhere to go.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Role catalogue: readable by any member of the org who holds the role.
--
-- The escape hatch mirrors `user_roles_read`, which already says "your own
-- grants are always visible to you". Gating identity resolution on a business
-- permission is the defect; a role you have been granted is not a secret from
-- you. Broader visibility (seeing every role in the org, for a role editor)
-- still requires `customers.read` exactly as before.
-- ---------------------------------------------------------------------------
drop policy if exists roles_read on roles;
create policy roles_read on roles for select using (
  org_id = app_org()
  and (
    app_has('customers.read')
    or exists (
      select 1 from user_roles ur
      where ur.role_id = roles.id and ur.profile_id = auth.uid()
    )
  )
);

-- ---------------------------------------------------------------------------
-- 2. Media library writes.
--
-- Two distinct populations upload media and they carry different permissions:
-- the site engineer uploading progress photos (`construction.upload`) and the
-- marketing lead uploading video to publish (`marketing.publish`). Either is
-- sufficient; org scoping still applies to both.
-- ---------------------------------------------------------------------------
drop policy if exists media_assets_write on media_assets;
create policy media_assets_write on media_assets for all using (
  org_id = app_org()
  and (app_has('construction.upload') or app_has('marketing.publish'))
) with check (
  org_id = app_org()
  and (app_has('construction.upload') or app_has('marketing.publish'))
);

-- ---------------------------------------------------------------------------
-- 3. Marketing media bucket.
--
-- Private, like every other bucket in this project. Nothing customer-facing is
-- public: published video reaches the networks by being handed to their API,
-- not by being readable at a guessable URL.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('marketing-media', 'marketing-media', false)
on conflict (id) do nothing;

drop policy if exists marketing_media_read on storage.objects;
create policy marketing_media_read on storage.objects for select
  using (bucket_id = 'marketing-media' and app_has('marketing.read'));

drop policy if exists marketing_media_write on storage.objects;
create policy marketing_media_write on storage.objects for insert
  with check (
    bucket_id = 'marketing-media'
    and (app_has('marketing.publish') or app_has('construction.upload'))
  );

drop policy if exists marketing_media_delete on storage.objects;
create policy marketing_media_delete on storage.objects for delete
  using (bucket_id = 'marketing-media' and app_has('marketing.publish'));
