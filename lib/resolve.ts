import { latestSessionId, readSession, type ScreenState } from "@/lib/store";

/**
 * Turn whatever the agent claimed its session was into a screen we can actually show
 * it — and record how we got there.
 *
 * Every channel by which an agent can tell us its session id passes through
 * ElevenLabs dashboard configuration, and any of them can be silently wrong. When
 * that happens the failure is invisible from the outside: the agent simply says no
 * screen is being shared while the browser is streaming perfectly. So this resolver
 * degrades rather than fails, and always reports which path it took.
 */

export type Resolution = {
  sessionId: string | null;
  state: ScreenState;
  /** How the session was found — surfaced in /api/debug and response headers. */
  via: "claimed" | "fallback-latest" | "none";
  note?: string;
};

const EMPTY: ScreenState = { frame: null, frameAt: 0, captions: [] };

export async function resolveScreen(claimed: string | null): Promise<Resolution> {
  if (claimed) {
    const state = await readSession(claimed);
    if (state.frame) return { sessionId: claimed, state, via: "claimed" };
  }

  // Either no id reached us, or the id we were given has no screen behind it.
  const latest = await latestSessionId();
  if (latest && latest !== claimed) {
    const state = await readSession(latest);
    if (state.frame) {
      return {
        sessionId: latest,
        state,
        via: "fallback-latest",
        note: claimed
          ? `Agent claimed session ${claimed}, which has no frame. Used the live session instead.`
          : "No session id reached the server. Used the live session instead.",
      };
    }
  }

  return {
    sessionId: claimed,
    state: EMPTY,
    via: "none",
    note: "No session has pushed a frame recently — the browser is probably not sharing.",
  };
}
