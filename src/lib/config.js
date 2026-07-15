// Shared constants and small text-codec helpers, imported by both the usage
// client and the preferences window so the values live in one place. Keep this
// free of `resource:///org/gnome/shell` imports so it stays usable from prefs
// (and plain gjs) as well as the shell.

// Z.ai monitor API base. The coding-plan usage endpoints live under here.
export const BASE_URL = 'https://api.z.ai';

// Quota / limit endpoint: returns the rolling token-quota window (percentage,
// tokens used, the limit, and the next-reset timestamp). This is the primary
// source for the panel ring and percentage.
export const QUOTA_URL = `${BASE_URL}/api/monitor/usage/quota/limit`;

// Model-usage endpoint: takes ?startTime=...&endTime=... (local time,
// "YYYY-MM-DD HH:MM:SS") and returns aggregate prompt/token counts over the
// range. Used for the supplementary 7-day stats line; failures are non-fatal.
export const MODEL_USAGE_URL = `${BASE_URL}/api/monitor/usage/model-usage`;

// Where the "Usage page" button points. Z.ai exposes usage on the chat app.
export const USAGE_DASHBOARD_URL = 'https://chat.z.ai';

// Optional, lower-security fallback used when no key is stored in GNOME Keyring.
export const ENV_KEY = 'ZAI_API_KEY';

// Token-quota window the API reports the limit for. Z.ai's coding plan uses a
// rolling window; this default matches the widely-reported 5-hour quota. Used
// only for the burn-rate projection coloring, never for the percentage itself.
export const DEFAULT_WINDOW_HOURS = 5;

export const decoder = new TextDecoder();
