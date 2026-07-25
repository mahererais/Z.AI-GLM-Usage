import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ZaiClient, UsageError, MIN_REFRESH_MS} from './lib/zaiClient.js';
import {USAGE_DASHBOARD_URL, DEFAULT_WINDOW_HOURS} from './lib/config.js';

const TRACK_WIDTH = 300;
const RING_SIZE = 18;
const RING_WIDTH = 3;
const PANEL_BAR_WIDTH = 34;

// Severity levels, least to most severe.
const LEVEL_RANK = {ok: 0, warn: 1, crit: 2};

// Severity from a raw utilization %: how full the bucket is right now.
function utilLevel(util) {
    if (util >= 90)
        return 'crit';
    if (util >= 75)
        return 'warn';
    return 'ok';
}

function maxLevel(a, b) {
    return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

function levelClass(level) {
    return `zu-${level}`;
}

// RGB triple for a level, for Cairo painting.
function levelRgb(level) {
    if (level === 'crit')
        return [0.88, 0.11, 0.14]; // #e01b24
    if (level === 'warn')
        return [1.0, 0.47, 0.0];   // #ff7800
    return [0.2, 0.82, 0.48];      // #33d17a
}

// StThemeNode colors are Cogl.Color. Across GNOME 48-50 the components come
// back either as 0-255 bytes or as 0-1 floats depending on the GJS build, so
// detect the scale instead of assuming one. Returns an [r, g, b] float triple.
function colorRgb(c) {
    const scale = Math.max(c.red, c.green, c.blue) > 1 ? 255 : 1;
    return [c.red / scale, c.green / scale, c.blue / scale];
}

// Projected end-of-window utilization at the current consumption rate. Returns
// the larger of actual and projected, falling back to actual when the window
// has barely started (too little signal) or reports no reset time.
function projectedUtil(util, resetsAtIso, totalSeconds) {
    const target = Date.parse(resetsAtIso ?? '');
    if (Number.isNaN(target) || !totalSeconds)
        return util;
    const remaining = (target - Date.now()) / 1000;
    if (remaining <= 0)
        return util;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return util;
    return Math.max(util, (util * totalSeconds) / elapsed);
}

// Seconds from now until utilization would hit 100% at the average rate so far
// this window, but only when that exhaustion lands before the window resets.
// Returns null otherwise (with the same early-window guard as projectedUtil).
function exhaustSeconds(util, resetsAtIso, totalSeconds) {
    const target = Date.parse(resetsAtIso ?? '');
    if (Number.isNaN(target) || !totalSeconds || util <= 0)
        return null;
    const remaining = (target - Date.now()) / 1000;
    if (remaining <= 0)
        return null;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return null;
    const toExhaust = (elapsed * (100 - util)) / util;
    return toExhaust > 0 && toExhaust < remaining ? toExhaust : null;
}

// Human-friendly duration trimmed to the two largest units: "30s", "45m",
// "4h 21m", "2d 5h". sep sets what goes between the two units, e.g. '' for the
// compact panel form ("4h21m").
function humanDuration(seconds, sep = ' ') {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60)
        return `${s}s`;
    const mins = Math.round(s / 60);
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h${sep}${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d${sep}${hrs % 24}h`;
}

// Being locked out for at least this fraction of the window makes a fast burn
// "critical" (red). A shorter lockout (running out just before the reset) only
// warrants a warning (amber).
const LOCKOUT_CRIT_FRAC = 0.10;

function lockoutSeconds(util, resetsAtIso, totalSeconds) {
    const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds);
    if (exhaust === null)
        return null;
    const remaining = (Date.parse(resetsAtIso) - Date.now()) / 1000;
    return Math.max(0, remaining - exhaust);
}

// Severity for the quota window, based on the *consequence* of the current
// burn rather than the raw projected percentage.
function windowLevel(util, resetsAtIso, totalSeconds) {
    let level = utilLevel(util);
    const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds);
    if (lockout !== null) {
        const projLevel = lockout >= totalSeconds * LOCKOUT_CRIT_FRAC ? 'crit' : 'warn';
        level = maxLevel(level, projLevel);
    } else {
        if (projectedUtil(util, resetsAtIso, totalSeconds) >= 75)
            level = maxLevel(level, 'warn');
    }
    return level;
}

function projectionNote(util, resetsAtIso, totalSeconds) {
    const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds);
    if (lockout !== null) {
        if (lockout >= totalSeconds * LOCKOUT_CRIT_FRAC) {
            const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds);
            return `burning fast — out in ~${humanDuration(exhaust)} at this rate`;
        }
        return 'on pace to run out just before reset';
    }
    const proj = projectedUtil(util, resetsAtIso, totalSeconds);
    if (proj >= 75 && Math.round(proj) > Math.round(util))
        return `on track for ~${Math.round(proj)}% by reset`;
    return '';
}

function relativeReset(iso) {
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'resetting…';
    if (diff < 60000)
        return `resets in ${Math.floor(diff / 1000)}s`;
    const mins = Math.round(diff / 60000);
    if (mins < 60)
        return `resets in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `resets in ${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `resets in ${days}d ${hrs % 24}h`;
}

// Compact "time until reset" for the panel: magnitude only, no prefix.
function compactReset(iso) {
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'now';
    return humanDuration(diff / 1000, '');
}

// Let a fixed-width popup label wrap onto extra lines instead of running off
// the edge. Returns the label for chaining.
function wrapLabel(label) {
    label.x_expand = true;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function formatTokens(n) {
    if (n == null || Number.isNaN(n))
        return '—';
    // Compact grouping: 1 234 567.
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// A labelled progress meter: title + percentage row, bar, and reset caption.
class Meter {
    constructor(name) {
        this.root = new St.BoxLayout({vertical: true, style_class: 'zu-meter'});

        const row = new St.BoxLayout({style_class: 'zu-meter-row'});
        this._name = new St.Label({text: name, style_class: 'zu-meter-name', x_expand: true});
        this._pct = new St.Label({text: '—', style_class: 'zu-meter-pct'});
        row.add_child(this._name);
        row.add_child(this._pct);

        this._track = new St.BoxLayout({style_class: 'zu-track'});
        this._fill = new St.Widget({style_class: 'zu-fill zu-ok'});
        this._track.add_child(this._fill);

        this._caption = wrapLabel(new St.Label({text: '', style_class: 'zu-caption'}));

        this.root.add_child(row);
        this.root.add_child(this._track);
        this.root.add_child(this._caption);
    }

    // The bar width tracks `displayUtil`; level drives the color, so projection
    // can tint without resizing.
    setValue(displayUtil, caption, level = utilLevel(displayUtil)) {
        this._pct.text = `${Math.round(displayUtil)}%`;
        this._fill.set_width(Math.round((Math.max(0, Math.min(100, displayUtil)) / 100) * TRACK_WIDTH));
        this._fill.style_class = `zu-fill ${levelClass(level)}`;
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    setMuted() {
        this._pct.text = '—';
        this._fill.set_width(0);
        this._caption.visible = false;
    }

    destroy() {
        this._name?.destroy();
        this._pct?.destroy();
        this._fill?.destroy();
        this._caption?.destroy();
        this._track?.destroy();
        this.root?.destroy();
        this._name = null;
        this._pct = null;
        this._fill = null;
        this._caption = null;
        this._track = null;
        this.root = null;
    }
}

// A compact circular usage gauge for the panel, drawn with Cairo.
const Ring = GObject.registerClass(
class Ring extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'zu-ring',
            width: RING_SIZE,
            height: RING_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._util = null;
        this._color = null;
    }

    setValue(util, level = utilLevel(util)) {
        this._util = Math.max(0, Math.min(100, util));
        this._color = levelRgb(level);
        this.queue_repaint();
    }

    setUnknown() {
        this._util = null;
        this._color = null;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) / 2 - RING_WIDTH / 2;
        const start = -Math.PI / 2;

        cr.setLineWidth(RING_WIDTH);
        cr.setLineCap(Cairo.LineCap.ROUND);

        const [fr, fg, fb] = colorRgb(this.get_theme_node().get_foreground_color());
        cr.setSourceRGBA(fr, fg, fb, 0.22);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._util !== null && this._util > 0) {
            const [r, g, b] = this._color ?? levelRgb(utilLevel(this._util));
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(cx, cy, radius, start, start + (this._util / 100) * 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
    }
});

// A compact horizontal usage bar for the panel.
class PanelBar {
    constructor() {
        this.root = new St.BoxLayout({
            style_class: 'zu-panel-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'zu-panel-bar-fill'});
        this.root.add_child(this._fill);
    }

    setValue(util, level = utilLevel(util)) {
        const clamped = Math.max(0, Math.min(100, util));
        this._fill.set_width(Math.round((clamped / 100) * PANEL_BAR_WIDTH));
        this._fill.style_class = `zu-panel-bar-fill ${levelClass(level)}`;
    }

    setUnknown() {
        this._fill.set_width(0);
        this._fill.style_class = 'zu-panel-bar-fill';
    }

    destroy() {
        this._fill?.destroy();
        this.root?.destroy();
        this._fill = null;
        this.root = null;
    }
}

const ZaiUsageIndicator = GObject.registerClass(
class ZaiUsageIndicator extends PanelMenu.Button {
    _init(path, settings, openPreferences) {
        super._init(0.5, 'Z.ai GLM Usage Monitor');

        this._path = path;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._client = new ZaiClient(settings);
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._lastUsage = null;
        this._lastFetchMs = 0;
        this._countdownTimer = null;

        // ---- panel button ----
        const box = new St.BoxLayout({style_class: 'zu-panel'});
        this._panelIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${path}/icons/zai-logo.svg`),
            style_class: 'zu-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ring = new Ring();
        this._panelBar = new PanelBar();
        this._panelPct = new St.Label({text: '…', style_class: 'zu-panel-pct', y_align: Clutter.ActorAlign.CENTER});
        this._panelReset = new St.Label({text: '', style_class: 'zu-panel-reset', y_align: Clutter.ActorAlign.CENTER});
        this._panelLabel = new St.Label({text: '', style_class: 'zu-panel-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._panelIcon);
        box.add_child(this._ring);
        box.add_child(this._panelBar.root);
        box.add_child(this._panelPct);
        box.add_child(this._panelReset);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();

        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        }, this);

        // Live-apply preference changes without needing a shell reload.
        this._settings.connectObject(
            'changed::show-icon', () => this._applyVisibility(),
            'changed::panel-gauge', () => this._applyVisibility(),
            'changed::show-percentage', () => this._applyVisibility(),
            'changed::show-reset', () => this._applyVisibility(),
            'changed::show-remaining', () => this._renderPanel(),
            'changed::plan-label', () => this._applyLabel(),
            'changed::api-key', () => this._refresh(true),
            'changed::credential-generation', () => this._refresh(true),
            'changed::use-env-key', () => this._refresh(true),
            this);

        this._applyVisibility();
        this._applyLabel();
        this._refresh();
        this._startTimer();
    }

    _startTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        const seconds = this._settings.get_int('poll-seconds');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _applyVisibility() {
        this._panelIcon.visible = this._settings.get_boolean('show-icon');
        const gauge = this._settings.get_string('panel-gauge');
        this._ring.visible = gauge === 'ring';
        this._panelBar.root.visible = gauge === 'bar';
        this._panelPct.visible = this._settings.get_boolean('show-percentage');
        this._panelReset.visible = this._settings.get_boolean('show-reset');
        this._panelLabel.visible = !!this._settings.get_string('plan-label')?.trim();
    }

    _applyLabel() {
        const label = (this._settings.get_string('plan-label') ?? '').trim();
        this._panelLabel.text = label;
        this._pill.text = label || 'GLM';
    }

    _windowSeconds() {
        const hours = this._settings.get_double('window-hours') || DEFAULT_WINDOW_HOURS;
        return Math.max(1, hours) * 3600;
    }

    _buildMenu() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const root = new St.BoxLayout({vertical: true, style_class: 'zu-popup'});
        item.add_child(root);
        this.menu.addMenuItem(item);

        // header
        const header = new St.BoxLayout({style_class: 'zu-header'});
        const logo = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._path}/icons/zai-logo.svg`),
            style_class: 'zu-logo',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const who = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({text: 'Z.ai', style_class: 'zu-title'});
        this._subtitle = new St.Label({text: 'GLM usage', style_class: 'zu-subtitle'});
        who.add_child(this._title);
        who.add_child(this._subtitle);
        this._pill = new St.Label({text: 'GLM', style_class: 'zu-pill', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(logo);
        header.add_child(who);
        header.add_child(this._pill);
        root.add_child(header);

        // quota section
        this._sectionLabel(root, 'Token quota');
        this._quota = new Meter('Token quota');
        root.add_child(this._quota.root);

        this._stats = wrapLabel(new St.Label({text: '', style_class: 'zu-stats'}));
        root.add_child(this._stats);

        this._error = wrapLabel(new St.Label({text: '', style_class: 'zu-error'}));
        this._error.visible = false;
        root.add_child(this._error);

        // actions
        const actions = new St.BoxLayout({style_class: 'zu-actions'});
        const openUsage = new St.Button({label: 'Usage page', style_class: 'zu-btn zu-btn-pri', x_expand: true});
        openUsage.connect('clicked', () => {
            this.menu.close();
            Gio.AppInfo.launch_default_for_uri(USAGE_DASHBOARD_URL, null);
        });
        actions.add_child(openUsage);
        root.add_child(actions);

        // footer
        const footer = new St.BoxLayout({style_class: 'zu-footer'});
        this._updated = new St.Label({text: 'Loading…', style_class: 'zu-updated', x_expand: true});
        const settings = new St.Button({label: '⚙ Settings', style_class: 'zu-refresh'});
        settings.connect('clicked', () => {
            this.menu.close();
            this._openPreferences?.();
        });
        const refresh = new St.Button({label: '↻ Refresh', style_class: 'zu-refresh'});
        refresh.connect('clicked', () => this._refresh(true));
        footer.add_child(this._updated);
        footer.add_child(settings);
        footer.add_child(refresh);
        root.add_child(footer);
    }

    _sectionLabel(parent, text) {
        parent.add_child(new St.Label({text: text.toUpperCase(), style_class: 'zu-section'}));
    }

    // force bypasses the min-gap throttle (used for explicit user actions like
    // changing the API key); opening the popup and the poll timer go through it.
    _refresh(force = false) {
        if (this._busy)
            return;
        if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS)
            return;
        this._busy = true;
        this._lastFetchMs = Date.now();

        const cancellable = this._cancellable;

        this._client.fetchUsage(cancellable).then(usage => {
            if (cancellable.is_cancelled())
                return;
            this._render(usage);
            this._markUpdated();
        }).catch(e => {
            if (cancellable.is_cancelled())
                return;
            this._renderError(e);
        }).finally(() => {
            this._busy = false;
        });
    }

    _render(usage) {
        this._error.visible = false;
        this._lastUsage = usage;

        const q = usage.quota;
        const total = this._windowSeconds();
        const usedUtil = q.percentage ?? 0;
        const level = windowLevel(usedUtil, q.resetsAt, total);

        let caption = q.resetsAt ? relativeReset(q.resetsAt)
            : (usedUtil > 0 ? '' : 'no usage yet this window');
        const note = projectionNote(usedUtil, q.resetsAt, total);
        if (note)
            caption = caption ? `${caption} · ${note}` : note;

        // Token detail under the bar: used / limit.
        const usedStr = formatTokens(q.used);
        const limitStr = formatTokens(q.limit);
        const tokDetail = (q.used != null || q.limit != null)
            ? `${usedStr}${q.limit != null ? ` / ${limitStr} tokens` : ' tokens used'}`
            : '';
        this._quota.setValue(this._displayUtil(usedUtil),
            [caption, tokDetail].filter(Boolean).join(' · ') || null, level);

        // 7-day aggregate stats line.
        if (usage.sevenDay) {
            const s = usage.sevenDay;
            this._stats.visible = true;
            this._stats.text = `Last 7 days: ${formatTokens(s.prompts)} prompts · ${formatTokens(s.tokens)} tokens`;
        } else {
            this._stats.visible = false;
        }

        this._renderPanel();
        this._scheduleCountdown();
    }

    // Stamps the "Updated …" footer. Called only on a real fetch, not on the
    // countdown re-render, so the timestamp reflects the last network result.
    _markUpdated() {
        const now = GLib.DateTime.new_now_local();
        this._updated.text = `Updated ${now.format('%H:%M:%S')}`;
    }

    // The value shown for the bar/ring/number, inverted when show-remaining.
    _displayUtil(usedUtil) {
        return this._settings.get_boolean('show-remaining') ? 100 - usedUtil : usedUtil;
    }

    _scheduleCountdown() {
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        const resetsAt = this._lastUsage?.quota?.resetsAt;
        if (!resetsAt)
            return;
        const target = Date.parse(resetsAt);
        if (Number.isNaN(target))
            return;
        const remaining = (target - Date.now()) / 1000;
        if (remaining <= 0)
            return;
        const interval = remaining < 90 ? 1 : 30;
        this._countdownTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._countdownTimer = null;
            this._refreshCountdowns();
            this._scheduleCountdown();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refreshCountdowns() {
        if (!this._lastUsage)
            return;
        this._render(this._lastUsage);
    }

    _renderPanel() {
        const q = this._lastUsage?.quota;
        if (!q || q.percentage == null) {
            this._panelPct.text = '—';
            this._panelPct.style_class = 'zu-panel-pct';
            this._ring.setUnknown();
            this._panelBar.setUnknown();
            this._panelReset.text = '';
            return;
        }
        const usedUtil = q.percentage;
        const level = windowLevel(usedUtil, q.resetsAt, this._windowSeconds());
        this._panelPct.text = `${Math.round(this._displayUtil(usedUtil))}%`;
        this._panelPct.style_class = `zu-panel-pct ${levelClass(level)}`;
        this._panelReset.text = q.resetsAt ? compactReset(q.resetsAt) : '';
        this._ring.setValue(this._displayUtil(usedUtil), level);
        this._panelBar.setValue(this._displayUtil(usedUtil), level);
    }

    _renderError(e) {
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        // A 429 is transient; keep showing the last data instead of flashing an error.
        if (e instanceof UsageError && e.status === 429 && this._lastUsage) {
            logError(e, 'zai-usage: rate limited, keeping last data');
            return;
        }
        this._panelPct.text = '!';
        this._panelPct.style_class = 'zu-panel-pct zu-warn';
        this._ring.setUnknown();
        this._panelBar.setUnknown();
        this._panelReset.text = '';
        let msg;
        if (e instanceof UsageError && (e.status === 401 || e.status === 403))
            msg = 'Invalid or expired API key. Set it in extension settings.';
        else if (e instanceof UsageError && e.status === 429)
            msg = 'Rate limited by Z.ai; will retry shortly.';
        else
            msg = e.message || 'Could not reach Z.ai';
        this._error.text = msg;
        this._error.visible = true;
        this._stats.visible = false;
        this._quota.setMuted();
        this._updated.text = 'Update failed';
        logError(e, 'zai-usage: refresh failed');
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        this.menu.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;

        this._quota?.destroy();
        this._panelBar?.destroy();
        this._quota = null;
        this._panelBar = null;
        this._ring = null;
        this._panelReset = null;
        this._lastUsage = null;
        this._client?.destroy();
        this._client = null;

        super.destroy();
    }
});

export default class ZaiUsageExtension extends Extension {
    enable() {
        this._indicator = new ZaiUsageIndicator(this.path, this.getSettings(), () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
