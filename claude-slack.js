'use strict';

/**
 * claude-slack.js
 *
 * Claude Code (Agent SDK) <-> Slack bridge with interactive tools.
 *
 *   - One Claude session per Slack thread (keyed by thread_ts), resume-per-message.
 *   - Per-thread serialization via promise chaining.
 *   - AskUserQuestion -> rendered as radio/checkbox Block Kit card; denied;
 *                        the user's submission resumes the thread as the next turn.
 *   - ExitPlanMode    -> plan card with Approve / Request changes; denied;
 *                        approval resumes (write-enabled), revise opens a modal.
 *   - Streaming text throttled into one live message; markdown -> mrkdwn.
 *   - Session IDs persisted to disk so threads survive server restarts.
 */

const { query } = require('@anthropic-ai/claude-agent-sdk');
const slackify = require('slackify-markdown');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  cwd: process.env.CLAUDE_WORKSPACE || process.env.PROJECT_WORKSPACE || process.cwd(),
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  // Which Claude settings/CLAUDE.md/MCP layers the agent inherits. We deliberately
  // omit 'user' by default so the bot does not silently absorb the operator's personal
  // global ~/.claude config. Override with CLAUDE_SETTING_SOURCES (comma-separated,
  // e.g. "user,project,local") if you do want that. See README security note.
  settingSources: (process.env.CLAUDE_SETTING_SOURCES || 'project,local')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  streamEditIntervalMs: 1_200,
  maxBlockChars: 2_900,
  sessionFile: path.join(__dirname, 'thread_session_map.json'),
  /** Read-only tools that run unattended. */
  readTools: new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite']),
  /** Tools unlocked only after a plan is approved for the thread. */
  writeTools: new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']),
  /** Bash commands that are always allowed regardless of write-lock (read-only operations).
   *  PilotAI addition: specific safe `gh` read verbs (not a blanket `gh` allow -- that
   *  would auto-approve things like `gh pr merge`), and our own read-only report
   *  scripts by exact filename (not a blanket `python` allow, for the same reason). */
  readOnlyBashPattern: /^\s*(find|ls|cat|head|tail|grep|rg|wc|stat|file|du|diff|git\s+(log|diff|status|show|branch|tag|remote|ls-files)|which|type|echo|pwd|env|printenv|curl\s+-[^|;&]*\s|wget\s+--spider|gh\s+(pr\s+(list|view|diff|checks)|run\s+(list|view))|(\.venv\/bin\/)?python3?\s+scripts\/(pilot_status|pilot_health|pilot_quality|pilot_costs|check_test_freshness|check_quality_policy|check_context_registry|telemetry_report)\.py)\b/,
  /**
   * Allow MCP tools (named `mcp__<server>__<tool>`) to run automatically. Off by
   * default: MCP tools are denied by the gate below unless ALLOW_MCP_TOOLS is set.
   * NOTE: when on, MCP tools bypass the plan-approval write gate, so only connect
   * MCP servers you trust and scope their tokens minimally. See the README.
   */
  allowMcpTools: /^(1|true|yes)$/i.test(process.env.ALLOW_MCP_TOOLS || ''),
};

// ─────────────────────────────────────────────────────────────────────────────
// System prompt (appended to the claude_code preset)
//
// Customize by copying prompt.example.md to prompt.md and editing it, or point
// AGENT_PROMPT_FILE at any file. prompt.md is gitignored so your customizations
// stay private. If no file is found, the built-in default below is used.
// The prompt is read once at boot; restart (pm2 restart) to pick up edits.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_PROMPT_FILE = process.env.AGENT_PROMPT_FILE || path.join(__dirname, 'prompt.md');

