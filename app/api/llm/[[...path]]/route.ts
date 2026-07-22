import { attachScreen, extractSessionId, type Message } from "@/lib/inject";
import { describeTimeline, readSession } from "@/lib/store";

/**
 * The live-sight proxy. This is what makes the agent actually see.
 *
 * ElevenLabs Agents accept a "Custom LLM" — any OpenAI-compatible
 * /v1/chat/completions endpoint. Point the agent here and every turn of the
 * conversation passes through this route on its way to the model, where we attach
 * the customer's current screen frame before forwarding.
 *
 * The consequence: the agent's reasoning model sees the screen *every time it
 * thinks*, with no tool call, no captioning lag and no extra round trip. Captions
 * and look_at_screen become escalation paths rather than the mechanism.
 *
 * We are a transparent proxy — OpenAI already streams SSE in exactly the shape
 * ElevenLabs expects, terminating `data: [DONE]` included, so the response body is
 * piped through untouched.
 */

export const maxDuration = 60;

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
/** Don't show the model a screen older than this — better blind than wrong. */
const MAX_FRAME_AGE_MS = 30_000;

export async function POST(request: Request) {
  const configured = process.env.CUSTOM_LLM_API_KEY;
  if (configured) {
    const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (provided !== configured) return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { message: "invalid JSON body" } }, { status: 400 });
  }

  const messages = (body.messages as Message[] | undefined) ?? [];
  const sessionId = extractSessionId(body, new URL(request.url).searchParams);

  let patched = messages;
  let sawScreen = false;

  if (sessionId) {
    const state = await readSession(sessionId);
    if (state.frame && Date.now() - state.frameAt < MAX_FRAME_AGE_MS) {
      patched = attachScreen(messages, state.frame, describeTimeline(state));
      sawScreen = true;
    }
  }

  // Strip our own routing fields; forward everything else — tools, tool_choice,
  // temperature, stream — exactly as ElevenLabs sent it.
  const { session_id: _a, sessionId: _b, elevenlabs_extra_body: _c, ...rest } = body;
  void _a;
  void _b;
  void _c;

  const upstream = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...rest,
      model: (rest.model as string) || process.env.OPENAI_AGENT_MODEL || "gpt-5.2",
      messages: patched,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      { error: { message: `upstream ${upstream.status}: ${detail.slice(0, 500)}` } },
      {
        status: 502,
        // Report injection state even on failure — otherwise a broken key and a
        // broken session bridge look identical from the ElevenLabs side.
        headers: {
          "X-Sightline-Screen": sawScreen ? "attached" : "none",
          "X-Sightline-Session": sessionId ?? "unresolved",
        },
      },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Handy for confirming from the ElevenLabs side that the screen went through.
      "X-Sightline-Screen": sawScreen ? "attached" : "none",
      "X-Sightline-Session": sessionId ?? "unresolved",
    },
  });
}

/** Lets you eyeball the endpoint in a browser to confirm it's reachable. */
export async function GET() {
  return Response.json({
    service: "sightline live-sight proxy",
    usage: "Set this URL as the ElevenLabs agent's Custom LLM server URL.",
    injects: "the customer's current screen frame into every turn",
  });
}
