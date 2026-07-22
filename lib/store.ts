import { del, get, put } from "@vercel/blob";
import { Redis } from "@upstash/redis";

/**
 * The session bridge.
 *
 * ElevenLabs calls the Custom LLM proxy and the MCP server from *their* backend, so
 * neither has access to the browser that is sharing its screen. The browser pushes
 * frames and captions in here keyed by session id; the proxy reads them back out.
 *
 * On Vercel this cannot be process memory. `POST /api/session/:id` and `POST /api/llm`
 * are different route handlers, so they are different function instances — always.
 * The symptom of getting this wrong is an agent that politely asks the customer to
 * describe their screen while the browser insists it is streaming perfectly.
 *
 * Three backends, in order of preference:
 *   Redis  — fastest, if UPSTASH_REDIS_REST_URL is configured
 *   Blob   — durable and provisioned by default here; ~200ms reads
 *   memory — `next dev` only, so the repo runs with zero setup
 *
 * Frame and captions live in separate keys on purpose. Heartbeats rewrite only the
 * frame, which avoids a read-modify-write of ~150KB every few seconds.
 */

export type ScreenState = {
  /** Latest frame as a JPEG data URI. */
  frame: string | null;
  frameAt: number;
  /** Rolling captions, oldest first, capped at CAPTION_LIMIT. */
  captions: { text: string; at: number }[];
};

const TTL_SECONDS = 300;
const CAPTION_LIMIT = 12;
const EMPTY: ScreenState = { frame: null, frameAt: 0, captions: [] };

const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null;

const blobEnabled = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export const backend: "redis" | "blob" | "memory" = redis
  ? "redis"
  : blobEnabled
    ? "blob"
    : "memory";

type Frame = { frame: string; frameAt: number };
type Captions = { captions: ScreenState["captions"] };

const memory = new Map<string, { state: ScreenState; expires: number }>();

const framePath = (id: string) => `sessions/${id}/frame.json`;
const captionPath = (id: string) => `sessions/${id}/captions.json`;
const redisKey = (id: string) => `sightline:session:${id}`;

const LATEST_PATH = "sessions/_latest.json";
const LATEST_KEY = "sightline:latest";
const DEBUG_PATH = "debug/last.json";
const DEBUG_KEY = "sightline:debug";

type Latest = { sessionId: string; at: number };

/** Diagnostic breadcrumb — what the last inbound agent call actually resolved to. */
export type Trace = {
  at: number;
  route: string;
  /** Where the session id came from, or why it couldn't be found. */
  via: string;
  sessionId: string | null;
  screen: "attached" | "none";
  note?: string;
};

async function blobRead<T>(pathname: string): Promise<T | null> {
  try {
    // useCache:false is essential — a CDN-cached frame would mean the agent looks at
    // a screen the customer left thirty seconds ago.
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result?.stream) return null;
    return JSON.parse(await new Response(result.stream).text()) as T;
  } catch {
    return null;
  }
}

async function blobWrite(pathname: string, value: unknown): Promise<void> {
  await put(pathname, JSON.stringify(value), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  });
}

export async function readSession(sessionId: string): Promise<ScreenState> {
  if (redis) {
    return (await redis.get<ScreenState>(redisKey(sessionId))) ?? EMPTY;
  }

  if (blobEnabled) {
    const [frame, captions] = await Promise.all([
      blobRead<Frame>(framePath(sessionId)),
      blobRead<Captions>(captionPath(sessionId)),
    ]);
    if (!frame && !captions) return EMPTY;
    const fresh = frame && Date.now() - frame.frameAt < TTL_SECONDS * 1000;
    return {
      frame: fresh ? frame.frame : null,
      frameAt: fresh ? frame.frameAt : 0,
      captions: captions?.captions ?? [],
    };
  }

  const hit = memory.get(sessionId);
  if (!hit || hit.expires < Date.now()) {
    memory.delete(sessionId);
    return EMPTY;
  }
  return hit.state;
}