const DEFAULT_AGENT_PROMPT = `
## Personality & communication style

You are a helpful, good-natured assistant living inside Slack. A light tone and
the occasional well-timed joke are welcome, but never sacrifice accuracy for a laugh.

Rules to live by:
- **Default to plain English.** Assume the person asking is smart but not
  necessarily technical. Explain things the way you would to a curious colleague,
  not in a pull-request review.
- **No unsolicited code.** Do not show code, terminal commands, file paths, or
  implementation details unless the user explicitly asks (e.g. "show me the code",
  "how would I implement this").
- **Accuracy first.** If you are not sure, say so rather than guessing.
- **Keep it concise.** Slack is not a blog. Favour short paragraphs and bullets
  over walls of text.
- **Warm, not sycophantic.** Do not open every reply with "Great question!".
- **Use emoji sparingly**, only where they add clarity or visual separation.
- **Use Slack-compatible tables** (pipe-separated markdown) when comparing
  options or showing structured data.
- **Use ASCII diagrams** (inside a code block) for flows or architecture that
  benefit from a visual. Keep them simple enough to read in monospace.

## Working in this project

You work in a single project directory (the current working directory). Treat it
as the source of truth for questions about this codebase. Use your read tools
(Read, Glob, Grep) to find answers before asking the user.

## Making changes safely

Write tools stay locked until the user approves a plan via the Approve button in
Slack. For any change, present a short plan first and wait for approval. When you
do make changes, prefer working on a branch rather than committing directly to the
default branch, and never leave the working tree in a broken state. If you stash
or branch, say so in your reply so the user knows where things are.
`;

function loadAgentPrompt() {
  try {
    return fs.readFileSync(AGENT_PROMPT_FILE, 'utf8');
  } catch (err) {
    console.warn(
      `    Prompt: could not read ${AGENT_PROMPT_FILE} (${err.code || err.message}); using built-in default`,
    );
    return DEFAULT_AGENT_PROMPT;
  }
}

const AGENT_PROMPT = loadAgentPrompt();

// ─────────────────────────────────────────────────────────────────────────────
// Session persistence (thread_ts -> Claude session_id, keyed without dots)
// ─────────────────────────────────────────────────────────────────────────────

function sessionKey(thread_ts) {
  return thread_ts.replace('.', '_');
}

function loadSessionMap() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.sessionFile, 'utf8'));
  } catch {
    return {};
  }
}

function persistSession(thread_ts, sessionId) {
  const key = sessionKey(thread_ts);
  const map = loadSessionMap();
  if (map[key] === sessionId) return;
  map[key] = sessionId;
  fs.writeFileSync(CONFIG.sessionFile, JSON.stringify(map, null, 2));
  console.log(`    Linked thread ${key} -> session ${sessionId}`);
}

function loadSession(thread_ts) {
  return loadSessionMap()[sessionKey(thread_ts)] || undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-thread state + serialization
// ─────────────────────────────────────────────────────────────────────────────

const threads = new Map();

function getThread(thread_ts) {
  let s = threads.get(thread_ts);
  if (!s) {
    s = { sessionId: loadSession(thread_ts), writeEnabled: false, chain: Promise.resolve() };
    threads.set(thread_ts, s);
  }
  return s;
}

function isManagedThread(thread_ts) {
  if (threads.has(thread_ts)) return true;
  return Boolean(loadSession(thread_ts));
}

function serialize(thread_ts, fn) {
  const state = getThread(thread_ts);
  const next = state.chain.then(fn, fn);
  state.chain = next.catch(() => {});
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending AskUserQuestion records (in-memory, 1 h TTL)
// ─────────────────────────────────────────────────────────────────────────────

const pendingAsks = new Map();
const ASK_TTL_MS = 60 * 60 * 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Markdown -> mrkdwn + chunking
// ─────────────────────────────────────────────────────────────────────────────

function toMrkdwn(md) {
  try {
    return slackify(md).trim();
  } catch {
    return md.trim();
  }
}

function chunk(text, max = CONFIG.maxBlockChars) {
  if (text.length <= max) return [text];
  const out = [];
  let buf = '';
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    if (buf.length + line.length + 1 > max && buf && !inFence) {
      out.push(buf.trimEnd());
      buf = '';
    }
    buf += line + '\n';
    while (buf.length > max) {
      out.push(buf.slice(0, max));
      buf = buf.slice(max);
    }
  }
  if (buf.trim()) out.push(buf.trimEnd());
  return out;
}

const sectionBlocks = (text) =>
  chunk(text).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } }));

