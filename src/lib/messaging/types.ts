/** Internal staff messaging. */

export interface MessageProfile {
  id: string;
  fullName: string;
  email: string;
  department?: string | null;
  roleKey?: string | null;
}

export type RecipientType = "user" | "everyone";

export interface Message {
  id: string;
  orgId: string;
  senderId: string;
  recipientType: RecipientType;
  recipientId: string | null;
  /** Raw wire body. Always read through the payload parser, never rendered directly. */
  body: string;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  sender?: MessageProfile;
  recipient?: MessageProfile;
  /** Derived client-side from message_reads. */
  isReadByMe?: boolean;
}

export interface ConversationItem {
  id: string;
  name: string;
  type: RecipientType;
  profile?: MessageProfile;
  lastMessage?: Message;
  unreadCount: number;
}

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
