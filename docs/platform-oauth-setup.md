# Platform OAuth setup — YouTube Analytics, Instagram Insights, Meta Ads, WhatsApp

Upload-Post publishes to Instagram, YouTube, Facebook, LinkedIn and Google Business with one key,
but it exposes **no analytics**. Impressions, reach, click-through and comment moderation come only
from each platform's own API, which needs an OAuth app owned by you. This is what to create, once.

## 1. Google — YouTube impressions / CTR / comments, Google Business, YouTube upload (native)

What you get: YouTube Analytics (impressions, CTR, watch time, traffic sources), YouTube comments
via the owner account, Google Business Profile reviews. Public views/likes/comment counts already
work with the API key.

1. Open https://console.cloud.google.com → pick or create a project (use the one that owns your
   existing API key so quotas are shared).
2. **APIs & Services → Library** → enable: *YouTube Data API v3*, *YouTube Analytics API*,
   *YouTube Reporting API*, *My Business Business Information API*, *My Business Account Management API*.
3. **APIs & Services → OAuth consent screen** → External → App name "Glentree", support email,
   developer email. Scopes → add:
   - `https://www.googleapis.com/auth/youtube.readonly`
   - `https://www.googleapis.com/auth/yt-analytics.readonly`
   - `https://www.googleapis.com/auth/youtube.upload` (only if you want native uploads)
   - `https://www.googleapis.com/auth/business.manage` (Google Business)
   Add your Google account under **Test users** while the app is in Testing (no verification needed
   for your own channel).
4. **Credentials → Create credentials → OAuth client ID** → Web application.
   Authorised redirect URIs — add BOTH:
   - `http://localhost:4321/api/connections/callback`
   - `https://<your-production-domain>/api/connections/callback`
5. Copy Client ID and Client secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```
6. Restart the app, open **/connections → YouTube → Connect**, sign in with the channel owner
   account and approve. The native token is stored server-side; the YouTube tab then shows
   impressions and CTR next to the public figures.

Note: "Testing" mode tokens expire after 7 days. Publish the consent screen (no verification
required if only you use it, but Google shows an "unverified app" warning) to get long-lived
refresh tokens.

## 2. Meta — Instagram Insights, Facebook Page insights, comments/DMs, Meta Ads, WhatsApp

Your Meta app (ID 1517108826766915) already has every scope. Two things are missing.

**a) Give the system user a Page.** Business Manager → Business settings → Users → System users →
your system user → **Assign assets → Pages** → pick the Facebook Page linked to the
`kiwik.one1` Instagram account → grant *Manage Page* (full control). Do the same under
**Instagram accounts** and **Ad accounts** (Kiwik Ads is already there).
Without this, `/me/accounts` returns an empty list and Instagram/Facebook cannot resolve a Page.

**b) Add the OAuth redirect.** developers.facebook.com → your app → **Facebook Login → Settings →
Valid OAuth Redirect URIs**:
- `http://localhost:4321/api/connections/callback`
- `https://<your-production-domain>/api/connections/callback`

Then in the app: **/connections → Instagram → Connect** (approve in the popup as an admin of the
Page), same for **Facebook Pages**, **Meta Ads**, **WhatsApp Business**. Native connections replace
the Upload-Post rows for insights while Upload-Post keeps publishing.

Instagram requirements: the Instagram account must be a **Business or Creator** account and linked
to the Facebook Page (Instagram app → Settings → Business tools → Connect a Facebook Page).

**WhatsApp live checklist**
1. WhatsApp Manager → Phone numbers → add your business number, complete verification.
2. Put its *Phone number ID* in `WHATSAPP_PHONE_NUMBER_ID` (today it is Meta's test number).
3. App dashboard → WhatsApp → Configuration → Callback URL
   `https://<your-domain>/api/webhooks/whatsapp`, Verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe
   to `messages`. The app answers the handshake and verifies every payload signature.
4. Create at least one approved **message template** (Business Manager → WhatsApp → Message
   templates) for follow-ups outside the 24-hour window.

## 3. LinkedIn (organisation analytics) — optional
https://www.linkedin.com/developers → Create app → Products: *Community Management API* (requires
approval) → Auth → redirect URIs as above → `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
Upload-Post already publishes to LinkedIn; this is only for post analytics.

## 4. TikTok / X — paused
Link them on upload-post.com when ready; the app's Connect button will pick them up.
