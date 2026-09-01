import { MessagesView } from "@/components/messaging/messages-view";

export const dynamic = "force-dynamic";

/**
 * Internal staff messaging. All state is client-side because the feature is
 * realtime-first — server rendering the thread would only be immediately
 * replaced by the live subscription.
 */
export default function MessagesPage() {
  return <MessagesView />;
}
