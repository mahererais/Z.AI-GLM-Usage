# Z.ai GLM Usage Monitor

A GNOME Shell panel indicator that shows your **Z.ai (GLM)** coding-plan token quota and live usage right in the top bar — a usage ring, a percentage, an optional reset countdown, and a label — plus a dropdown with token detail and 7-day aggregate stats. Inspired by [ClaudeCodeUsage](https://github.com/dvdstelt/ClaudeCodeUsage) and the Z.ai VS Code trackers.

It polls Z.ai's monitor API with your own API key (entered once in preferences, or read from `ZAI_API_KEY`).

## Features

- **Panel indicator** with a GLM icon, a usage gauge (circular ring, horizontal bar, or none), a percentage, an optional time-until-reset countdown, and a label. Each element toggles independently.
- **Dropdown** with the token-quota meter (used / limit, percentage, reset time), plus last-7-day prompts and token counts.
- **Burn-rate projection.** The ring/percentage are colored by projected end-of-window usage at the current rate — amber/red before you actually hit the limit, with a plain-language caption.
- **Live countdown.** The "resets in" caption ticks down between polls.
- **Remaining or used.** Optionally show *remaining* percentage everywhere.
- **Theme aware.** The ring track follows your panel text color.
- **Configurable** refresh interval, panel elements, label, and projection window length.

## Requirements

- GNOME Shell 48, 49, or 50.
- A Z.ai API key (the same Bearer token used for the GLM API).

## Install (development)

```sh
git clone <this-repo>
ln -s "$PWD/<repo>/src" \
  ~/.local/share/gnome-shell/extensions/zai-glm-usage@karbut.github.io
glib-compile-schemas "$PWD/<repo>/src/schemas/"
gnome-extensions enable zai-glm-usage@karbut.github.io
```

On Wayland a newly installed extension only loads after you log out and back in.

## Configuration

Open preferences from the dropdown (gear) or:

```sh
gnome-extensions prefs zai-glm-usage@karbut.github.io
```

- **API key** — paste your Z.ai key. Stored locally by GNOME (GSettings), never sent anywhere except Z.ai.
- **Use `ZAI_API_KEY`** — fall back to the environment variable when no key is set.
- **Panel label**, gauge, percentage, reset countdown, remaining-vs-used.
- **Refresh interval** (30–600 s) and **quota window length** (for the projection).

## Data source

`GET https://api.z.ai/api/monitor/usage/quota/limit` with `Authorization: Bearer <key>` returns `data.limits[]`; the `TOKENS_LIMIT` entry provides `percentage`, `currentValue`, `usage` (the limit) and `nextResetTime` (Unix ms). The 7-day stats come from `GET /api/monitor/usage/model-usage?startTime=…&endTime=…`. These are monitor endpoints and may change without notice.

## Standalone validator

Test the client without loading the shell:

```sh
ZAI_API_KEY=... gjs -m tools/poll.js
```

## License

GPL-2.0-or-later. Unofficial community project; not affiliated with Z.ai.
