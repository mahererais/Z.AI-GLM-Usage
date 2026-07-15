import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
// Pin Soup 3.0 inline: some systems still have the 2.4 typelib installed, and
// without a version the prefs process (where the shell hasn't already loaded
// Soup) could pick the wrong one.
import Soup from 'gi://Soup?version=3.0';

import {QUOTA_URL, MODEL_USAGE_URL, ENV_KEY, encoder, decoder} from './config.js';

// Minimum gap between two polls. Opening the popup and the poll timer can both
// trigger a refresh; without a floor they can fire back-to-back and the second
// request is rate-limited (429) by the API.
export const MIN_REFRESH_MS = 60 * 1000;

export class UsageError extends Error {
    constructor(message, {status = 0, body = ''} = {}) {
        super(message);
        this.name = 'UsageError';
        this.status = status;
        this.body = body;
    }
}

// Resolves a usable Z.ai API key. Z.ai keys are long-lived bearer tokens, so
// unlike an OAuth flow there is nothing to refresh: we just need to find one.
// Preference key first, then the ZAI_API_KEY environment variable when enabled.
// Returns null when no key is available.
export function resolveApiKey(settings = null) {
    const stored = settings?.get_string('api-key')?.trim();
    if (stored)
        return stored;
    const useEnv = settings ? settings.get_boolean('use-env-key') : true;
    if (useEnv) {
        const env = (GLib.getenv(ENV_KEY) ?? '').trim();
        if (env)
            return env;
    }
    return null;
}

// True when an API key is available (from preferences or the environment). Used
// by prefs to decide whether to nag the user to enter a key.
export function apiKeyAvailable(settings = null) {
    return resolveApiKey(settings) !== null;
}

// Formats a Date as the local-time "YYYY-MM-DD HH:MM:SS" string the model-usage
// endpoint expects (matching the VS Code trackers that target the same API).
function formatLocalDateTime(date) {
    const tz = GLib.TimeZone.new_local();
    const dt = GLib.DateTime.new(tz, date.getFullYear(), date.getMonth() + 1,
        date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds());
    return dt.format('%Y-%m-%d %H:%M:%S');
}

export class ZaiClient {
    constructor(settings = null) {
        this._settings = settings;
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    // Low-level JSON request. `token` is sent as a Bearer header, which both
    // VS Code trackers confirmed works against api.z.ai. Never throws on a
    // non-2xx: rejects with a UsageError carrying the status and body.
    _request(method, url, {token, cancellable = null} = {}) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new(method, url);
            const headers = msg.get_request_headers();
            headers.append('Accept', 'application/json');
            headers.append('Accept-Language', 'en-US,en');
            if (token)
                headers.append('Authorization', `Bearer ${token}`);

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    // Read the raw integer; msg.get_status() marshals to the
                    // Soup.Status enum, which lacks some codes (e.g. 429) and
                    // would throw "N is not a valid value for enumeration Status".
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        reject(new UsageError(`HTTP ${status} from ${url}`, {status, body: text}));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // Returns the current API key, or rejects with a clear "not configured"
    // error so the UI can prompt for setup.
    _key() {
        const key = resolveApiKey(this._settings);
        if (!key)
            throw new UsageError('No Z.ai API key. Add one in the extension settings or export ZAI_API_KEY.');
        return key;
    }

    // The primary quota window, normalized to the shape the UI expects. The
    // raw payload is { success, data: { limits: [ { type, percentage,
    // currentValue, usage, nextResetTime }, ... ] } }; we surface the
    // TOKENS_LIMIT entry. nextResetTime is a Unix-ms timestamp and is
    // converted to an ISO string for the UI's countdown helpers.
    async fetchQuota(cancellable = null) {
        const data = await this._request('GET', QUOTA_URL, {token: this._key(), cancellable});
        // The API returns HTTP 200 even for auth errors, carrying the real code
        // in data.code. Surface it so the UI can show "invalid key" cleanly.
        if (data.success === false)
            throw new UsageError(`Z.ai API error: ${data.msg ?? data.code ?? 'unknown'}`,
                {status: Number(data.code) || 0, body: JSON.stringify(data)});

        const limits = data.data?.limits;
        const arr = Array.isArray(limits) ? limits : [];
        const token = arr.find(l => l && l.type === 'TOKENS_LIMIT') ?? null;
        const resetMs = Number(token?.nextResetTime) || 0;

        const used = token?.currentValue != null ? Number(token.currentValue) : null;
        // The field that holds the limit cap is named "usage" in the payload
        // (confusingly); accept a plain "limit" too in case the schema shifts.
        const limit = token?.usage != null ? Number(token.usage)
            : token?.limit != null ? Number(token.limit) : null;
        let percentage = token?.percentage != null ? Number(token.percentage) : null;
        // If the API omits a percentage but gives used/limit, derive it.
        if ((percentage == null || Number.isNaN(percentage)) && used != null && limit)
            percentage = (used / limit) * 100;
        if (percentage != null)
            percentage = Math.max(0, percentage);

        return {
            percentage,
            used,
            limit,
            resetsAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        };
    }

    // Aggregate model usage over [start, end]: { prompts, tokens }. Used only
    // for the supplementary 7-day stats line, so callers treat failure as
    // non-fatal. Returns null when the payload lacks totalUsage.
    async fetchModelUsage(start, end, cancellable = null) {
        const qs = `?startTime=${encodeURIComponent(formatLocalDateTime(start))}` +
            `&endTime=${encodeURIComponent(formatLocalDateTime(end))}`;
        const data = await this._request('GET', `${MODEL_USAGE_URL}${qs}`, {token: this._key(), cancellable});
        if (data.success === false)
            throw new UsageError(`Z.ai API error: ${data.msg ?? data.code ?? 'unknown'}`,
                {status: Number(data.code) || 0, body: JSON.stringify(data)});
        const total = data.data?.totalUsage;
        if (!total)
            return null;
        return {
            prompts: Number(total.totalModelCallCount) || 0,
            tokens: Number(total.totalTokensUsage) || 0,
        };
    }

    // Convenience: quota plus the last 7 days of model usage, in parallel. The
    // quota is required (its failure is surfaced); the 7-day stats are optional.
    async fetchUsage(cancellable = null) {
        const now = new Date();
        const start7d = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
        const [quotaRes, modelRes] = await Promise.allSettled([
            this.fetchQuota(cancellable),
            this.fetchModelUsage(start7d, now, cancellable),
        ]);
        if (quotaRes.status === 'rejected')
            throw quotaRes.reason;
        if (modelRes.status === 'rejected')
            logError(modelRes.reason, 'zai-usage: 7-day stats fetch failed (non-fatal)');
        return {
            quota: quotaRes.value,
            sevenDay: modelRes.status === 'fulfilled' ? modelRes.value : null,
        };
    }
}
