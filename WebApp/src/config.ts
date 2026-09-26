/**
 * Reminder relay (WebApp/push-worker, deployed to Cloudflare). Empty = push disabled; reminders
 * then only fire while Nexus is open. Filled in after `wrangler deploy`.
 */
export const PUSH_WORKER_URL: string =
  (import.meta.env.DEV && import.meta.env.VITE_PUSH_WORKER_URL) || 'https://nexus-push.priyanshupradhan0204.workers.dev';

/** One number for every Nexus: the same as the Android app's versionName (app/build.gradle.kts). */
export const APP_VERSION = '5.0';

/**
 * Google Picker: lets you choose an org-restricted Google Sheet once so Nexus may read it with the
 * non-sensitive `drive.file` scope (import/picker.ts). Empty = the Picker is off; a private sheet
 * then needs the "Anyone with the link" sharing. To create the key (free, no verification):
 * Google Cloud console → APIs & Services → Library → enable "Google Picker API" → Credentials →
 * Create credentials → API key → restrict it to the Google Picker API and to the HTTP referrers of
 * the site (the deployed origin, plus http://localhost:* for dev). It is a browser key: public by
 * design, it only names the project.
 */
export const GOOGLE_PICKER_API_KEY = '';

/** The Cloud project number (the prefix of sync/auth.ts GOOGLE_CLIENT_ID); the Picker needs it to grant drive.file per file. */
export const GOOGLE_PROJECT_NUMBER = '273347997748';
