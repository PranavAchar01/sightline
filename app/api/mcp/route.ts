import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { resolveScreen } from "@/lib/resolve";
import { describeTimeline, putTrace } from "@/lib/store";
import { inspect } from "@/lib/vision";
import { createTicket, zendeskConfigured } from "@/lib/zendesk";

/**
 * The MCP server the ElevenLabs agent connects to.
 *
 * Important: ElevenLabs calls this from their backend, not from the browser. That
 * is why every tool takes a session_id — it is the only way to correlate the voice
 * conversation with the browser that is actually sharing its screen. The id is
 * injected into the agent's system prompt as a dynamic variable at startSession.
 */

const FRESH_MS = 20_000;

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "get_screen_context",
      "Recall what has recently been visible on the customer's shared screen. Instant " +
        "and free — always try this before look_at_screen. Use it to orient yourself at " +
        "the start of a call or to check what the customer was doing a moment ago.",
      { session_id: z.string().describe("The support session id from your system prompt.") },
      async ({ session_id }) => {
        const { state } = await resolveScreen(session_id);
        return text(describeTimeline(state));
      },
    );

    server.tool(
      "look_at_screen",
      "Look at the customer's screen right now and answer a specific question about it. " +
        "Use this to read exact text — error codes, reference numbers, field values — or " +
        "when get_screen_context is not detailed enough. Takes a moment, so prefer " +
        "get_screen_context when that would answer the question.",
      {
        session_id: z.string().describe("The support session id from your system prompt."),
        question: z
          .string()
          .describe("What you need to know about the screen, e.g. 'what does the red banner say?'"),
      },
      async ({ session_id, question }) => {
        const resolved = await resolveScreen(session_id);
        const state = resolved.state;

        await putTrace({
          at: Date.now(),
          route: "mcp/look_at_screen",
          via: resolved.via,
          sessionId: resolved.sessionId,
          screen: state.frame ? "attached" : "none",
          note: resolved.note,
        });

        if (!state.frame) {
          return text("The customer isn't sharing their screen right now, so I can't see anything.");
        }
        if (Date.now() - state.frameAt > FRESH_MS) {
          return text(
            "The screen share has gone stale — the last frame is over 20 seconds old. " +
              "Ask the customer to check that screen sharing is still active.",
          );
        }

        try {
          const answer = await inspect(state.frame, question);
          return text(answer || "I couldn't make that out clearly on the screen.");
        } catch {
          return text("I couldn't get a clear look at the screen just then.");
        }
      },
    );

    server.tool(
      "create_support_ticket",
      "File a Zendesk ticket summarising this call, with the customer's screenshot " +
        "attached. Call this once the issue is understood, after telling the customer.",
      {
        session_id: z.string().describe("The support session id from your system prompt."),
        subject: z.string().describe("Short ticket subject line."),
        summary: z.string().describe("What the customer's problem was, in a few sentences."),
        resolution: z.string().optional().describe("What resolved it, or the next step."),
      },
      async ({ session_id, subject, summary, resolution }) => {
        if (!zendeskConfigured()) {
          return text("Zendesk isn't connected in this environment, so I couldn't file the ticket.");
        }
        const { state } = await resolveScreen(session_id);
        try {
          const ticket = await createTicket({ subject, summary, resolution, frame: state.frame });
          return text(`Ticket #${ticket.id} has been created in Zendesk: ${ticket.url}`);
        } catch {
          return text("I couldn't reach Zendesk just then — I've noted the details for follow-up.");
        }
      },
    );
  },
  {},
  { basePath: "/api" },
);

/**
 * ElevenLabs sends its configured Secret Token as an Authorization header. Reject
 * anything else so a public MCP endpoint can't be used to read customer screens.
 */
function guard(request: Request): Response | null {
  const secret = process.env.MCP_SHARED_SECRET;
  if (!secret) return null;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  if (provided !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

const authed = async (request: Request) => guard(request) ?? handler(request);

export { authed as GET, authed as POST, authed as DELETE };
