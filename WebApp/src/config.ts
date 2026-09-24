/**
 * Reminder relay (WebApp/push-worker, deployed to Cloudflare). Empty = push disabled; reminders
 * then only fire while Nexus is open. Filled in after `wrangler deploy`.
 */
export const PUSH_WORKER_URL = 'https://nexus-push.priyanshupradhan0204.workers.dev';

export const APP_VERSION = '3.6';
