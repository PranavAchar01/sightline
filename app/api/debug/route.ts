import { latestSessionId, readTrace } from "@/lib/store";

/**
 * What the last inbound agent call actually resolved to.
 *
 * When the agent says it can't see the screen, there are only a few possible
 * reasons and they are indistinguishable from the outside. This tells you which:
 *
 *   no trace at all      the agent never reached us — Custom LLM isn't configured,
 *                        or its URL/API key is wrong. It is talking to ElevenLabs'
 *                        stock model, which has no screen.
 *   via: "claimed"       working correctly.
 *   via: "fallback-*"    we reached the right screen, but the session id the agent
 *                        sent was missing or wrong. Working, but fix the config.
 *   via: "none"          nothing has pushed a frame recently — the browser isn't
 *                        actually sharing, or the call ended.
 */
export async function GET() {
  const [trace, latest] = await Promise.all([readTrace(), latestSessionId()]);

  return Response.json({
    liveBrowserSession: latest,
    lastAgentCall: trace,
    diagnosis: !trace
      ? "No agent call has ever reached this server. The ElevenLabs agent is almost " +
        "certainly not configured with the Custom LLM server URL, so it is running on " +
        "a stock model that cannot see anything."
      : trace.screen === "attached"
        ? trace.via === "claimed"
          ? "Healthy — the agent sent a valid session id and received the screen."
          : "Working via fallback. The agent's session id was missing or wrong, so the " +
            "live browser session was used instead. Check customLlmExtraBody and the " +
            "dashboard's extra body field."
        : "The agent reached us but there was no screen to attach. Either the browser " +
          "is not sharing, or the last frame is stale.",
  });
}
