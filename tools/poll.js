#!/usr/bin/env -S gjs -m
// Standalone validator for the Z.ai usage client. Run from the repo root:
//   ZAI_API_KEY=... gjs -m tools/poll.js
// or
//   gjs -m tools/poll.js <api-key>
import GLib from 'gi://GLib';
import system from 'system';

import {ZaiClient, resolveApiKey} from '../src/lib/zaiClient.js';

// Allow passing the key as the first CLI arg for convenience.
const arg = ARGV?.[0];
if (arg)
    GLib.setenv('ZAI_API_KEY', arg, true);

const key = resolveApiKey(null);
if (!key) {
    printerr('No API key. Set ZAI_API_KEY or pass one as an argument.');
    system.exit(1);
}

const client = new ZaiClient(null);
try {
    const usage = await client.fetchUsage(null);
    print(JSON.stringify(usage, null, 2));
} catch (e) {
    printerr(`Failed: ${e.message ?? e}`);
    if (e.body)
        printerr(`Body: ${e.body}`);
    system.exit(1);
}
