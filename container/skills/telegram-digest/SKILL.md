---
name: telegram-digest
description: Fetch and summarize recent messages from any Telegram channel or supergroup. Use when the user asks for a digest, summary, or recap of a Telegram channel or group.
allowed-tools: Bash(node:*)
---

# Telegram Digest

Fetch recent messages from a Telegram channel or supergroup and summarize them.

## Quick start

```bash
node /tools/telegram-digest.js --channel=@channelname
node /tools/telegram-digest.js --channel=@channelname --hours=24
node /tools/telegram-digest.js --channel=@channelname --hours=48
```

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--channel` | yes | — | Channel username (with or without `@`) |
| `--hours` | no | `24` | How many hours back to fetch |

## Output

Outputs messages oldest-first in this format:
```
=== N messages from @channel (last 24h) ===

[2026-04-01 10:30:00] Channel: message text here
[2026-04-01 11:15:00] AuthorName: another message
```

## Workflow for a digest request

1. Run the tool to fetch messages
2. Read the output
3. Summarize key topics, announcements, and discussions in your response

## Example

User asks: "give me a digest of @somechannel for the last 24 hours"

```bash
node /tools/telegram-digest.js --channel=@somechannel --hours=24
```

Then summarize the output: group by topic, highlight important announcements, note any discussions or decisions.

## Errors

- `Session file not found` — the Telegram session hasn't been set up yet; tell the user to authenticate first
- `TELEGRAM_API_ID ... must be set` — credentials not configured; tell the user to check their `.env` setup
- Channel not found — try the channel name without `@`, or ask the user to confirm the exact username
