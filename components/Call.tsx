"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createCapture, type Capture } from "@/lib/screen";

/**
 * More than this in flight and we're uploading faster than the network can drain.
 * Two lets a slow caption overlap with the next heartbeat instead of stalling it.
 */
const MAX_IN_FLIGHT = 2;

/**
 * When the agent runs on the live-sight proxy (the default), the proxy injects the
 * screen into every turn and pushing captions again would just duplicate tokens.
 * Set NEXT_PUBLIC_FALLBACK_CONTEXT=1 if the agent is on a stock LLM instead, where
 * sendContextualUpdate is the only way in.
 */
const FALLBACK_CONTEXT = process.env.NEXT_PUBLIC_FALLBACK_CONTEXT === "1";

type Observation = { text: string; at: number };

export default function Call() {
  // useConversation requires a provider ancestor; keeping it here makes the
  // component drop-in anywhere without the page having to know.
  return (
    <ConversationProvider>
      <CallSurface />
    </ConversationProvider>
  );
}

function CallSurface() {
  const capture = useRef<Capture | null>(null);
  const sessionId = useRef<string>("");
  const inFlight = useRef(0);

  const [live, setLive] = useState(false);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [frames, setFrames] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const conversation = useConversation({
    /**
     * Escalation path. The proxy shows the model every screen at low detail; this
     * pays for full detail on one frame when it needs to read exact characters.
     * Mirrors the MCP tool of the same name — configure the agent with one or the
     * other, never both.
     */
    clientTools: {
      look_at_screen: async ({ question }: { question: string }) => {
        const frame = capture.current?.grab(1280, 0.7);
        if (!frame) return "The screen isn't being shared right now.";
        try {
          const res = await fetch("/api/see", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ frame, question }),
          });
          const { answer } = await res.json();
          return answer as string;
        } catch {
          return "I couldn't get a clear look at the screen just then.";
        }
      },
    },
    onConnect: () => setLive(true),
    onDisconnect: () => setLive(false),
    onError: (message) => setError(String(message)),
  });

  const { sendContextualUpdate, startSession, endSession } = conversation;

  const stop = useCallback(async () => {
    try {
      await endSession();
    } catch {
      // Already disconnected — nothing to unwind.
    }
    capture.current?.stop();
    if (sessionId.current) {
      void fetch(`/api/session/${sessionId.current}`, { method: "DELETE" });
    }
    setLive(false);
  }, [endSession]);

  const start = useCallback(async () => {
    setError(null);
    setObservations([]);
    setFrames(0);
    inFlight.current = 0;

    const cap = createCapture();
    capture.current = cap;
    sessionId.current = crypto.randomUUID();

    try {
      // Screen picker first, then the mic prompt — one user gesture each, stacked
      // prompts look broken.
      await cap.start();
      // Chrome's own "Stop sharing" button should end the call too.
      cap.onEnded(() => void stop());
    } catch {
      setError("Screen sharing was cancelled.");
      return;
    }

    // Prime the bridge before the agent can possibly ask anything, so its very
    // first turn already has a frame to look at.
    const first = cap.grab(1024, 0.5);
    if (first) {
      await fetch(`/api/session/${sessionId.current}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame: first, describe: true }),
      }).catch(() => {});
    }

    try {
      await startSession({
        agentId: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID!,
        connectionType: "webrtc",
        // Three independent routes to the proxy, because any one of them can be
        // defeated by dashboard config:
        //   customLlmExtraBody — goes straight into the proxy's request body. This
        //     is the reliable one; it needs nothing configured in the dashboard.
        //   dynamicVariables   — resolves {{session_id}} in the system prompt, which
        //     is what the MCP tools read, and what the proxy scrapes as a fallback.
        customLlmExtraBody: { session_id: sessionId.current },
        dynamicVariables: { session_id: sessionId.current },
      });
    } catch {
      cap.stop();
      setError("Couldn't connect to the voice agent. Check NEXT_PUBLIC_ELEVENLABS_AGENT_ID.");
    }
  }, [startSession, stop]);

  // The live channel: compositor-driven, not timer-driven.
  useEffect(() => {
    if (!live) return;
    const cap = capture.current;
    if (!cap) return;

    const unsubscribe = cap.subscribe(({ changed }) => {
      if (inFlight.current >= MAX_IN_FLIGHT) return;

      // A changed screen is worth captioning; a heartbeat only needs to refresh
      // the stored frame so the proxy never injects something stale.
      const frame = cap.grab(changed ? 1024 : 768, changed ? 0.5 : 0.4);
      if (!frame) return;

      inFlight.current += 1;
      void (async () => {
        try {
          const res = await fetch(`/api/session/${sessionId.current}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ frame, describe: changed }),
          });
          setFrames((n) => n + 1);

          const { caption } = await res.json();
          if (caption) {
            if (FALLBACK_CONTEXT) sendContextualUpdate(`[SCREEN] ${caption}`);
            setObservations((prev) => [...prev.slice(-7), { text: caption, at: Date.now() }]);
          }
        } catch {
          // A dropped frame is not worth surfacing; the next one is milliseconds away.
        } finally {
          inFlight.current -= 1;
        }
      })();
    });

    return unsubscribe;
  }, [live, sendContextualUpdate]);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={live ? stop : start}
          className={`rounded-full px-8 py-4 text-lg font-medium transition ${
            live
              ? "bg-red-600 text-white hover:bg-red-500"
              : "bg-white text-black hover:bg-neutral-200"
          }`}
        >
          {live ? "End call" : "Start call"}
        </button>

        {live && (
          <span className="flex items-center gap-2 text-sm text-neutral-400">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            {conversation.isSpeaking ? "Agent is speaking" : "Watching and listening"}
            <span className="text-neutral-600">· {frames} frames</span>
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {live && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-950/80 p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            What the agent is seeing
          </h2>
          {observations.length === 0 ? (
            <p className="text-sm text-neutral-600">Waiting for the first frame…</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {observations.map((o) => (
                <li key={o.at} className="text-sm leading-relaxed text-neutral-300">
                  <span className="mr-2 text-neutral-600">
                    {new Date(o.at).toLocaleTimeString([], {
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  {o.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
