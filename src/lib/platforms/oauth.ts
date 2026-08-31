import type { ChannelId } from "../types";

/**
 * Connect flows.
 *
 * Each entry is everything a person needs to connect a channel: the exact scopes
 * we ask for and why, the authorize URL, and what breaks if the token lapses.
 * Scope lists live here rather than being scattered through the adapters, because
 * "why does this app want that permission?" is a question clients actually ask.
 */

export interface ConnectSpec {
  channel: ChannelId;
  label: string;
  color: string;
  /** What the connection unlocks, in plain words. */
  unlocks: string[];
  scopes: string[];
  /** OAuth authorize endpoint; params filled from env at click time. */
  authorizeUrl: (redirectUri: string) => string;
  envVars: string[];
  /** Extra setup that is not OAuth — webhooks, business verification, etc. */
  notes?: string[];
}

const META_OAUTH = "https://www.facebook.com/v23.0/dialog/oauth";

export const CONNECT_SPECS: ConnectSpec[] = [
  {
    channel: "instagram",
    label: "Instagram",
    color: "#E1306C",
    unlocks: ["Publish feed, reels, stories and carousels", "Read insights", "Pull comments and mentions into the inbox"],
    scopes: ["instagram_basic", "instagram_content_publish", "instagram_manage_insights", "instagram_manage_comments", "pages_show_list"],
    authorizeUrl: (r) =>
      `${META_OAUTH}?client_id=\${META_APP_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&scope=instagram_basic,instagram_content_publish,instagram_manage_insights,instagram_manage_comments,pages_show_list`,
    envVars: ["META_APP_ID", "META_APP_SECRET"],
    notes: ["Requires an Instagram *Business* or *Creator* account linked to a Facebook Page."],
  },
  {
    channel: "facebook",
    label: "Facebook Pages",
    color: "#1877F2",
    unlocks: ["Publish posts, reels and stories", "Native scheduling", "Read page insights", "Comments into the inbox"],
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_manage_engagement", "read_insights", "pages_show_list"],
    authorizeUrl: (r) =>
      `${META_OAUTH}?client_id=\${META_APP_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&scope=pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights`,
    envVars: ["META_APP_ID", "META_APP_SECRET"],
  },
  {
    channel: "whatsapp",
    label: "WhatsApp Business",
    color: "#25D366",
    unlocks: ["Two-way chat in the inbox", "Template broadcasts", "Lead capture straight into the board"],
    scopes: ["whatsapp_business_messaging", "whatsapp_business_management", "business_management"],
    authorizeUrl: (r) =>
      `${META_OAUTH}?client_id=\${META_APP_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&scope=whatsapp_business_messaging,whatsapp_business_management,business_management`,
    envVars: ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN"],
    notes: [
      "Point the Meta webhook at POST /api/webhooks/whatsapp and use WHATSAPP_VERIFY_TOKEN as the verify token.",
      "Free-form replies only work within 24h of the customer's last message; outside that, an approved template is required.",
    ],
  },
  {
    channel: "tiktok",
    label: "TikTok",
    color: "#00F2EA",
    unlocks: ["Publish videos", "Read video analytics", "Comments into the inbox"],
    scopes: ["video.publish", "video.list", "user.info.basic", "comment.list"],
    authorizeUrl: (r) =>
      `https://www.tiktok.com/v2/auth/authorize/?client_key=\${TIKTOK_CLIENT_KEY}&redirect_uri=${encodeURIComponent(r)}&response_type=code&scope=video.publish,video.list,user.info.basic`,
    envVars: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    notes: ["Content posting requires an audited app; unaudited apps can only post to private accounts."],
  },
  {
    channel: "youtube",
    label: "YouTube",
    color: "#FF0000",
    unlocks: ["Upload Shorts", "Schedule via publishAt", "Read analytics", "Comments into the inbox"],
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl", "https://www.googleapis.com/auth/yt-analytics.readonly"],
    authorizeUrl: (r) =>
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=\${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl")}`,
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  },
  {
    channel: "linkedin",
    label: "LinkedIn",
    color: "#0A66C2",
    unlocks: ["Publish organisation posts", "Read follower and post analytics"],
    scopes: ["w_organization_social", "r_organization_social", "rw_organization_admin"],
    authorizeUrl: (r) =>
      `https://www.linkedin.com/oauth/v2/authorization?client_id=\${LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&scope=w_organization_social%20r_organization_social`,
    envVars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  },
  {
    channel: "x",
    label: "X",
    color: "#0F1419",
    unlocks: ["Post tweets and threads", "Read mentions into the inbox"],
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    authorizeUrl: (r) =>
      `https://twitter.com/i/oauth2/authorize?client_id=\${X_CLIENT_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&scope=tweet.read%20tweet.write%20users.read%20offline.access&code_challenge=challenge&code_challenge_method=plain`,
    envVars: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  },
  {
    channel: "google_business",
    label: "Google Business Profile",
    color: "#34A853",
    unlocks: ["Local posts", "Reviews and replies", "Search and Maps insights", "Q&A"],
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    authorizeUrl: (r) =>
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=\${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent("https://www.googleapis.com/auth/business.manage")}`,
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  },
  {
    channel: "meta_ads",
    label: "Meta Ads",
    color: "#0866FF",
    unlocks: ["Campaign, ad set and ad insights", "Budget and status writes", "Boost organic posts"],
    scopes: ["ads_read", "ads_management", "business_management"],
    authorizeUrl: (r) =>
      `${META_OAUTH}?client_id=\${META_APP_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&scope=ads_read,ads_management,business_management`,
    envVars: ["META_APP_ID", "META_APP_SECRET", "META_AD_ACCOUNT_ID"],
  },
  {
    channel: "google_ads",
    label: "Google Ads",
    color: "#FBBC04",
    unlocks: ["Campaign and keyword performance", "Budget changes", "Blended ROAS with Meta"],
    scopes: ["https://www.googleapis.com/auth/adwords"],
    authorizeUrl: (r) =>
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=\${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(r)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent("https://www.googleapis.com/auth/adwords")}`,
    envVars: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET"],
    notes: ["Needs an approved developer token; basic access is enough for a single account."],
  },
];

export function specFor(channel: ChannelId): ConnectSpec | undefined {
  return CONNECT_SPECS.find((s) => s.channel === channel);
}
