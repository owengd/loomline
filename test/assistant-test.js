// Ask Claude: the tool-use loop, error handling and the Markdown renderer, with a fake API.
const assert = require('assert');
const A = require('../js/assistant.js');
let calls = [];
let script = [];
global.fetch = async (url, init) => {
  calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
  const r = script.shift();
  if (r instanceof Error) throw r;
  return { ok: r.status ? r.status < 300 : true, status: r.status || 200, json: async () => r.json };
};
(async () => {
  const ran = [];
  const tools = [{ name: 'part', description: 'd', input_schema: { type: 'object', properties: {} }, label: (i) => 'Looked up ' + i.ref, run: (i) => { ran.push(i.ref); return { ref: i.ref, pins: ['1', '2'] }; } }];
  const chat = new A.Chat({ key: () => 'k', model: () => 'm', system: () => 'S', guide: () => 'G', tools, context: () => 'Project: X' });
  // 1. a tool round then an answer
  script = [
    { json: { content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't1', name: 'part', input: { ref: 'U1' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50 } } },
    { json: { content: [{ type: 'text', text: '`U1` has **2** pins.' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 50 } } }
  ];
  let ups = 0;
  await chat.ask('What is U1?', () => ups++);
  assert.deepStrictEqual(ran, ['U1']);
  assert.strictEqual(calls.length, 2);
  const b0 = calls[0].body, h0 = calls[0].init.headers;
  assert.strictEqual(h0['x-api-key'], 'k'); assert.strictEqual(h0['anthropic-dangerous-direct-browser-access'], 'true'); assert.ok(h0['anthropic-version']);
  assert.strictEqual(b0.model, 'm'); assert.strictEqual(b0.system[1].cache_control.type, 'ephemeral');
  assert.ok(b0.messages[0].content[0].text.includes('<app_state>'));
  const b1 = calls[1].body;
  assert.strictEqual(b1.messages.length, 3);
  assert.strictEqual(b1.messages[2].content[0].type, 'tool_result'); assert.strictEqual(b1.messages[2].content[0].tool_use_id, 't1');
  assert.deepStrictEqual(chat.log.map((l) => l.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.strictEqual(chat.log[2].text, 'Looked up U1');
  assert.strictEqual(chat.usage.input, 120); assert.strictEqual(chat.usage.cacheRead, 50);
  assert.ok(ups >= 3); assert.strictEqual(chat.busy, false);
  // 2. an API error removes the unanswered question so the history stays valid
  calls = []; script = [{ status: 401, json: { error: { message: 'invalid x-api-key' } } }];
  await chat.ask('Again?');
  assert.strictEqual(chat.messages.length, 4);
  assert.ok(/not accepted/.test(chat.log[chat.log.length - 1].text));
  // error after a tool round also rolls back to before the question
  script = [{ json: { content: [{ type: 'tool_use', id: 't2', name: 'part', input: { ref: 'U2' } }], stop_reason: 'tool_use' } }, new Error('Failed to fetch')];
  await chat.ask('U2?');
  assert.strictEqual(chat.messages.length, 4); assert.strictEqual(chat.messages[3].role, 'assistant');
  // 3. unknown tool and thrown tool errors come back as is_error results
  script = [{ json: { content: [{ type: 'tool_use', id: 't3', name: 'nope', input: {} }], stop_reason: 'tool_use' } }, { json: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }];
  calls = []; await chat.ask('x');
  assert.strictEqual(calls[1].body.messages[calls[1].body.messages.length - 1].content[0].is_error, true);
  // 4. the last allowed round forces an answer
  const loop = new A.Chat({ key: () => 'k', model: () => 'm', system: () => 'S', guide: () => 'G', tools, context: null });
  script = []; for (let i = 0; i < 20; i++) script.push({ json: { content: [{ type: 'tool_use', id: 'l' + i, name: 'part', input: { ref: 'R' + i } }], stop_reason: 'tool_use' } });
  calls = []; await loop.ask('loop');
  assert.strictEqual(calls.length, 9); assert.deepStrictEqual(calls[8].body.tool_choice, { type: 'none' });
  // 5. no key
  await assert.rejects(new A.Chat({ key: () => null, model: () => 'm', system: () => '', guide: () => '', tools: [] }).ask('hi'), /API key/);
  // 6. trimming keeps whole turns
  const t = new A.Chat({ key: () => 'k', model: () => 'm', system: () => 'S', guide: () => 'G', tools });
  for (let i = 0; i < 15; i++) { script = [{ json: { content: [{ type: 'text', text: 'a' + i }], stop_reason: 'end_turn' } }]; await t.ask('q' + i); }
  assert.strictEqual(t.messages[0].role, 'user'); assert.ok(t.messages.length <= 24 + 1);
  // 7. models
  script = [{ json: { data: [{ id: 'claude-opus-x', display_name: 'Opus X' }, { id: 'claude-sonnet-y', display_name: 'Sonnet Y' }], has_more: false } }];
  const ms = await A.listModels('k');
  assert.strictEqual(ms.length, 2); assert.strictEqual(A.defaultModel(ms), 'claude-sonnet-y');
  assert.strictEqual(A.defaultModel([]), null);
  // 8. markdown renderer (with a tiny DOM stand-in)
  const mk = (tag) => ({ tagName: tag.toUpperCase(), children: [], className: '', textContent: '', append(...k) { this.children.push(...k); }, get lastChild() { return this.children[this.children.length - 1]; } });
  const doc = { createElement: mk, createTextNode: (t) => ({ text: t }) };
  const codes = [];
  const box = A.render('Hi **there** `U1`\n\n- one\n- two `24V`\n\n1. a\n2. b\n\n```\ncode here\n```\n## Head', doc, (el, t) => codes.push(t));
  assert.deepStrictEqual(box.children.map((c) => c.tagName), ['P', 'UL', 'OL', 'PRE', 'H4']);
  assert.deepStrictEqual(codes, ['U1', '24V']);
  assert.strictEqual(box.children[3].textContent, 'code here');
  assert.ok(A.GUIDE.includes('Design check') && A.SYSTEM.includes('show'));
  console.log('assistant tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
