#!/usr/bin/env -S gjs -m
// Standalone validator for the Z.ai usage client. It reads GNOME Keyring first,
// then an inherited ZAI_API_KEY. It deliberately rejects command-line secrets.
import system from 'system';

import {ZaiClient, resolveApiKey} from '../src/lib/zaiClient.js';

if (ARGV?.length) {
    printerr('Refusing command-line arguments: API keys can leak through process lists and shell history.');
    system.exit(2);
}

const key = await resolveApiKey(null);
if (!key) {
    printerr('No API key in GNOME Keyring or ZAI_API_KEY. Configure the extension first.');
    system.exit(1);
}

const client = new ZaiClient(null);
try {
    const usage = await client.fetchUsage(null);
    print(JSON.stringify(usage, null, 2));
} catch (e) {
    printerr(`Failed: ${e.message ?? e}`);
    system.exit(1);
}
