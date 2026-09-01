# Superseded migrations

`0001_ops_workflow.sql` was the portable Postgres target for the single-tenant
ops model. It is **superseded by `0002_glentree_platform.sql`**, which covers the
same ground plus multi-tenancy, permission-based RBAC and the construction,
marketing and pricing domains.

Do not apply both. They define overlapping tables (`documents`, `audit_logs`,
`notifications`, `followups`) with different shapes, and running them together
will fail or leave the schema inconsistent.

Kept for reference only.
