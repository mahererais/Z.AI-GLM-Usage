import GLib from 'gi://GLib';
import Secret from 'gi://Secret';

import {ENV_KEY} from './config.js';

const API_KEY_ATTRIBUTES = {account: 'default'};
const API_KEY_LABEL = 'Z.ai GLM Usage Monitor API key';

// This creates a libsecret object only when the extension is already enabled
// and needs to access the keyring. Module initialization must stay static.
function apiKeySchema() {
    return new Secret.Schema(
        'io.github.karbut.ZaiUsage.ApiKey',
        Secret.SchemaFlags.NONE,
        {account: Secret.SchemaAttributeType.STRING});
}

function finishAsync(start, finish) {
    return new Promise((resolve, reject) => {
        start((source, result) => {
            try {
                resolve(finish(source, result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function lookupStoredApiKey(cancellable = null) {
    return finishAsync(
        callback => Secret.password_lookup(
            apiKeySchema(), API_KEY_ATTRIBUTES, cancellable, callback),
        (_source, result) => (Secret.password_lookup_finish(result) ?? '').trim() || null);
}

export function storeApiKey(apiKey, cancellable = null) {
    const value = (apiKey ?? '').trim();
    if (!value)
        throw new Error('Cannot store an empty API key.');

    return finishAsync(
        callback => Secret.password_store(
            apiKeySchema(),
            API_KEY_ATTRIBUTES,
            Secret.COLLECTION_DEFAULT,
            API_KEY_LABEL,
            value,
            cancellable,
            callback),
        (_source, result) => {
            if (!Secret.password_store_finish(result))
                throw new Error('GNOME Keyring did not confirm the API key write.');
            return true;
        });
}

export function clearApiKey(cancellable = null) {
    return finishAsync(
        callback => Secret.password_clear(
            apiKeySchema(), API_KEY_ATTRIBUTES, cancellable, callback),
        (_source, result) => Secret.password_clear_finish(result));
}

// One-release compatibility bridge. Older releases stored the bearer token as
// a plain GSettings string. Only erase it after libsecret confirms the value is
// safely in the user's keyring.
export async function migrateLegacyApiKey(settings, cancellable = null) {
    const legacy = (settings?.get_string('api-key') ?? '').trim();
    if (!legacy)
        return false;

    const stored = await lookupStoredApiKey(cancellable);
    if (!stored)
        await storeApiKey(legacy, cancellable);

    settings.reset('api-key');
    return true;
}

export async function resolveApiKey(settings = null, cancellable = null) {
    if (settings)
        await migrateLegacyApiKey(settings, cancellable);

    const stored = await lookupStoredApiKey(cancellable);
    if (stored)
        return stored;

    // With settings, environment access is an explicit opt-in. The standalone
    // validator has no GSettings object, so it may still use an inherited value.
    const useEnv = settings ? settings.get_boolean('use-env-key') : true;
    if (useEnv) {
        const env = (GLib.getenv(ENV_KEY) ?? '').trim();
        if (env)
            return env;
    }
    return null;
}

export async function apiKeyAvailable(settings = null, cancellable = null) {
    return (await resolveApiKey(settings, cancellable)) !== null;
}

export function bumpCredentialGeneration(settings) {
    const current = settings.get_int('credential-generation');
    settings.set_int('credential-generation', current >= 2147483647 ? 0 : current + 1);
}
