"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createCapture, type Capture } from "@/lib/screen";

/** How often we look for a change. */
const TICK_MS = 1500;
/** Caption at least this often even if the screen looks static. */
const CAPTION_FLOOR_MS = 10_000;
/** Keep the stored frame fresher than the MCP server's staleness cutoff. */
const HEARTBEAT_MS = 5_000;

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
  const lastCaption = useRef(0);
  const lastHeartbeat = useRef(0);
  const inFlight = useRef(false);

  const [live, setLive] = useState(false);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const conversation = useConversation({
    /**
     * The fast path. These mirror the MCP tools exactly — configure the agent with
     * one or the other, never both. MCP is the portable connector; client tools skip
     * a network leg and are noticeably snappier on stage.
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

    try {
      await startSession({
        agentId: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID!,
        connectionType: "webrtc",
        // The agent's system prompt reads {{session_id}} and passes it to every tool.
        // This is what lets a server-side MCP call find the right browser.
        dynamicVariables: { session_id: sessionId.current },
      });
    } catch {
      cap.stop();
      setError("Couldn't connect to the voice agent. Check NEXT_PUBLIC_ELEVENLABS_AGENT_ID.");
    }
  }, [startSession, stop]);

  // The ambient channel.
  useEffect(() => {
    if (!live) return;

    const id = setInterval(async () => {
      const cap = capture.current;
      if (!cap?.isActive() || inFlight.current) return;

      const now = Date.now();
      const changed = cap.hasChanged();
      const overdue = now - lastCaption.current > CAPTION_FLOOR_MS;
      const needsHeartbeat = now - lastHeartbeat.current > HEARTBEAT_MS;

      if (!changed && !overdue && !needsHeartbeat) return;

      const describe = changed || overdue;
      const frame = cap.grab(describe ? 1024 : 640, describe ? 0.5 : 0.4);
      if (!frame) return;

      inFlight.current = true;
      lastHeartbeat.current = now;
      if (describe) lastCaption.current = now;

      try {
        const res = await fetch(`/api/session/${sessionId.current}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frame, describe }),
        });
        const { caption } = await res.json();
        if (caption) {
          // Injects context without triggering a reply — the agent just quietly knows.
          sendContextualUpdate(`[SCREEN] ${caption}`);
          setObservations((prev) => [...prev.slice(-7), { text: caption, at: Date.now() }]);
        }
      } catch {
        // A dropped frame is not worth surfacing; the next tick will retry.
      } finally {
        inFlight.current = false;
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, [live, sendContextualUpdate]);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <div className="flex items-center gap-4">
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
            {conversation.isSpeaking ? "Agent is speaking" : "Listening and watching"}
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
