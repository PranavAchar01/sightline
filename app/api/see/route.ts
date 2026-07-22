import { readSession } from "@/lib/store";
import { inspect } from "@/lib/vision";

export const maxDuration = 30;

/**
 * Low-latency path for the same capability the MCP server exposes as look_at_screen.
 *
 * The MCP route is the connector story: ElevenLabs' backend calls it, so it works for
 * any agent and any transport. But it adds hops — ElevenLabs → Vercel → OpenAI. When
 * the agent is running in our own browser we can register this as a *client tool*
 * instead and skip a leg. Both paths share lib/vision, so they never drift.
 */
export async function POST(request: Request) {
  const { sessionId, frame, question } = await request.json();

  const image = frame ?? (sessionId ? (await readSession(sessionId)).frame : null);
  if (!image) {
    return Response.json({ answer: "The screen isn't being shared right now." });
  }

  try {
    const answer = await inspect(image, question ?? "What is on this screen?");
    return Response.json({ answer: answer || "I couldn't make that out clearly." });
  } catch {
    return Response.json({ answer: "I couldn't get a clear look at the screen just then." });
  }
}
