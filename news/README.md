# Chris Cerney News — first release

Public feed: `/news/`. Owner publishing desk: `/admin/news/` (existing website admin password).

## Publishing

1. Create a post, add a headline and reporting, and select photos/videos.
2. Uploads go directly to the existing private Google Cloud Storage bucket. The editor accepts up to 10 files, 30 MiB per image and 2 GiB per video. JPEG, PNG, WebP, AVIF, MP4 and WebM are supported. Use H.264 MP4 with AAC audio for broad device compatibility. Original bytes are preserved; this release does not transcode video.
3. Save a private draft, publish now, or select a future date in the device's time zone. Publication dates are stored in UTC. Due posts are visible when read; no open editor or background browser is required.
4. Optionally select email notification. Confirmed members who opted in before publication receive one notification. Repeated edits do not resend the same post. The five-minute job retries temporary errors, uses provider idempotency keys and pauses ambiguous retries after 23 hours. It considers posts published within the preceding seven days. Failed jobs can be inspected in the private delivery records; an owner-facing delivery queue is not included yet.
5. To unpublish, open the post and save it as a draft. Feed caches can retain metadata for up to 15 seconds. Previously issued media links can remain usable for up to 15 minutes.

## Member experience

Free email-link accounts, optional email updates, private saved stories, account deletion, search, photo/video filters, share links, fullscreen playback, RSS, and a web app manifest. No payment or public-contributor account is created. Comment threads, likes, follow graphs, live broadcasting, adaptive video streaming, automatic captions and native apps are future work.

The site starts with an empty feed. No news articles, personal tip submissions, synthetic tests or social posts were automatically published. The existing portfolio remains accessible.

## Automated draft import

`scripts/news-import.mjs` accepts a package JSON and uploads local media as a **private draft**. It uses the existing admin login through `NEWS_ADMIN_PASSWORD` in a secure process environment. Never put that password in a command saved to shell history, the package JSON, source control or logs.

Run `node scripts/news-import.mjs /absolute/path/to/package.json` after supplying the password securely to the process environment.

Package schema (illustrative values only):

```json
{
  "sourceId": "stable-unique-production-job-id",
  "title": "Your reviewed headline",
  "caption": "Your reporting and context",
  "location": "The story's location",
  "topic": "Community",
  "media": [{"file": "relative/path/report.mp4", "alt": "Description of the video"}]
}
```

A stable sourceId prevents duplicate posts. Existing imports are left unchanged. The helper does not read private tips or fetch arbitrary remote media. It is ready to connect to a production pipeline; the separate Mac reporting workflow has not been modified or scheduled by this release.

## Data and runtime

- Vercel: `api/news.js` authenticates admin cookies, validates origin and signs requests to Firebase. Public GETs expose only published posts/RSS.
- Firebase: `newsApi`, `newsMedia`, `sendNewsUpdates` in project `tip-line-8c2d7`, region `us-west1`.
- Private records: `_news/v1/` in the existing bucket; default storage rules remain deny-all for that prefix. Catalog writes use generation preconditions and revision conflicts. Media is immutable per upload and pinned to its verified storage generation.
- Media delivery checks publication or a short-lived owner preview signature, then redirects to a 15-minute signed Storage URL. Range requests and originals bypass Vercel and function response-size limits.
- Secrets reused by name: `TIP_ALERTS_PROXY_SECRET`, `SPONSORSHIP_RESEND_API_KEY`. No secret values belong in this repository. News uses its own request scope and separate data prefix.
- Email sender: `Chris Cerney <news@bookings.chriscerney.org>` on the existing verified sending domain. Reply-to: `cerneymedia@gmail.com`.
- Sign-in links expire in 15 minutes. Member session cookies are HttpOnly, Secure, SameSite=Strict, scoped to `/api/news`, and valid for 30 days. Email preferences are never silently re-enabled by login.
- The private export includes post metadata and member addresses/preferences. Original media files remain in Cloud Storage; this export is not a complete media backup.

## Operating limits and follow-up

This release caps the catalog at 1,000 posts, the member listing at 5,000 records, saved stories at 500 per member, and update delivery at 20 attempts per five-minute run. These are bounded first-release limits, not a large-scale streaming architecture. Choose a dedicated streaming/transcoding provider and database indexing before substantial growth. Provider sending/storage quotas and costs still apply.

Sign-in and session records currently remain after expiry; they are rejected after expiry but not yet purged automatically. Account deletion removes active email/saved-story data and leaves a technical tombstone. Old sign-in/delivery records and provider backups can retain historical information as stated in the privacy notice. Add explicit retention/cleanup and backup verification as the audience grows. Interrupted abandoned media uploads are not automatically garbage-collected.

The public app manifest supports adding the site to a home screen where the browser allows it. There is no offline media cache or push-notification service in this release. Native mobile apps will need their own authentication handoff and distribution work.

## Verification

Run `node --test tests/*.test.js tests/news/*.test.js functions/*.test.js upload/upload.test.cjs submit-story/submit-story.test.cjs` after installing the locked dependencies in `functions/`.

Tests cover publication visibility, revision conflicts, concurrent writes, uploads, account consent, one-time link replay/retry, private saves, account deletion, notification consent/deduplication, RSS escaping, origin enforcement and gateway trust boundaries. Desktop and phone-width browser checks cover the editor and member flow. Physical iPhone/Android capture and multi-hour 2 GiB mobile uploads require separate device testing.
