'use strict';

require('dotenv').config();

const { App, HTTPReceiver } = require('@slack/bolt');
const { handleSlackTurn, registerInteractions, isManagedThread } = require('./claude-slack');

console.log('Booting slack-claude-agent...');
console.log(`    Workspace:   ${process.env.CLAUDE_WORKSPACE || process.env.PROJECT_WORKSPACE || process.cwd()}`);
console.log(`    Model:       ${process.env.CLAUDE_MODEL || 'claude-sonnet-5'}`);
console.log(`    Bot token:   ${process.env.SLACK_BOT_TOKEN ? 'present' : 'MISSING'}`);
console.log(`    Signing key: ${process.env.SLACK_SIGNING_SECRET ? 'present' : 'MISSING'}`);

// Drop all requests that aren't Slack's /slack/events path — silences scanner noise
// and avoids leaking that the port is alive. Real security is Bolt's signature check.
// Socket Mode (preferred): the bot connects OUT to Slack over a websocket,
// so no public URL or tunnel is needed and it reconnects by itself after
// sleep or network changes. Needs SLACK_APP_TOKEN (xapp-..., scope
// connections:write) and Socket Mode switched on in the Slack app settings.
// Without it, fall back to HTTP mode behind a tunnel (the old setup).
const socketMode = Boolean(process.env.SLACK_APP_TOKEN);
console.log(`    Mode:        ${socketMode ? 'Socket Mode (no tunnel needed)' : 'HTTP (needs a public URL/tunnel)'}`);

const app = socketMode
  ? new App({
      token: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: true,
    })
  : new App({
      token: process.env.SLACK_BOT_TOKEN,
      receiver: new HTTPReceiver({
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        unhandledRequestHandler: ({ req, res }) => {
          res.writeHead(404);
          res.end();
        },
      }),
    });

// Mount AskUserQuestion / plan Approve+Revise handlers.
registerInteractions(app);

// Slack redelivers events on slow ack. De-dupe by event_id.
const seen = new Set();
function seenOnce(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5_000) seen.clear();
  return false;
}

const stripMention = (text) => text.replace(/<@[A-Z0-9]+>/g, '').trim();

// "plan: <task>" requests a plan-mode turn; otherwise a normal turn.
function parse(raw) {
  const text = stripMention(raw);
  const m = /^plan:\s*/i.exec(text);
  return m ? { text: text.slice(m[0].length), permissionMode: 'plan' } : { text };
}

// A mention starts (or continues) a thread.
app.event('app_mention', async ({ event, client, body }) => {
  if (seenOnce(body.event_id)) return;
  const { text, permissionMode } = parse(event.text ?? '');
  if (!text) return;
  console.log(`\n[app_mention] user=${event.user} channel=${event.channel}`);
  await handleSlackTurn({
    slack: client,
    channel: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    text,
    ...(permissionMode ? { permissionMode } : {}),
  });
});

// Thread replies continue a conversation without a re-mention.
app.message(async ({ message, client, body }) => {
  const m = message;
  if (m.subtype || m.bot_id) return;
  if (!m.thread_ts || m.thread_ts === m.ts) return;
  if (seenOnce(body.event_id)) return;

  // Only respond in threads the bot is already part of.
  if (!isManagedThread(m.thread_ts)) return;

  const { text, permissionMode } = parse(m.text ?? '');
  if (!text) return;

  console.log(`\n[thread reply] user=${m.user} channel=${m.channel}`);
  await handleSlackTurn({
    slack: client,
    channel: m.channel,
    thread_ts: m.thread_ts,
    text,
    ...(permissionMode ? { permissionMode } : {}),
  });
});

(async () => {
  try {
    if (socketMode) {
      await app.start();
      console.log('slack-claude-agent connected to Slack (Socket Mode)');
    } else {
      const port = Number(process.env.PORT) || 3000;
      await app.start({ port });
      console.log(`slack-claude-agent running on port ${port} (HTTP mode)`);
    }
    console.log('Mention the bot to start a thread; it then replies to follow-ups automatically.');
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
})();
