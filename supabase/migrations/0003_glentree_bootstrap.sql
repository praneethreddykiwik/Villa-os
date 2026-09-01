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
