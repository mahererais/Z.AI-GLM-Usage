import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {BASE_URL, QUOTA_URL, MODEL_USAGE_URL, decoder} from './config.js';
import {resolveApiKey, apiKeyAvailable} from './secretStore.js';

export {resolveApiKey, apiKeyAvailable} from './secretStore.js';

// Minimum gap between two polls. Opening the popup and the poll timer can both
// trigger a refresh; without a floor they can fire back-to-back and the second
// request is rate-limited (429) by the API.
export const MIN_REFRESH_MS = 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class UsageError extends Error {
    constructor(message, {status = 0} = {}) {
        super(message);
        this.name = 'UsageError';
        this.status = status;
    }
}

// Formats a Date as the local-time "YYYY-MM-DD HH:MM:SS" string the model-usage
// endpoint expects (matching the VS Code trackers that target the same API).
function formatLocalDateTime(date) {
    const tz = GLib.TimeZone.new_local();
    const dt = GLib.DateTime.new(tz, date.getFullYear(), date.getMonth() + 1,
        date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds());
    return dt.format('%Y-%m-%d %H:%M:%S');
}

function apiErrorMessage(data) {
    const raw = data?.msg ?? data?.code ?? 'unknown';
    return String(raw).replace(/[\r\n\t]+/g, ' ').slice(0, 200);
}

