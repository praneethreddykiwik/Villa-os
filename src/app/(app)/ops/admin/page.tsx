import { redirect } from "next/navigation";
import { Suspense } from "react";
import { pageContext } from "@/lib/page-context";
import { getSession, hasPermission } from "@/lib/auth/session";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge } from "@/components/ui";
import { CardSkeleton } from "@/components/skeletons";
import { accessMatrix, listAccounts, PROTECTED_ROLES } from "@/lib/access/app-rbac";
import { ACTION_PERMISSIONS, tabRows } from "@/lib/access/tab-catalogue";
import { AccessControl } from "@/components/ops/access-control";

export const dynamic = "force-dynamic";

/**
 * CONTROL CENTRE — the people with accounts, and what each role may open.
 *
 * Everything on this screen reads the three tables the request path itself
 * uses: profiles, user_roles and role_permissions. That is deliberate. The
 * previous version read villa_team_members and villa_role_permissions, which
 * list different people under different role names, and which nothing in the
 * application has ever consulted when deciding whether to serve a page. It
 * looked authoritative and changed nothing.
 */
export default async function ControlCentrePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/ops");
  // Reading who has access is itself sensitive: it is a map of which account
  // to go after. Seeing the screen needs a management permission, not merely a
  // login.
  if (!hasPermission(session, "analytics.view")) redirect("/ops");

  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const canEdit = hasPermission(session, "users.manage");

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Control centre" subtitle={brand.name} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-7">
        <Suspense fallback={<CardSkeleton rows={6} />}>
          <AccountsSection canEdit={canEdit} />
        </Suspense>
        <Suspense fallback={<CardSkeleton rows={8} />}>
          <AccessSection canEdit={canEdit} />
        </Suspense>
      </div>
    </>
  );
}

/** Who can sign in, and which role decides what they see. */
async function AccountsSection({ canEdit }: { canEdit: boolean }) {
  const accounts = await listAccounts().catch(() => []);

  if (accounts.length === 0) {
    return (
      <Card>
        <SectionTitle title="Accounts" hint="Nobody is set up yet" />
        <p className="text-[12px] text-mist-400">
          No sign-in accounts were found. Until one exists, nobody can open anything.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle
        title="Accounts"
        hint={`${accounts.length} ${accounts.length === 1 ? "person" : "people"} · each one's role decides what they can open`}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-ink-700 text-[10.5px] uppercase tracking-wider text-[var(--color-faint)]">
              <th className="py-2 pr-4 font-medium">Person</th>
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-b border-ink-800 last:border-0">
                <td className="py-2.5 pr-4">
                  <div className="font-medium text-mist-100">{a.fullName}</div>
                  <div className="text-[11px] text-mist-400">{a.email}</div>
                </td>
                <td className="py-2.5 pr-4 capitalize text-mist-200">
                  {a.role ? a.role.replace(/_/g, " ") : <span className="text-amber-400">No role</span>}
                </td>
                <td className="py-2.5">
                  {/* An account with no role resolves to an empty permission
                      set, so it can sign in and reach nothing. Worth saying
                      plainly rather than leaving the column blank. */}
                  <Badge tone={a.active && a.role ? "good" : "warn"}>
                    {!a.active ? "Deactivated" : a.role ? "Active" : "Cannot open anything"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!canEdit && (
        <p className="mt-3 text-[11.5px] text-mist-400">
          Changing roles or adding people needs an administrator.
        </p>
      )}
    </Card>
  );
}

/** The sidebar, as switches, per role. */
async function AccessSection({ canEdit }: { canEdit: boolean }) {
  const matrix = await accessMatrix().catch(() => null);

  if (!matrix || matrix.roles.length === 0) {
    return (
      <Card>
        <SectionTitle title="Access control" hint="Who can open what" />
        <p className="text-[12px] text-amber-400">
          The roles could not be read just now. Access is still enforced on every request — this screen simply
          cannot show it until the connection recovers.
        </p>
      </Card>
    );
  }

  const rows = tabRows();

  return (
    <Card>
      <SectionTitle
        title="Access control — who can open what"
        hint={`${matrix.roles.length} roles · changes apply immediately`}
      />
      <AccessControl
        rows={rows}
        actions={ACTION_PERMISSIONS}
        byRole={matrix.byRole}
        roles={matrix.roles.map((r) => ({ key: r.key, name: r.name, description: r.description }))}
        protectedRoles={[...PROTECTED_ROLES]}
        canEdit={canEdit}
      />
    </Card>
  );
}
