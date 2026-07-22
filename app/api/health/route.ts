import { backend } from "@/lib/store";

/**
 * One request that tells you why the agent is blind.
 *
 * Every failure mode here looks identical from the ElevenLabs side — the agent just
 * politely asks the customer to describe their screen. This says which one it is.
 */
export async function GET() {
  const checks = {
    openai: Boolean(process.env.OPENAI_API_KEY),
    agentId: Boolean(process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID),
    // The one that silently breaks production while working perfectly in dev.
    sessionBridge: backend,
    customLlmAuth: Boolean(process.env.CUSTOM_LLM_API_KEY),
    mcpAuth: Boolean(process.env.MCP_SHARED_SECRET),
    zendesk: Boolean(
      process.env.ZENDESK_SUBDOMAIN &&
        process.env.ZENDESK_EMAIL &&
        process.env.ZENDESK_API_TOKEN,
    ),
  };

  const blockers: string[] = [];
  if (!checks.openai) blockers.push("OPENAI_API_KEY is unset — the agent cannot see or think.");
  if (!checks.agentId) blockers.push("NEXT_PUBLIC_ELEVENLABS_AGENT_ID is unset — no call can start.");
  if (checks.sessionBridge === "memory") {
    blockers.push(
      "Session bridge is in-memory: frames and proxy reads land on different " +
        "serverless instances, so the screen never reaches the model. Provision a " +
        "Vercel Blob store (BLOB_READ_WRITE_TOKEN) or Upstash Redis.",
    );
  }

  return Response.json({ ready: blockers.length === 0, checks, blockers }, {
    status: blockers.length === 0 ? 200 : 503,
  });
}