const contextBlock = (text) => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text }],
});

// ─────────────────────────────────────────────────────────────────────────────
// SDK message extractors
// ─────────────────────────────────────────────────────────────────────────────

function extractStreamText(msg) {
  if (msg?.type !== 'stream_event') return undefined;
  const ev = msg.event;
  if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') return ev.delta.text;
  return undefined;
}

function extractToolNames(msg) {
  if (msg?.type !== 'assistant') return [];
  const c = msg.message?.content;
  return Array.isArray(c) ? c.filter((b) => b?.type === 'tool_use').map((b) => b.name) : [];
}

function extractSessionId(msg) {
  return typeof msg?.session_id === 'string' ? msg.session_id : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live Slack message (streaming preview + final render + card mode)
// ─────────────────────────────────────────────────────────────────────────────

class SlackLiveMessage {
  constructor(slack, channel, thread_ts) {
    this.slack = slack;
    this.channel = channel;
    this.thread_ts = thread_ts;
    this.ts = undefined;
    this.lastEdit = 0;
    this.dirty = false;
    this.pending = undefined;
    this.locked = false; // set once we render a card; stops further edits
    this.queued = { markdown: '' };
  }

  async start(initial = '_Thinking…_') {
    const res = await this.slack.chat.postMessage({
      channel: this.channel,
      thread_ts: this.thread_ts,
      text: initial,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: initial } }],
    });
    this.ts = res.ts;
  }

  preview(markdown, status) {
    if (this.locked) return;
    this.queued = { markdown, status };
    this.dirty = true;
    this._schedule();
  }

  _schedule() {
    if (this.pending) return;
    const wait = Math.max(0, CONFIG.streamEditIntervalMs - (Date.now() - this.lastEdit));
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (this.dirty && !this.locked) this._flush().catch(() => {});
    }, wait);
  }

  async _flush() {
    if (!this.ts || this.locked) return;
    this.dirty = false;
    this.lastEdit = Date.now();
    const { markdown, status } = this.queued;
    const m = toMrkdwn(markdown || '…');
    const preview = m.length > CONFIG.maxBlockChars ? m.slice(-CONFIG.maxBlockChars) : m;
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: preview || '…' } }];
    if (status) blocks.push(contextBlock(status));
    try {
      await this.slack.chat.update({ channel: this.channel, ts: this.ts, text: '…', blocks });
    } catch {
      // final render is authoritative
    }
  }

  /** Replace the live message with an interactive card and stop streaming edits. */
  async renderCard(blocks, fallback) {
    if (this.pending) clearTimeout(this.pending);
    this.locked = true;
    if (!this.ts) return;
    await this.slack.chat.update({ channel: this.channel, ts: this.ts, text: fallback, blocks });
  }

  async finalize(markdown, footer) {
    if (this.locked) return; // a card already owns this message
    if (this.pending) clearTimeout(this.pending);
    const m = toMrkdwn(markdown);
    const blocks = sectionBlocks(m);
    if (footer) blocks.push(contextBlock(footer));
    const head = blocks.slice(0, 48);
    const tail = blocks.slice(48);
    const plain = m.slice(0, 2_900);
    if (this.ts) {
      await this.slack.chat.update({ channel: this.channel, ts: this.ts, text: plain, blocks: head });
    } else {
      await this.slack.chat.postMessage({
        channel: this.channel,
        thread_ts: this.thread_ts,
        text: plain,
        blocks: head,
      });
    }
    for (let i = 0; i < tail.length; i += 48) {
      await this.slack.chat.postMessage({
        channel: this.channel,
        thread_ts: this.thread_ts,
        text: '(continued)',
        blocks: tail.slice(i, i + 48),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card builders
// ─────────────────────────────────────────────────────────────────────────────

function preambleBlocks(assistantText) {
  const t = assistantText.trim();
  return t ? sectionBlocks(toMrkdwn(t)) : [];
}

function buildAskCard(assistantText, ask, pendingId) {
  const blocks = [...preambleBlocks(assistantText)];
  ask.questions.forEach((q, i) => {
    const options = q.options.slice(0, 10).map((label, idx) => ({
      text: { type: 'plain_text', text: label.slice(0, 150), emoji: true },
      value: String(idx),
    }));
    blocks.push({
      type: 'section',
      block_id: `q${i}`,
      text: { type: 'mrkdwn', text: `*${q.question}*` },
    });
    blocks.push({
      type: 'actions',
      block_id: `qa${i}`,
      elements: [
        { type: q.multiSelect ? 'checkboxes' : 'radio_buttons', action_id: `ans_q${i}`, options },
      ],
    });
  });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'ask_submit',
        style: 'primary',
        text: { type: 'plain_text', text: 'Submit', emoji: true },
        value: pendingId,
      },
    ],
  });
  return blocks;
}

