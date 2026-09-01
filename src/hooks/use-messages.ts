"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { browserClient } from "@/lib/supabase/client";
import {
  PAGE_SIZE, deleteMessage, editMessage, fetchMessages, fetchProfiles, fetchReadIds,
  markRead, mediaUrl, sendMessage, toMessage, toggleReaction, uploadMedia,
} from "@/lib/messaging/api";
import { formatMedia, formatText, type QuotedReply } from "@/lib/messaging/payloads";
import type { ConnectionStatus, ConversationItem, Message, MessageProfile, RecipientType } from "@/lib/messaging/types";

/**
 * Messaging state: profiles, conversations, pagination, realtime, presence and
 * read receipts.
 *
 * Two things worth calling out:
 *
 *  - Realtime INSERTs are merged by id, and the sender also receives their own
 *    broadcast. Sending therefore does *not* append optimistically; it lets the
 *    realtime echo insert the row. That avoids the duplicate-then-dedupe flicker
 *    the naive version produces.
 *  - Read receipts are marked only for the conversation actually on screen, and
 *    only while the tab is visible. Marking everything read on load is how
 *    unread counts stop meaning anything.
 */
export interface UseMessages {
  ready: boolean;
  error: string | null;
  me: MessageProfile | null;
  profiles: MessageProfile[];
  conversations: ConversationItem[];
  activeId: string;
  setActiveId: (id: string) => void;
  messages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  loadOlder: () => Promise<void>;
  send: (text: string, replyTo?: QuotedReply) => Promise<boolean>;
  sendMedia: (file: File, kind: "image" | "voice", caption?: string, durationSec?: number, replyTo?: QuotedReply) => Promise<boolean>;
  sending: boolean;
  react: (messageId: string, emoji: string) => Promise<void>;
  edit: (messageId: string, text: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  unreadTotal: number;
  onlineIds: Set<string>;
  connection: ConnectionStatus;
  resolveMedia: (path: string) => Promise<string | null>;
}

export function useMessages(visible = true): UseMessages {
  const [sb] = useState<SupabaseClient | null>(() => {
    try {
      return browserClient();
    } catch {
      return null;
    }
  });

  const [me, setMe] = useState<MessageProfile | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<MessageProfile[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeId, setActiveId] = useState("everyone");
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connected");
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  /* ---- bootstrap -------------------------------------------------------- */
  useEffect(() => {
    if (!sb) {
      setError("Supabase is not configured.");
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const { data: auth } = await sb.auth.getUser();
        if (!auth.user) {
          setError("Not signed in.");
          setLoading(false);
          return;
        }
        const { data: profile, error: pErr } = await sb
          .from("profiles")
          .select("id, org_id, full_name, email")
          .eq("id", auth.user.id)
          .single();
        if (pErr) throw pErr;
        if (cancelled) return;

        setOrgId(profile.org_id);
        const all = await fetchProfiles(sb);
        const byId = new Map(all.map((p) => [p.id, p]));
        setProfiles(all);
        setMe(byId.get(auth.user.id) ?? null);

        const { messages: page, hasMore: more } = await fetchMessages(sb, byId, { limit: PAGE_SIZE });
        const readIds = await fetchReadIds(sb, auth.user.id, page.map((m) => m.id));
        if (cancelled) return;
        setMessages(page.map((m) => ({ ...m, isReadByMe: m.senderId === auth.user.id || readIds.has(m.id) })));
        setHasMore(more);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sb]);

  /* ---- pagination ------------------------------------------------------- */
  const loadOlder = useCallback(async () => {
    if (!sb || !me || loadingOlder || !hasMore || !messages.length) return;
    setLoadingOlder(true);
    try {
      const { messages: older, hasMore: more } = await fetchMessages(sb, profileById, {
        beforeCreatedAt: messages[0].createdAt,
      });
      const readIds = await fetchReadIds(sb, me.id, older.map((m) => m.id));
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const fresh = older
          .filter((m) => !seen.has(m.id))
          .map((m) => ({ ...m, isReadByMe: m.senderId === me.id || readIds.has(m.id) }));
        return [...fresh, ...prev];
      });
      setHasMore(more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [sb, me, loadingOlder, hasMore, messages, profileById]);

  /* ---- conversations ---------------------------------------------------- */
  const inThread = useCallback(
    (m: Message, otherId: string) => {
      if (m.recipientType !== "user" || !me) return false;
      return (
        (m.senderId === me.id && m.recipientId === otherId) ||
        (m.senderId === otherId && m.recipientId === me.id)
      );
    },
    [me],
  );

  const conversations = useMemo<ConversationItem[]>(() => {
    if (!me) return [];
    const broadcast = messages.filter((m) => m.recipientType === "everyone");
    const list: ConversationItem[] = [
      {
        id: "everyone",
        name: "Everyone",
        type: "everyone",
        lastMessage: broadcast[broadcast.length - 1],
        unreadCount: broadcast.filter((m) => m.senderId !== me.id && !m.isReadByMe).length,
      },
    ];

    for (const p of profiles) {
      if (p.id === me.id) continue;
      const thread = messages.filter((m) => inThread(m, p.id));
      list.push({
        id: p.id,
        name: p.fullName,
        type: "user",
        profile: p,
        lastMessage: thread[thread.length - 1],
        unreadCount: thread.filter((m) => m.senderId !== me.id && !m.isReadByMe).length,
      });
    }

    // Most recent first, but keep people with no history at the bottom rather
    // than interleaved by an absent timestamp.
    return list.sort((a, b) => {
      if (a.id === "everyone") return -1;
      if (b.id === "everyone") return 1;
      const at = a.lastMessage?.createdAt ?? "";
      const bt = b.lastMessage?.createdAt ?? "";
      if (at && bt) return bt.localeCompare(at);
      if (at) return -1;
      if (bt) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [me, profiles, messages, inThread]);

  const visibleMessages = useMemo(() => {
    if (activeId === "everyone") return messages.filter((m) => m.recipientType === "everyone");
    return messages.filter((m) => inThread(m, activeId));
  }, [messages, activeId, inThread]);

  const unreadTotal = useMemo(() => conversations.reduce((a, c) => a + c.unreadCount, 0), [conversations]);

  /* ---- read receipts ---------------------------------------------------- */
  useEffect(() => {
    if (!sb || !me || !visible) return;
    const unread = visibleMessages.filter((m) => m.senderId !== me.id && !m.isReadByMe);
    if (!unread.length) return;
    const ids = unread.map((m) => m.id);
    setMessages((prev) => prev.map((m) => (ids.includes(m.id) ? { ...m, isReadByMe: true } : m)));
    void markRead(sb, me.id, ids).catch(() => {
      /* a failed receipt must not break the thread */
    });
  }, [sb, me, visible, visibleMessages]);

  /* ---- realtime --------------------------------------------------------- */
  useEffect(() => {
    if (!sb || !me) return;
    let channel: RealtimeChannel | null = null;

    channel = sb
      .channel(`messages:${me.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const row = payload.new as Parameters<typeof toMessage>[0];
        const incoming = toMessage(row, profileById);
        const mine = incoming.senderId === me.id;
        const onScreen =
          visibleRef.current &&
          (activeRef.current === "everyone"
            ? incoming.recipientType === "everyone"
            : incoming.senderId === activeRef.current || incoming.recipientId === activeRef.current);

        setMessages((prev) => {
          if (prev.some((m) => m.id === incoming.id)) return prev;
          return [...prev, { ...incoming, isReadByMe: mine || onScreen }];
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (payload) => {
        const row = payload.new as { id: string; body?: string; edited_at?: string; deleted_at?: string };
        setMessages((prev) =>
          row.deleted_at
            ? prev.filter((m) => m.id !== row.id)
            : prev.map((m) => (m.id === row.id ? { ...m, body: row.body ?? m.body, editedAt: row.edited_at } : m)),
        );
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setConnection("connected");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConnection("reconnecting");
        else if (status === "CLOSED") setConnection("disconnected");
      });

    return () => {
      if (channel) void sb.removeChannel(channel);
    };
  }, [sb, me, profileById]);

  /* ---- presence --------------------------------------------------------- */
  useEffect(() => {
    if (!sb || !me) return;
    const channel = sb.channel("presence:staff", { config: { presence: { key: me.id } } });
    channel
      .on("presence", { event: "sync" }, () => setOnlineIds(new Set(Object.keys(channel.presenceState()))))
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ id: me.id, name: me.fullName, at: new Date().toISOString() });
        }
      });
    return () => {
      void channel.untrack();
      void sb.removeChannel(channel);
    };
  }, [sb, me]);

  /* ---- reconnect on regaining focus/network ----------------------------- */
  useEffect(() => {
    if (!sb || !me) return;
    const refresh = async () => {
      try {
        const { messages: page, hasMore: more } = await fetchMessages(sb, profileById, { limit: PAGE_SIZE });
        const readIds = await fetchReadIds(sb, me.id, page.map((m) => m.id));
        setMessages((prev) => {
          const seen = new Map(prev.map((m) => [m.id, m]));
          for (const m of page) {
            seen.set(m.id, { ...m, isReadByMe: m.senderId === me.id || readIds.has(m.id) || seen.get(m.id)?.isReadByMe });
          }
          return [...seen.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        });
        setHasMore(more);
        setConnection("connected");
      } catch {
        setConnection("disconnected");
      }
    };
    const onVisible = () => document.visibilityState === "visible" && refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("offline", () => setConnection("disconnected"));
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sb, me, profileById]);

  /* ---- actions ---------------------------------------------------------- */
  const dispatch = useCallback(
    async (body: string): Promise<boolean> => {
      if (!sb || !me || !orgId) return false;
      setSending(true);
      setError(null);
      try {
        await sendMessage(sb, {
          orgId,
          senderId: me.id,
          recipientType: activeId === "everyone" ? "everyone" : ("user" as RecipientType),
          recipientId: activeId === "everyone" ? null : activeId,
          body,
        });
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      } finally {
        setSending(false);
      }
    },
    [sb, me, orgId, activeId],
  );

  const send = useCallback(
    (text: string, replyTo?: QuotedReply) => {
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve(false);
      return dispatch(formatText(trimmed, replyTo));
    },
    [dispatch],
  );

  const sendMedia = useCallback(
    async (file: File, kind: "image" | "voice", caption?: string, durationSec?: number, replyTo?: QuotedReply) => {
      if (!sb || !orgId) return false;
      setSending(true);
      try {
        const path = await uploadMedia(sb, orgId, file, file.name || `${kind}.bin`);
        return await dispatch(formatMedia({ kind, media: path, caption, durationSec, replyTo }));
      } catch (e) {
        setError((e as Error).message);
        return false;
      } finally {
        setSending(false);
      }
    },
    [sb, orgId, dispatch],
  );

  const react = useCallback(
    async (messageId: string, emoji: string) => {
      if (!sb) return;
      try {
        await toggleReaction(sb, messageId, emoji);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [sb],
  );

  const edit = useCallback(
    async (messageId: string, text: string) => {
      if (!sb) return;
      try {
        await editMessage(sb, messageId, formatText(text));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [sb],
  );

  const remove = useCallback(
    async (messageId: string) => {
      if (!sb) return;
      try {
        await deleteMessage(sb, messageId);
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [sb],
  );

  const resolveMedia = useCallback(async (path: string) => (sb ? mediaUrl(sb, path) : null), [sb]);

  return {
    ready: Boolean(sb && me),
    error,
    me,
    profiles,
    conversations,
    activeId,
    setActiveId,
    messages: visibleMessages,
    loading,
    loadingOlder,
    hasMore,
    loadOlder,
    send,
    sendMedia,
    sending,
    react,
    edit,
    remove,
    unreadTotal,
    onlineIds,
    connection,
    resolveMedia,
  };
}
