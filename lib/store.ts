import { Redis } from "@upstash/redis";

/**
 * The session bridge.
 *
 * ElevenLabs calls our MCP server from *their* backend, so the MCP server has no
 * access to the browser that is sharing its screen. The browser pushes frames and
 * ambient captions in here keyed by session id; the MCP server reads them back out.
 *
 * In production this MUST be Redis — Vercel will route the browser's POST and
 * ElevenLabs' MCP call to different serverless instances, so a module-level Map
 * would silently return "no screen shared". The in-memory fallback exists only so
 * `next dev` works without provisioning anything.
 */

export type ScreenState = {
  /** Latest frame as a JPEG data URI. */
  frame: string | null;
  frameAt: number;
  /** Rolling ambient captions, oldest first, capped at CAPTION_LIMIT. */
  captions: { text: string; at: number }[];
};

const TTL_SECONDS = 300;
const CAPTION_LIMIT = 12;

const EMPTY: ScreenState = { frame: null, frameAt: 0, captions: [] };

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

const redis = url && token ? new Redis({ url, token }) : null;

export const usingRedis = redis !== null;

const memory = new Map<string, { state: ScreenState; expires: number }>();

const key = (sessionId: string) => `sightline:session:${sessionId}`;

export async function readSession(sessionId: string): Promise<ScreenState> {
  if (redis) {
    const state = await redis.get<ScreenState>(key(sessionId));
    return state ?? EMPTY;
  }
  const hit = memory.get(sessionId);
  if (!hit || hit.expires < Date.now()) {
    memory.delete(sessionId);
    return EMPTY;
  }
  return hit.state;
}

async function writeSession(sessionId: string, state: ScreenState): Promise<void> {
  if (redis) {
    await redis.set(key(sessionId), state, { ex: TTL_SECONDS });
    return;
  }
  memory.set(sessionId, { state, expires: Date.now() + TTL_SECONDS * 1000 });
}

export async function putFrame(sessionId: string, frame: string): Promise<void> {
  const state = await readSession(sessionId);
  await writeSession(sessionId, { ...state, frame, frameAt: Date.now() });
}

export async function putCaption(sessionId: string, text: string): Promise<void> {
  const state = await readSession(sessionId);
  const captions = [...state.captions, { text, at: Date.now() }].slice(-CAPTION_LIMIT);
  await writeSession(sessionId, { ...state, captions });
}

export async function endSession(sessionId: string): Promise<void> {
  if (redis) await redis.del(key(sessionId));
  else memory.delete(sessionId);
}

/** Human-readable timeline for `get_screen_context` — no vision call, so it's instant. */
export function describeTimeline(state: ScreenState): string {
  if (state.captions.length === 0) {
    return state.frame
      ? "The screen is being shared but hasn't been described yet."
      : "No screen is currently being shared.";
  }
  const now = Date.now();
  const lines = state.captions.map((c) => {
    const secondsAgo = Math.round((now - c.at) / 1000);
    return `- ${secondsAgo}s ago: ${c.text}`;
  });
  return `What has been on the customer's screen recently (oldest first):\n${lines.join("\n")}`;
}