function buildPlanCard(assistantText, plan, channel, thread_ts) {
  const value = JSON.stringify({ channel, thread_ts });
  return [
    ...preambleBlocks(assistantText),
    contextBlock(':clipboard: *Proposed plan*'),
    ...sectionBlocks(toMrkdwn(plan)),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'plan_approve',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve & proceed', emoji: true },
          value,
        },
        {
          type: 'button',
          action_id: 'plan_revise',
          text: { type: 'plain_text', text: 'Request changes', emoji: true },
          value,
        },
      ],
    },
  ];
}

function statusLine(tools) {
  return `:hammer_and_wrench: ${[...tools].join(', ')}`;
}

function resultFooter(r) {
  const parts = [];
  if (r.usage?.input_tokens != null && r.usage?.output_tokens != null) {
    parts.push(`${r.usage.input_tokens}→${r.usage.output_tokens} tok`);
  }
  if (typeof r.total_cost_usd === 'number') parts.push(`$${r.total_cost_usd.toFixed(4)}`);
  if (r.num_turns != null) parts.push(`${r.num_turns} turns`);
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Core turn runner
// ─────────────────────────────────────────────────────────────────────────────

async function runTurn(turn) {
  console.log(`[runTurn] thread=${turn.thread_ts} text=${JSON.stringify(turn.text.slice(0, 80))}`);
  const state = getThread(turn.thread_ts);
  const live = new SlackLiveMessage(turn.slack, turn.channel, turn.thread_ts);
  try {
    await live.start();
  } catch (err) {
    console.error('[runTurn] live.start() failed:', err.message);
    return;
  }

  let assistantText = '';
  let interactionPosted = false;

  const askInSlack = async (input) => {
    const raw = Array.isArray(input?.questions) ? input.questions : [];
    const ask = {
      channel: turn.channel,
      thread_ts: turn.thread_ts,
      questions: raw.map((q) => ({
        question: typeof q.question === 'string' ? q.question : '',
        options: Array.isArray(q.options) ? q.options.map((o) => String(o.label ?? o)) : [],
        multiSelect: q.multiSelect === true,
      })),
    };
    const id = randomUUID();
    pendingAsks.set(id, ask);
    const timer = setTimeout(() => pendingAsks.delete(id), ASK_TTL_MS);
    if (timer.unref) timer.unref();
    await live.renderCard(buildAskCard(assistantText, ask, id), 'I need a bit more info');
    return {
      behavior: 'deny',
      message:
        'These questions were shown to the user as interactive choices in Slack. ' +
        'Their selected answers will arrive as your next message. Stop now and wait.',
    };
  };

  const capturePlan = async (input) => {
    const plan = typeof input?.plan === 'string' ? input.plan.trim() : '';
    await live.renderCard(
      buildPlanCard(assistantText, plan || '_(empty plan)_', turn.channel, turn.thread_ts),
      'Proposed plan',
    );
    return {
      behavior: 'deny',
      message:
        'Your plan was presented to the user with Approve / Request changes controls. ' +
        'Stop here and wait for their decision in a later message.',
    };
  };

  const canUseTool = async (toolName, input) => {
    if (toolName === 'AskUserQuestion') {
      interactionPosted = true;
      return askInSlack(input);
    }
    if (toolName === 'ExitPlanMode') {
      interactionPosted = true;
      return capturePlan(input);
    }
    if (CONFIG.readTools.has(toolName)) return { behavior: 'allow', updatedInput: input };
    if (CONFIG.allowMcpTools && toolName.startsWith('mcp__')) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName === 'Bash' && typeof input?.command === 'string' && CONFIG.readOnlyBashPattern.test(input.command)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (state.writeEnabled && CONFIG.writeTools.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: `Tool "${toolName}" is not permitted here.` };
  };

  const options = {
    cwd: turn.cwd || CONFIG.cwd,
    model: state.model || CONFIG.model,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: AGENT_PROMPT,
    },
    settingSources: [...CONFIG.settingSources],
    includePartialMessages: true,
    canUseTool,
    ...(turn.permissionMode ? { permissionMode: turn.permissionMode } : {}),
    ...(state.sessionId ? { resume: state.sessionId } : {}),
  };

  const toolsUsed = new Set();
  let finalText = '';
  let footer = '';

  try {
    for await (const msg of query({ prompt: turn.text, options })) {
      const sid = extractSessionId(msg);
      if (sid) {
        state.sessionId = sid;
        persistSession(turn.thread_ts, sid);
      }

      const delta = extractStreamText(msg);
      if (delta) {
        assistantText += delta;
        live.preview(assistantText);
        continue;
      }

      for (const name of extractToolNames(msg)) {
        if (name === 'AskUserQuestion' || name === 'ExitPlanMode') continue;
        toolsUsed.add(name);
      }

      if (msg.type === 'result') {
        finalText =
          msg.subtype && msg.subtype !== 'success'
            ? `:warning: I hit a problem (\`${msg.subtype}\`). ${msg.result ?? ''}`.trim()
            : msg.result || assistantText;
        footer = resultFooter(msg);
      }
    }
  } catch (err) {
    console.error('[runTurn] query error:', err.message);
    finalText = `:warning: Something went wrong. ${err.message ?? ''}`.trim();
  }

  console.log(`[runTurn] done — finalText length=${finalText.length} interactionPosted=${interactionPosted}`);
  if (!interactionPosted) {
    await live.finalize(finalText || assistantText || '_(no output)_', footer || undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point: run one Slack turn (serialized per thread)
// ─────────────────────────────────────────────────────────────────────────────

function handleSlackTurn(turn) {
  return serialize(turn.thread_ts, () => runTurn(turn));
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction handlers — mount once via registerInteractions(app)
// ─────────────────────────────────────────────────────────────────────────────

function registerInteractions(app) {
  // Selection changes inside the ask card: ack immediately so Bolt doesn't warn.
  app.action(/^ans_q\d+$/, async ({ ack }) => {
    await ack();
  });

  // Submit answers -> ack immediately, then resume the thread in the background.
  app.action('ask_submit', async ({ ack, body, client }) => {
    await ack(); // must respond within 3 s — do this first, then process
    console.log('[ask_submit] received');
    try {
      const pendingId = body.actions?.[0]?.value;
      const ask = pendingAsks.get(pendingId);
      if (!ask) {
        console.log('[ask_submit] pending ask not found (expired or server restarted)');
        await client.chat.postMessage({
          channel: body.channel?.id ?? body.container?.channel_id,
          thread_ts: body.message?.thread_ts ?? body.message?.ts,
          text: 'That question expired. Just re-send your request and I will continue.',
        });
        return;
      }
      pendingAsks.delete(pendingId);

      const values = body.state?.values ?? {};
      const lines = [];
      ask.questions.forEach((q, i) => {
        const el = values[`qa${i}`]?.[`ans_q${i}`];
        let chosen = [];
        if (el?.selected_option) chosen = [q.options[Number(el.selected_option.value)]];
        else if (Array.isArray(el?.selected_options))
          chosen = el.selected_options.map((o) => q.options[Number(o.value)]);
        lines.push(`• ${q.question} → ${chosen.filter(Boolean).join(', ') || '(no answer)'}`);
      });

      await client.chat.update({
        channel: ask.channel,
        ts: body.message.ts,
        text: 'Answers received',
        blocks: sectionBlocks(toMrkdwn(':white_check_mark: *Answers received*\n' + lines.join('\n'))),
      });

      // Fire-and-forget: don't await so the handler returns before Claude responds.
      handleSlackTurn({
        slack: client,
        channel: ask.channel,
        thread_ts: ask.thread_ts,
        text: `The user answered your questions:\n${lines.join('\n')}\n\nContinue.`,
      }).catch((err) => console.error('[ask_submit] handleSlackTurn error:', err));
    } catch (err) {
      console.error('[ask_submit] error:', err);
    }
  });

  // Approve plan -> ack immediately, unlock writes, resume in background.
  app.action('plan_approve', async ({ ack, body, client }) => {
    await ack();
    console.log('[plan_approve] received');
    try {
      const { channel, thread_ts } = JSON.parse(body.actions[0].value);
      getThread(thread_ts).writeEnabled = true;

      await client.chat.update({
        channel,
        ts: body.message.ts,
        text: 'Plan approved',
        blocks: [
          ...(body.message.blocks ?? []).filter((blk) => blk.type !== 'actions'),
          contextBlock(':white_check_mark: Approved — proceeding.'),
        ],
      });

      handleSlackTurn({
        slack: client,
        channel,
        thread_ts,
        text: 'The user approved your plan. Proceed with the implementation.',
      }).catch((err) => console.error('[plan_approve] handleSlackTurn error:', err));
    } catch (err) {
      console.error('[plan_approve] error:', err);
    }
  });

  // Request changes -> open a modal to capture free-text feedback.
  app.action('plan_revise', async ({ ack, body, client }) => {
    await ack();
    console.log('[plan_revise] received');
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'plan_revise_modal',
          private_metadata: body.actions[0].value, // {channel, thread_ts}
          title: { type: 'plain_text', text: 'Request changes' },
          submit: { type: 'plain_text', text: 'Send' },
          blocks: [
            {
              type: 'input',
              block_id: 'feedback',
              label: { type: 'plain_text', text: 'What should change?' },
              element: { type: 'plain_text_input', action_id: 'text', multiline: true },
            },
          ],
        },
      });
    } catch (err) {
      console.error('[plan_revise] error:', err);
    }
  });

  // Modal submit -> ack immediately, re-plan in background.
  app.view('plan_revise_modal', async ({ ack, body, view, client }) => {
    await ack();
    console.log('[plan_revise_modal] received');
    try {
      const { channel, thread_ts } = JSON.parse(view.private_metadata);
      const feedback = view.state.values.feedback.text.value ?? '';
      handleSlackTurn({
        slack: client,
        channel,
        thread_ts,
        text: `Revise your plan based on this feedback:\n${feedback}`,
        permissionMode: 'plan',
      }).catch((err) => console.error('[plan_revise_modal] handleSlackTurn error:', err));
    } catch (err) {
      console.error('[plan_revise_modal] error:', err);
    }
  });
}

module.exports = { handleSlackTurn, registerInteractions, isManagedThread, getThread };
