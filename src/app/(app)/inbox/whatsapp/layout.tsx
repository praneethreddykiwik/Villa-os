import { getSession } from "@/lib/auth/session";
import { WorkspaceNav } from "@/components/whatsapp-workspace/workspace-nav";

/**
 * The WhatsApp workspace.
 *
 * Everything WhatsApp-related lives under this one tab: the inbox, the
 * assistant's training, and the sales console that grew up around the agent.
 * They used to be three separate sidebar entries pointing at the same subject,
 * one of which opened a second application with its own chrome and its own
 * colours.
 *
 * There is no shell of its own here on purpose — the app layout above already
 * supplies the sidebar, the gate and the dock. This adds only the second-level
 * navigation between the workspace's sections.
 */
export default async function WhatsAppWorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The sidebar above already hides what this account cannot open; the
  // second-level strip has to agree with it, or it re-offers the same locked
  // doors one level down and the click lands on the no-access screen.
  const session = await getSession();

  return (
    <div className="osf-root flex min-h-screen flex-col">
      <WorkspaceNav permissions={session ? [...session.permissions] : []} />
      {/* The ported pages return bare fragments — they relied on the deleted
          console's own <main> for their gutter, so without this they sat flush
          against the sidebar. The gutter tightens on a phone, where 28px of
          padding either side is a fifth of the screen. */}
      <div className="min-h-0 min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6 lg:px-4 sm:px-6 lg:px-7">{children}</div>
    </div>
  );
}
