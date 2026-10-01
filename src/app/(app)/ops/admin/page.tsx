import { redirect } from "next/navigation";
import { Suspense } from "react";
import { pageContext } from "@/lib/page-context";
import { getSession, hasPermission } from "@/lib/auth/session";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge } from "@/components/ui";
import { CardSkeleton } from "@/components/skeletons";
import { listMemberAccounts, liveMatrix } from "@/lib/osf/rbac";
import { groupIntoAreas, roleDisplayName } from "@/lib/osf/access-areas";
import { AccessControl } from "@/components/ops/access-control";

export const dynamic = "force-dynamic";

/**
 * CONTROL CENTRE — the team, and what each role may do.
 *
 * One screen answers both halves of "who can see this?": which people have
 * accounts, and what the role attached to each of them unlocks. They used to
 * be separate places, so checking an answer meant holding one screen in your
 * head while reading another.
 *
 * Everything here reads villa_team_members and villa_role_permissions — the
 * same tables the database consults when it enforces access. Nothing on this
 * page is a description of the rules; it is the rules.
 */
export default async function ControlCentrePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/ops");
  // Reading who has access is itself sensitive: it is a map of which account
  // to go after. Seeing the screen needs the team permission, not merely a
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
          <TeamSection canEdit={canEdit} />
        </Suspense>
        <Suspense fallback={<CardSkeleton rows={8} />}>
          <AccessSection canEdit={canEdit} />
        </Suspense>
      </div>
    </>
  );
}

/** Who has an account, what role they hold, and whether they have ever signed in. */
async function TeamSection({ canEdit }: { canEdit: boolean }) {
  const members = await listMemberAccounts().catch(() => []);

  if (members.length === 0) {
    return (
      <Card>
        <SectionTitle title="Team members" hint="Nobody is set up yet" />
        <p className="text-[12px] text-mist-400">
          No team records were found. Add people in the team screen and they will appear here with the role they
          hold.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle
        title="Team members"
        hint={`${members.length} ${members.length === 1 ? "person" : "people"} · each one's role decides what they can see`}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-ink-700 text-[10.5px] uppercase tracking-wider text-[var(--color-faint)]">
              <th className="py-2 pr-4 font-medium">Person</th>
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 pr-4 font-medium">Can sign in</th>
              <th className="py-2 font-medium">Access</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-ink-800 last:border-0">
                <td className="py-2.5 pr-4">
                  <div className="font-medium text-mist-100">{m.name || "Unnamed"}</div>
                  {m.email && <div className="text-[11px] text-mist-400">{m.email}</div>}
                </td>
                <td className="py-2.5 pr-4 text-mist-200">{roleDisplayName(m.role)}</td>
                <td className="py-2.5 pr-4">
                  {/* An account with no login is a row in a table, not a person
                      who can reach anything — worth saying plainly. */}
                  <Badge tone={m.hasLogin ? "good" : "warn"}>{m.hasLogin ? "Yes" : "No login yet"}</Badge>
                </td>
                <td className="py-2.5 text-mist-400">
                  {m.permissionCount} {m.permissionCount === 1 ? "capability" : "capabilities"}
                  {!m.isActive && <span className="ml-2 text-amber-400">· deactivated</span>}
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

/** The role × capability matrix, as cards per area. */
async function AccessSection({ canEdit }: { canEdit: boolean }) {
  const matrix = await liveMatrix().catch(() => null);

  if (!matrix || matrix.permissions.length === 0) {
    return (
      <Card>
        <SectionTitle title="Access control" hint="Who can see and do what" />
        <p className="text-[12px] text-amber-400">
          The permission list could not be read just now. Access is still enforced by the database — this screen
          simply cannot show it until the connection recovers.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle
        title="Access control — who can see and do what"
        hint={`${matrix.roles.length} roles · ${matrix.permissions.length} capabilities · changes apply immediately`}
      />
      <AccessControl
        areas={groupIntoAreas(matrix.permissions)}
        byRole={matrix.byRole}
        roles={matrix.roles}
        canEdit={canEdit}
      />
    </Card>
  );
}