/** Remember which session last pushed a frame, so a lost id can still be recovered. */
async function markLatest(sessionId: string): Promise<void> {
  const value: Latest = { sessionId, at: Date.now() };
  if (redis) {
    await redis.set(LATEST_KEY, value, { ex: TTL_SECONDS });
    return;
  }
  if (blobEnabled) {
    await blobWrite(LATEST_PATH, value);
    return;
  }
  latestMemory = value;
}

let latestMemory: Latest | null = null;

/**
 * The session id the browser most recently pushed a frame for.
 *
 * This exists because every route by which an agent tells us its session id runs
 * through ElevenLabs' dashboard config, and any of them can be silently
 * misconfigured — the symptom being an agent that insists no screen is shared while
 * the browser is visibly streaming.
 *
 * Falling back to "the session that is actually live right now" is correct for one
 * concurrent call and wrong for many, so it is used only when the id is missing or
 * unknown, and every use is recorded in the trace.
 */
export async function latestSessionId(): Promise<string | null> {
  let value: Latest | null = null;
  if (redis) value = await redis.get<Latest>(LATEST_KEY);
  else if (blobEnabled) value = await blobRead<Latest>(LATEST_PATH);
  else value = latestMemory;

  if (!value) return null;
  return Date.now() - value.at < TTL_SECONDS * 1000 ? value.sessionId : null;
}

export async function putTrace(trace: Trace): Promise<void> {
  try {
    if (redis) await redis.set(DEBUG_KEY, trace, { ex: TTL_SECONDS });
    else if (blobEnabled) await blobWrite(DEBUG_PATH, trace);
    else traceMemory = trace;
  } catch {
    // Diagnostics must never break a live call.
  }
}

let traceMemory: Trace | null = null;

export async function readTrace(): Promise<Trace | null> {
  if (redis) return (await redis.get<Trace>(DEBUG_KEY)) ?? null;
  if (blobEnabled) return await blobRead<Trace>(DEBUG_PATH);
  return traceMemory;
}

export async function putFrame(sessionId: string, frame: string): Promise<void> {
  await markLatest(sessionId);

  if (redis) {
    const state = await readSession(sessionId);
    await redis.set(redisKey(sessionId), { ...state, frame, frameAt: Date.now() }, { ex: TTL_SECONDS });
    return;
  }

  if (blobEnabled) {
    // No read first — this is the hot path, called on every heartbeat.
    await blobWrite(framePath(sessionId), { frame, frameAt: Date.now() });
    return;
  }

  const state = await readSession(sessionId);
  memory.set(sessionId, {
    state: { ...state, frame, frameAt: Date.now() },
    expires: Date.now() + TTL_SECONDS * 1000,
  });
}

export async function putCaption(sessionId: string, text: string): Promise<void> {
  const state = await readSession(sessionId);
  const captions = [...state.captions, { text, at: Date.now() }].slice(-CAPTION_LIMIT);

  if (redis) {
    await redis.set(redisKey(sessionId), { ...state, captions }, { ex: TTL_SECONDS });
    return;
  }
  if (blobEnabled) {
    await blobWrite(captionPath(sessionId), { captions });
    return;
  }
  memory.set(sessionId, {
    state: { ...state, captions },
    expires: Date.now() + TTL_SECONDS * 1000,
  });
}

export async function endSession(sessionId: string): Promise<void> {
  if (redis) {
    await redis.del(redisKey(sessionId));
    return;
  }
  if (blobEnabled) {
    // Best effort — the TTL check in readSession is the real guarantee.
    await Promise.all([
      del(framePath(sessionId)).catch(() => {}),
      del(captionPath(sessionId)).catch(() => {}),
    ]);
    return;
  }
  memory.delete(sessionId);
}

/** Human-readable timeline for `get_screen_context` — no vision call, so it's instant. */
export function describeTimeline(state: ScreenState): string {
  if (state.captions.length === 0) {
    return state.frame
      ? "The screen is being shared but hasn't been described yet."
      : "No screen is currently being shared.";
  }
  const now = Date.now();
  const lines = state.captions.map((c) => `- ${Math.round((now - c.at) / 1000)}s ago: ${c.text}`);
  return `What has been on the customer's screen recently (oldest first):\n${lines.join("\n")}`;
}
