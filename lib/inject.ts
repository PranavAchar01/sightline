/**
 * Pure logic for the live-sight proxy: work out which browser session a request
 * belongs to, and splice the screen into the conversation. Kept separate from the
 * route so it can be tested without a network or an API key.
 */

export type Message = {
  role: string;
  content: string | Array<Record<string, unknown>> | null;
  [key: string]: unknown;
};

const UUID = /session id is\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => String(part.text ?? "")).join(" ");
  }
  return "";
}

/**
 * ElevenLabs can be configured to send a custom extra body, but that is easy to
 * misconfigure and painful to debug mid-demo. So we try four routes, ending with one
 * that cannot realistically fail: the resolved system prompt always contains the
 * session id, because the agent was told to pass it to tools.
 */
export function extractSessionId(
  body: Record<string, unknown>,
  searchParams?: URLSearchParams,
): string | null {
  const direct = body.session_id ?? body.sessionId;
  if (typeof direct === "string" && direct) return direct;

  const extra = body.elevenlabs_extra_body as Record<string, unknown> | undefined;
  const fromExtra = extra?.session_id ?? extra?.sessionId;
  if (typeof fromExtra === "string" && fromExtra) return fromExtra;

  const fromQuery = searchParams?.get("session_id");
  if (fromQuery) return fromQuery;

  for (const message of (body.messages as Message[] | undefined) ?? []) {
    const match = textOf(message).match(UUID);
    if (match) return match[1];
  }

  return null;
}

/**
 * Attach the frame to the most recent user message.
 *
 * Low detail is deliberate: it costs roughly 85 tokens and is plenty to know which
 * page the customer is on and whether something is visibly broken. When the agent
 * needs to read exact characters it escalates to look_at_screen, which pays for full
 * detail on a single frame.
 */
export function attachScreen(
  messages: Message[],
  frame: string,
  timeline: string,
): Message[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUser === -1) return messages;

  const target = messages[lastUser];
  const existing: Array<Record<string, unknown>> =
    typeof target.content === "string"
      ? [{ type: "text", text: target.content }]
      : Array.isArray(target.content)
        ? target.content
        : [];

  const withScreen: Message = {
    ...target,
    content: [
      ...existing,
      {
        type: "text",
        text:
          "[LIVE SCREEN] The image below is the customer's screen right now. " +
          "Use it directly — do not ask them to describe it.\n\n" +
          timeline,
      },
      { type: "image_url", image_url: { url: frame, detail: "low" } },
    ],
  };

  return [...messages.slice(0, lastUser), withScreen, ...messages.slice(lastUser + 1)];
}
