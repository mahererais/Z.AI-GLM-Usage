import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ZaiClient} from './lib/zaiClient.js';
import {
    bumpCredentialGeneration,
    clearApiKey,
    lookupStoredApiKey,
    migrateLegacyApiKey,
    resolveApiKey,
    storeApiKey,
} from './lib/secretStore.js';
import {ENV_KEY} from './lib/config.js';

export default class ZaiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const ctx = {window, settings, cancellable: null};

        const page = new Adw.PreferencesPage({
            title: 'Z.ai GLM Usage',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        this._buildAccount(page, ctx);
        this._buildPanel(page, settings);
        this._buildAdvanced(page, settings);
    }

    _buildAccount(page, ctx) {
        const {settings} = ctx;
        const group = new Adw.PreferencesGroup({
            title: 'Account',
            description: 'Your API key is protected by GNOME Keyring and sent only to api.z.ai for usage queries.',
        });
        page.add(group);

        ctx.statusRow = new Adw.ActionRow({
            title: 'API key',
            subtitle: 'Checking GNOME Keyring…',
        });
        ctx.statusRow.add_suffix(new Gtk.Image({icon_name: 'dialog-password-symbolic'}));
        group.add(ctx.statusRow);

        const keyEntry = new Adw.PasswordEntryRow({title: 'Set Z.ai API key'});
        keyEntry.set_show_apply_button(true);

        // Saves the typed key (Enter or the row's apply button), plus the
        // explicit "Save API key" button row below — there is no auto-save.
        const saveKey = async () => {
            const v = (keyEntry.text ?? '').trim();
            keyEntry.text = '';
            if (!v)
                return;
            ctx.statusRow.subtitle = 'Saving key securely…';
            try {
                await storeApiKey(v);
                // Remove any residue left by a previous release only after the
                // keyring write has completed successfully.
                settings.reset('api-key');
                bumpCredentialGeneration(settings);
                ctx.statusRow.subtitle = 'Key saved in GNOME Keyring — testing connection…';
                await this._testConnection(ctx);
            } catch (e) {
                ctx.statusRow.subtitle = `Could not save key: ${e?.message ?? String(e)}`;
            }
        };
        keyEntry.connect('apply', saveKey);

        const saveRow = new Adw.ButtonRow({title: 'Save API key'});
        saveRow.connect('activated', saveKey);
        group.add(keyEntry);
        group.add(saveRow);

        const envRow = new Adw.SwitchRow({
            title: `Use $${ENV_KEY} environment variable`,
            subtitle: 'Optional fallback. Environment variables are less secure than GNOME Keyring.',
        });
        settings.bind('use-env-key', envRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(envRow);

        const clearRow = new Adw.ButtonRow({title: 'Clear stored API key'});
        clearRow.connect('activated', async () => {
            ctx.statusRow.subtitle = 'Removing key from GNOME Keyring…';
            try {
                await clearApiKey();
                settings.reset('api-key');
                bumpCredentialGeneration(settings);
                await this._refreshStatus(ctx);
            } catch (e) {
                ctx.statusRow.subtitle = `Could not remove key: ${e?.message ?? String(e)}`;
            }
        });
        group.add(clearRow);

        const labelRow = new Adw.EntryRow({title: 'Panel label'});
        settings.bind('plan-label', labelRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(labelRow);

        const helpRow = new Adw.ActionRow({
            title: 'Where do I get an API key?',
            subtitle: 'Create one in the Z.ai developer console, then paste it above.',
        });
        const helpBtn = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        helpBtn.connect('clicked', () => Gtk.show_uri(ctx.window, 'https://z.ai/manage-apikey/apikey-list', 0));
        helpRow.add_suffix(helpBtn);
        helpRow.set_activatable_widget(helpBtn);
        group.add(helpRow);

        // Gio.Settings in the standalone preferences process does not provide
        // GObject.Object.connectObject(). Keep the signal IDs so they can be
        // disconnected when the preferences window goes away.
        const signalIds = [
            settings.connect('changed::api-key', () => this._refreshStatus(ctx)),
            settings.connect('changed::use-env-key', () => {
                this._refreshStatus(ctx);
                this._testConnection(ctx);
            }),
        ];
        ctx.window.connect('destroy', () => {
            ctx.cancellable?.cancel();
            for (const signalId of signalIds)
                settings.disconnect(signalId);
        });
        this._refreshStatus(ctx);
    }

    _buildPanel(page, settings) {
        const group = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(group);

        const iconRow = new Adw.SwitchRow({title: 'Show icon'});
        settings.bind('show-icon', iconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(iconRow);

        const gaugeModel = new Gtk.StringList();
        gaugeModel.append('Ring'); gaugeModel.append('Bar'); gaugeModel.append('None');
        const gaugeRow = new Adw.ComboRow({
            title: 'Usage gauge',
            subtitle: 'Circular ring, horizontal bar, or none.',
            model: gaugeModel,
        });
        const map = ['ring', 'bar', 'none'];
        gaugeRow.selected = Math.max(0, map.indexOf(settings.get_string('panel-gauge')));
        gaugeRow.connect('notify::selected', () =>
            settings.set_string('panel-gauge', map[gaugeRow.selected] ?? 'ring'));
        group.add(gaugeRow);

        const pctRow = new Adw.SwitchRow({title: 'Show percentage'});
        settings.bind('show-percentage', pctRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(pctRow);
        const resetRow = new Adw.SwitchRow({title: 'Show time until reset'});
        settings.bind('show-reset', resetRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(resetRow);
        const remRow = new Adw.SwitchRow({title: 'Show remaining instead of used'});
        settings.bind('show-remaining', remRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(remRow);
    }

    _buildAdvanced(page, settings) {
        const group = new Adw.PreferencesGroup({title: 'Advanced'});
        page.add(group);

        const poll = new Adw.SpinRow({
            title: 'Refresh interval (seconds)',
            subtitle: 'How often to poll Z.ai for updated usage.',
            adjustment: new Gtk.Adjustment({lower: 30, upper: 600, step_increment: 15, page_increment: 60}),
        });
        settings.bind('poll-seconds', poll, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(poll);

        const win = new Adw.SpinRow({
            title: 'Quota window length (hours)',
            subtitle: 'Only affects the burn-rate projection coloring, not the percentage.',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 168, step_increment: 1, page_increment: 24}),
            digits: 1,
        });
        settings.bind('window-hours', win, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(win);
    }

    async _keyStatusText(settings) {
        await migrateLegacyApiKey(settings);
        const stored = await lookupStoredApiKey();
        if (stored)
            return 'Key set (protected by GNOME Keyring).';
        if (settings.get_boolean('use-env-key') && await resolveApiKey(settings))
            return `Key set (from $${ENV_KEY}).`;
        return 'No key configured.';
    }

    async _refreshStatus(ctx) {
        try {
            ctx.statusRow.subtitle = await this._keyStatusText(ctx.settings);
        } catch (e) {
            ctx.statusRow.subtitle = `Could not access GNOME Keyring: ${e?.message ?? String(e)}`;
        }
    }

    // Probes the API once so the user gets immediate confirmation the key works.
    async _testConnection(ctx) {
        if (ctx.cancellable)
            ctx.cancellable.cancel();
        ctx.cancellable = new Gio.Cancellable();
        const cancellable = ctx.cancellable;
        let key;
        try {
            key = await resolveApiKey(ctx.settings, cancellable);
        } catch (e) {
            if (!cancellable.is_cancelled())
                ctx.statusRow.subtitle = `Could not access GNOME Keyring: ${e?.message ?? String(e)}`;
            return;
        }
        if (!key)
            return;
        const client = new ZaiClient(ctx.settings);
        return client.fetchQuota(cancellable, key).then(q => {
            if (cancellable.is_cancelled())
                return;
            const pct = q.percentage != null ? `${Math.round(q.percentage)}%` : 'OK';
            ctx.statusRow.subtitle = `Connected — current usage ${pct}.`;
        }).catch(e => {
            if (cancellable.is_cancelled())
                return;
            ctx.statusRow.subtitle = `Connection failed: ${e?.message ?? String(e)}`;
        });
    }
}