export class ZaiClient {
    constructor(settings = null) {
        this._settings = settings;
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    destroy() {
        this._session.abort();
    }

    // Low-level JSON request. `token` is sent as a Bearer header, which both
    // VS Code trackers confirmed works against api.z.ai. Never throws on a
    // non-2xx: rejects with a UsageError carrying only the status. Raw server
    // bodies are deliberately not retained or logged.
    _request(method, url, {token, cancellable = null} = {}) {
        return new Promise((resolve, reject) => {
            if (!url.startsWith(`${BASE_URL}/`)) {
                reject(new UsageError('Refusing to send credentials to an unexpected host.'));
                return;
            }

            const msg = Soup.Message.new(method, url);
            // Bearer credentials must never be replayed to a redirect target.
            msg.add_flags(Soup.MessageFlags.NO_REDIRECT);
            const headers = msg.get_request_headers();
            headers.append('Accept', 'application/json');
            headers.append('Accept-Language', 'en-US,en');
            if (token)
                headers.append('Authorization', `Bearer ${token}`);

            const requestCancellable = new Gio.Cancellable();
            let parentCancelId = 0;
            let responseBytes = 0;
            let responseTooLarge = false;
            let invalidContentType = false;

            if (cancellable) {
                if (cancellable.is_cancelled())
                    requestCancellable.cancel();
                else
                    parentCancelId = cancellable.connect(() => requestCancellable.cancel());
            }

            const rejectOversize = () => {
                responseTooLarge = true;
                requestCancellable.cancel();
            };

            msg.connect('got-headers', () => {
                const responseHeaders = msg.get_response_headers();
                const contentLength = Number(responseHeaders.get_content_length());
                if (contentLength > MAX_RESPONSE_BYTES)
                    rejectOversize();

                const contentType = (responseHeaders.get_one('Content-Type') ?? '')
                    .split(';', 1)[0].trim().toLowerCase();
                const isJson = contentType === 'application/json' || contentType.endsWith('+json');
                if (contentType && !isJson) {
                    invalidContentType = true;
                    requestCancellable.cancel();
                }
            });
            msg.connect('got-body-data', (_message, chunkSize) => {
                responseBytes += Number(chunkSize);
                if (responseBytes > MAX_RESPONSE_BYTES)
                    rejectOversize();
            });

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, requestCancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    // Read the raw integer; msg.get_status() marshals to the
                    // Soup.Status enum, which lacks some codes (e.g. 429) and
                    // would throw "N is not a valid value for enumeration Status".
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        reject(new UsageError(`HTTP ${status} from Z.ai`, {status}));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    if (responseTooLarge)
                        reject(new UsageError('Z.ai response exceeded the 1 MiB safety limit.'));
                    else if (invalidContentType)
                        reject(new UsageError('Z.ai returned an unexpected non-JSON response.'));
                    else
                        reject(e);
                } finally {
                    if (cancellable && parentCancelId)
                        cancellable.disconnect(parentCancelId);
                }
            });
        });
    }

    // Returns the current API key, or rejects with a clear "not configured"
    // error so the UI can prompt for setup.
    async _key(cancellable = null) {
        const key = await resolveApiKey(this._settings, cancellable);
        if (!key)
            throw new UsageError('No Z.ai API key. Add one in the extension settings.');
        return key;
    }

    // Normalize one raw limit entry into the shape the UI expects. The raw
    // payload is { type, percentage, currentValue, usage, nextResetTime }.
    // The field that holds the limit cap is named "usage" in the payload
    // (confusingly); accept a plain "limit" too in case the schema shifts.
    // nextResetTime is a Unix-ms timestamp, converted to an ISO string for the
    // UI's countdown helpers.
    _normalizeLimit(l) {
        if (!l)
            return null;
        const resetMs = Number(l.nextResetTime) || 0;
        const used = l.currentValue != null ? Number(l.currentValue) : null;
        const limit = l.usage != null ? Number(l.usage)
            : l.limit != null ? Number(l.limit) : null;
        let percentage = l.percentage != null ? Number(l.percentage) : null;
        // If the API omits a percentage but gives used/limit, derive it.
        if ((percentage == null || Number.isNaN(percentage)) && used != null && limit)
            percentage = (used / limit) * 100;
        if (percentage != null)
            percentage = Math.max(0, Math.min(100, percentage));
        return {
            percentage,
            used,
            limit,
            resetsAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        };
    }

    // The primary quota window, normalized to the shape the UI expects. Two
    // payload shapes are supported:
    //  - Legacy: a single TOKENS_LIMIT entry tracking raw tokens.
    //  - Coding plan (credits, e.g. Lite): several CREDIT_LIMIT entries, one
    //    per rolling window (5-hour, weekly). The shortest window drives the
    //    panel ring; the longest is surfaced as `weekly` for the popup.
    async fetchQuota(cancellable = null, apiKey = null) {
        const key = apiKey ?? await this._key(cancellable);
        const data = await this._request('GET', QUOTA_URL, {token: key, cancellable});
        // The API returns HTTP 200 even for auth errors, carrying the real code
        // in data.code. Surface it so the UI can show "invalid key" cleanly.
        if (data.success === false)
            throw new UsageError(`Z.ai API error: ${apiErrorMessage(data)}`,
                {status: Number(data.code) || 0});

        const limits = data.data?.limits;
        const arr = Array.isArray(limits) ? limits : [];
        const legacy = arr.find(l => l && l.type === 'TOKENS_LIMIT') ?? null;
        const credits = arr
            .filter(l => l && l.type === 'CREDIT_LIMIT')
            .map(l => ({entry: this._normalizeLimit(l), reset: Number(l.nextResetTime) || 0}))
            .filter(c => c.entry && (c.entry.percentage != null || c.entry.used != null))
            .sort((a, b) => a.reset - b.reset);

        const primary = legacy
            ? {...this._normalizeLimit(legacy), unit: 'tokens'}
            : credits.length
                ? {...credits[0].entry, unit: 'credits'}
                : null;
        if (!primary)
            return {percentage: null, used: null, limit: null, resetsAt: null,
                unit: 'tokens', weekly: null};

        // Longest credit window (e.g. the weekly one) for the popup detail.
        let weekly = null;
        if (!legacy && credits.length > 1) {
            const w = credits[credits.length - 1].entry;
            weekly = {percentage: w.percentage, used: w.used, limit: w.limit,
                resetsAt: w.resetsAt};
        }

        return {
            percentage: primary.percentage,
            used: primary.used,
            limit: primary.limit,
            resetsAt: primary.resetsAt,
            unit: primary.unit,
            weekly,
        };
    }

    // Aggregate model usage over [start, end]: { prompts, tokens }. Used only
    // for the supplementary 7-day stats line, so callers treat failure as
    // non-fatal. Returns null when the payload lacks totalUsage.
    async fetchModelUsage(start, end, cancellable = null, apiKey = null) {
        const qs = `?startTime=${encodeURIComponent(formatLocalDateTime(start))}` +
            `&endTime=${encodeURIComponent(formatLocalDateTime(end))}`;
        const key = apiKey ?? await this._key(cancellable);
        const data = await this._request('GET', `${MODEL_USAGE_URL}${qs}`, {token: key, cancellable});
        if (data.success === false)
            throw new UsageError(`Z.ai API error: ${apiErrorMessage(data)}`,
                {status: Number(data.code) || 0});
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
        const apiKey = await this._key(cancellable);
        const [quotaRes, modelRes] = await Promise.allSettled([
            this.fetchQuota(cancellable, apiKey),
            this.fetchModelUsage(start7d, now, cancellable, apiKey),
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
