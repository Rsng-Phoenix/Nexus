/**
 * Reminder relay (WebApp/push-worker, deployed to Cloudflare). Empty = push disabled; reminders
 * then only fire while Nexus is open. Filled in after `wrangler deploy`.
 */
export const PUSH_WORKER_URL: string =
  (import.meta.env.DEV && import.meta.env.VITE_PUSH_WORKER_URL) || 'https://nexus-push.priyanshupradhan0204.workers.dev';

/** One number for every Nexus: the same as the Android app's versionName (app/build.gradle.kts). */
export const APP_VERSION = '4.0';
