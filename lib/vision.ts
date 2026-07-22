import OpenAI from "openai";

const MODEL = process.env.OPENAI_VISION_MODEL ?? "gpt-5.2";

/**
 * Lazy: constructing the client at module scope throws during `next build`, which
 * evaluates route modules to collect page data without any env vars loaded.
 */
let client: OpenAI | null = null;
function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

async function ask(
  frame: string,
  instruction: string,
  detail: "low" | "high",
  maxTokens: number,
): Promise<string> {
  const response = await openai().responses.create({
    model: MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: instruction },
          { type: "input_image", image_url: frame, detail },
        ],
      },
    ],
    max_output_tokens: maxTokens,
  });
  return response.output_text?.trim() ?? "";
}

/**
 * Ambient channel. Runs on every meaningful screen change, so it is deliberately
 * cheap: low detail, short output. The result is pushed into the agent's context
 * via sendContextualUpdate so most questions need no tool call at all.
 */
export function caption(frame: string): Promise<string> {
  return ask(
    frame,
    "One sentence: what application or page is this, and what is the user doing? " +
      "Quote any visible error message, status, or banner text verbatim. No preamble.",
    "low",
    90,
  );
}

/**
 * On-demand channel. The agent asked something specific, so pay for full detail.
 */
export function inspect(frame: string, question: string): Promise<string> {
  return ask(
    frame,
    "You are looking at a screenshot of a customer's screen during a live support call. " +
      `Answer this precisely and briefly, in one or two sentences: ${question}\n\n` +
      "Read any relevant text exactly as it appears. If the answer is not visible on " +
      "screen, say so plainly rather than guessing.",
    "high",
    200,
  );
}
