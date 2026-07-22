import assert from "node:assert/strict";
import test from "node:test";
import { attachScreen, extractSessionId, type Message } from "../lib/inject.ts";

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const FRAME = "data:image/jpeg;base64,AAAA";

type Part = { type: string; text?: string; image_url?: { url: string; detail: string } };
const parts = (m: Message): Part[] => m.content as unknown as Part[];

test("session id: top-level field", () => {
  assert.equal(extractSessionId({ session_id: ID }), ID);
});

test("session id: elevenlabs_extra_body", () => {
  assert.equal(extractSessionId({ elevenlabs_extra_body: { session_id: ID } }), ID);
});

test("session id: query string", () => {
  assert.equal(extractSessionId({}, new URLSearchParams(`session_id=${ID}`)), ID);
});

test("session id: scraped from the resolved system prompt", () => {
  // The fallback that cannot realistically fail — the agent is always told its id.
  assert.equal(
    extractSessionId({
      messages: [
        { role: "system", content: `You are support. Your session id is ${ID}. Pass it to tools.` },
        { role: "user", content: "hi" },
      ],
    }),
    ID,
  );
});

test("session id: scraped from array-shaped content", () => {
  assert.equal(
    extractSessionId({
      messages: [{ role: "system", content: [{ type: "text", text: `session id is ${ID}` }] }],
    }),
    ID,
  );
});

test("session id: null when genuinely absent", () => {
  assert.equal(extractSessionId({ messages: [{ role: "user", content: "hello" }] }), null);
});

test("session id: ignores a malformed id", () => {
  assert.equal(
    extractSessionId({ messages: [{ role: "system", content: "session id is not-a-uuid" }] }),
    null,
  );
});

const convo: Message[] = [
  { role: "system", content: "You are support." },
  { role: "user", content: "it won't let me pay" },
  { role: "assistant", content: "Let me look." },
  { role: "user", content: "still broken" },
];

test("injection: attaches to the last user message, not the first", () => {
  const out = attachScreen(convo, FRAME, "timeline");
  assert.equal(out.length, convo.length, "must not add or drop messages");
  assert.equal(typeof out[1].content, "string", "earlier user message left untouched");

  const content = parts(out[3]);
  assert.equal(content[0].text, "still broken", "original text preserved first");
  assert.equal(content.at(-1)!.image_url!.url, FRAME);
  assert.equal(
    content.at(-1)!.image_url!.detail,
    "low",
    "low detail keeps per-turn cost around 85 tokens",
  );
});

test("injection: preserves non-content fields", () => {
  const out = attachScreen([{ role: "user", content: "x", name: "caller" }], FRAME, "t");
  assert.equal(out[0].name, "caller");
});

test("injection: merges into array content instead of clobbering it", () => {
  const out = attachScreen(
    [{ role: "user", content: [{ type: "text", text: "existing" }] }],
    FRAME,
    "t",
  );
  const content = parts(out[0]);
  assert.equal(content[0].text, "existing");
  assert.equal(content.length, 3);
});

test("injection: no user message leaves the conversation untouched", () => {
  const only: Message[] = [{ role: "system", content: "You are support." }];
  assert.deepEqual(attachScreen(only, FRAME, "t"), only);
});

test("injection: the recent timeline rides along with the image", () => {
  const out = attachScreen(convo, FRAME, "- 3s ago: billing page, card declined");
  assert.match(parts(out[3]).at(-2)!.text!, /card declined/);
});
