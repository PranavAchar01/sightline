/**
 * Model benchmark for the three vision paths. Results in docs/BENCHMARKS.md.
 *
 *   node --env-file=.env.local scripts/benchmark.mjs
 *
 * Renders its own fixture, so there's nothing to check in and nothing to go stale.
 */

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("OPENAI_API_KEY is unset. Run with: node --env-file=.env.local scripts/benchmark.mjs");
  process.exit(1);
}

const FIXTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="576">
  <rect width="1024" height="576" fill="#ffffff"/>
  <rect width="1024" height="64" fill="#f1f3f4"/>
  <text x="32" y="42" font-family="Helvetica" font-size="24" fill="#202124">Acme Cloud</text>
  <text x="320" y="42" font-family="Helvetica" font-size="18" fill="#1a73e8">Billing</text>
  <rect x="40" y="110" width="944" height="82" fill="#fdecea" stroke="#d93025" stroke-width="2"/>
  <text x="64" y="146" font-family="Helvetica" font-size="21" fill="#d93025">Payment declined - code AVS_MISMATCH</text>
  <text x="64" y="174" font-family="Helvetica" font-size="16" fill="#a50e0e">The billing ZIP code does not match the card on file.</text>
  <text x="40" y="250" font-family="Helvetica" font-size="18" fill="#202124">Card on file: Visa ending 4417</text>
  <text x="40" y="286" font-family="Helvetica" font-size="18" fill="#202124">Billing ZIP: 94108</text>
  <text x="40" y="322" font-family="Helvetica" font-size="18" fill="#202124">Reference: TXN-8891-QW42</text>
  <rect x="40" y="370" width="156" height="48" fill="#1a73e8"/>
  <text x="72" y="401" font-family="Helvetica" font-size="18" fill="#ffffff">Edit card</text>
</svg>`;

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jpeg = await sharp(Buffer.from(FIXTURE_SVG)).jpeg({ quality: 60 }).toBuffer();
writeFileSync("/tmp/sightline-fixture.jpg", jpeg);
const FRAME = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

const CAPTION =
  "One sentence: what application or page is this, and what is the user doing? " +
  "Quote any visible error message, status, or banner text verbatim. No preamble.";
const DEEP =
  "Answer precisely and briefly: what is the reference number shown? " +
  "Read it exactly as it appears.";

async function responses(model, detail, instruction, effort) {
  const t0 = Date.now();
  const body = {
    model,
    input: [{ role: "user", content: [
      { type: "input_text", text: instruction },
      { type: "input_image", image_url: FRAME, detail },
    ]}],
    max_output_tokens: 250,
  };
  if (effort) body.reasoning = { effort };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const ms = Date.now() - t0;
  if (data.error) return { ms, text: `ERR: ${data.error.message.slice(0, 90)}` };
  const text = (data.output ?? [])
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  return { ms, text };
}

/** Time to first streamed token — the number that decides if a call feels live. */
async function ttft(model) {
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: "You are a support specialist on a live call. Plain speech, no markdown." },
        { role: "user", content: [
          { type: "text", text: "it won't let me pay" },
          { type: "image_url", image_url: { url: FRAME, detail: "low" } },
        ]},
      ],
      tools: [{ type: "function", function: {
        name: "look_at_screen",
        description: "Read exact text on the customer's screen.",
        parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      }}],
    }),
  });
  if (!res.ok) return { text: `ERR ${res.status}` };

  let first = null;
  let text = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      try {
        const piece = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
        if (piece) {
          first ??= Date.now() - t0;
          text += piece;
        }
      } catch {
        // partial chunk; the next read completes it
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  }

  return { ms: first, total: Date.now() - t0, text };
}

const clip = (s, n = 110) => s.replace(/\s+/g, " ").slice(0, n);

console.log("=== ambient caption (detail: low) ===");
for (const model of ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"]) {
  const r = await responses(model, "low", CAPTION);
  console.log(`  ${model.padEnd(13)} ${String(r.ms).padStart(6)}ms  ${clip(r.text)}`);
}

console.log("\n=== reasoning effort (gpt-5.4-mini) ===");
for (const effort of [undefined, "none", "low"]) {
  const r = await responses("gpt-5.4-mini", "low", CAPTION, effort);
  console.log(`  effort=${String(effort).padEnd(9)} ${String(r.ms).padStart(6)}ms`);
}

console.log("\n=== deep read (detail: high) — expects TXN-8891-QW42 ===");
for (const model of ["gpt-5.4-mini", "gpt-5.2"]) {
  const r = await responses(model, "high", DEEP);
  const hit = /TXN-8891-QW42/.test(r.text) ? "EXACT" : "MISS ";
  console.log(`  ${model.padEnd(13)} ${String(r.ms).padStart(6)}ms  [${hit}] ${clip(r.text, 70)}`);
}

console.log("\n=== agent turn through the proxy — time to first token ===");
for (const model of ["gpt-5.4-mini", "gpt-5.2"]) {
  const r = await ttft(model);
  console.log(`  ${model.padEnd(13)} TTFT ${String(r.ms).padStart(6)}ms  ${clip(r.text, 90)}`);
}
