/**
 * telegram-digest — fetch recent messages from a Telegram channel or supergroup
 *
 * Usage:
 *   node telegram-digest.js --channel=@channelname [--hours=24]
 *
 * Required env vars:
 *   TELEGRAM_API_ID    — from https://my.telegram.org
 *   TELEGRAM_API_HASH  — from https://my.telegram.org
 *
 * Session file (GramJS StringSession string):
 *   TELEGRAM_SESSION_FILE — path to session file (default: /tools/telegram-session.session)
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram';
import * as fs from 'fs';

function parseArgs(argv: string[]): { channel: string; hours: number } {
  let channel = '';
  let hours = 24;
  for (const arg of argv) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) continue;
    const key = arg.slice(0, eqIdx);
    const val = arg.slice(eqIdx + 1);
    if (key === '--channel') channel = val;
    else if (key === '--hours') hours = parseInt(val, 10) || 24;
  }
  return { channel, hours };
}

async function main() {
  const { channel, hours } = parseArgs(process.argv.slice(2));

  if (!channel) {
    console.error('Error: --channel=<name> is required');
    console.error('Usage: node telegram-digest.js --channel=@channelname [--hours=24]');
    process.exit(1);
  }

  const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const sessionFile =
    process.env.TELEGRAM_SESSION_FILE || '/tools/telegram-session.session';

  if (!apiId || !apiHash) {
    console.error('Error: TELEGRAM_API_ID and TELEGRAM_API_HASH env vars must be set');
    process.exit(1);
  }

  if (!fs.existsSync(sessionFile)) {
    console.error(`Error: Session file not found at ${sessionFile}`);
    console.error('Please create a GramJS session string and save it to that file first.');
    process.exit(1);
  }

  const sessionString = fs.readFileSync(sessionFile, 'utf-8').trim();
  if (!sessionString) {
    console.error(`Error: Session file is empty: ${sessionFile}`);
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.connect();

  const channelName = channel.replace(/^@/, '');
  const cutoffUnix = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);

  const lines: string[] = [];

  for await (const msg of client.iterMessages(channelName, { limit: 500 })) {
    const m = msg as Api.Message;
    if (m.date < cutoffUnix) break;
    if (!m.message) continue;

    const date = new Date(m.date * 1000).toISOString().replace('T', ' ').slice(0, 19);

    let sender = 'Channel';
    if (m.postAuthor) {
      sender = m.postAuthor;
    } else if (m.senderId && !m.post) {
      sender = `user:${m.senderId}`;
    }

    lines.push(`[${date}] ${sender}: ${m.message}`);
  }

  await client.disconnect();

  lines.reverse(); // oldest first

  if (lines.length === 0) {
    console.log(`No messages found in @${channelName} in the last ${hours} hours.`);
  } else {
    console.log(`=== ${lines.length} messages from @${channelName} (last ${hours}h) ===\n`);
    console.log(lines.join('\n'));
  }
}

main().catch((err) => {
  console.error('Error:', err.message || String(err));
  process.exit(1);
});
