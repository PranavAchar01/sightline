# Load-bearing code — paste into Codex at 5:00

Scaffold: `pnpm create next-app@latest sightline --ts --tailwind --app --no-src-dir`
Deps: `pnpm add @elevenlabs/react openai`
Env: `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`, `OPENAI_API_KEY`, `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN`

---

## `lib/screen.ts` — capture + perceptual diff gate

```ts
export type Capture = {
  start: () => Promise<void>;
  stop: () => void;
  grab: (maxWidth?: number, quality?: number) => string | null; // data URI
  hasChanged: () => boolean;
};

export function createCapture(): Capture {
  const video = document.createElement("video");
  video.muted = true;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const tiny = document.createElement("canvas");
  tiny.width = 32; tiny.height = 32;
  const tctx = tiny.getContext("2d", { willReadFrequently: true })!;
  let prev: Float32Array | null = null;
  let stream: MediaStream | null = null;

  return {
    async start() {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 2 },
        audio: false,                      // avoid echo w/ the agent's TTS
        selfBrowserSurface: "exclude",     // no hall of mirrors
        monitorTypeSurfaces: "include",    // allow whole-desktop share
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions);
      video.srcObject = stream;
      await video.play();
    },

    stop() {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    },

    grab(maxWidth = 1280, quality = 0.6) {
      if (!video.videoWidth) return null;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality); // ~150KB, under Vercel's 4.5MB
    },

    // 32x32 grayscale mean-abs-delta. Gates vision calls to ~8/min instead of 120.
    hasChanged() {
      if (!video.videoWidth) return false;
      tctx.drawImage(video, 0, 0, 32, 32);
      const d = tctx.getImageData(0, 0, 32, 32).data;
      const luma = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const p = i * 4;
        luma[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      }
      if (!prev) { prev = luma; return true; }
      let sum = 0;
      for (let i = 0; i < 1024; i++) sum += Math.abs(luma[i] - prev[i]);
      prev = luma;
      return sum / 1024 > 6; // tune live: lower = more sensitive
    },
  };
}
```

---

## `components/Call.tsx` — the two channels

```tsx
"use client";
import { useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import { createCapture } from "@/lib/screen";

export default function Call() {
  const cap = useRef(createCapture());
  const [live, setLive] = useState(false);

  const conversation = useConversation({
    // CHANNEL B — pull. Both tools need "Wait for response" ticked in the
    // ElevenLabs tool config or the return value never reaches the LLM.
    clientTools: {
      look_at_screen: async ({ question }: { question: string }) => {
        const frame = cap.current.grab(1280, 0.7);
        if (!frame) return "The screen isn't being shared right now.";
        try {
          const r = await fetch("/api/see", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ frame, question }),
          });
          const { answer } = await r.json();
          return answer;
        } catch {
          return "I couldn't get a clear look at the screen just then.";
        }
      },

      create_support_ticket: async (args: {
        subject: string; summary: string; resolution: string;
      }) => {
        const frame = cap.current.grab(1280, 0.6);
        try {
          const r = await fetch("/api/ticket", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...args, frame }),
          });
          const { id } = await r.json();
          return `Ticket #${id} created in Zendesk.`;
        } catch {
          return "I couldn't reach Zendesk — I'll note it for follow-up.";
        }
      },
    },
    onConnect: () => setLive(true),
    onDisconnect: () => setLive(false),
  });

  // CHANNEL A — ambient push. Silent; never triggers a response.
  useEffect(() => {
    if (!live) return;
    let last = 0;
    const id = setInterval(async () => {
      const stale = Date.now() - last > 8000;
      if (!cap.current.hasChanged() && !stale) return;
      const frame = cap.current.grab(1024, 0.5);
      if (!frame) return;
      last = Date.now();
      const r = await fetch("/api/caption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame }),
      });
      const { caption } = await r.json();
      if (caption) conversation.sendContextualUpdate(`[SCREEN] ${caption}`);
    }, 1500);
    return () => clearInterval(id);
  }, [live, conversation]);

  const start = async () => {
    await cap.current.start();                    // screen picker first
    await conversation.startSession({             // then mic prompt
      agentId: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID!,
      connectionType: "webrtc",
    });
  };

  const stop = async () => {
    await conversation.endSession();
    cap.current.stop();
  };

  return live
    ? <button onClick={stop}>End call</button>
    : <button onClick={start}>Start call</button>;
}
```

---

## `app/api/caption/route.ts` — ambient, cheap + fast

```ts
import OpenAI from "openai";
const openai = new OpenAI();

export async function POST(req: Request) {
  const { frame } = await req.json();
  const r = await openai.responses.create({
    model: "gpt-5.2",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text:
          "One sentence: what app/page is this and what is the user doing? " +
          "Quote any visible error text verbatim. No preamble." },
        { type: "input_image", image_url: frame, detail: "low" },
      ],
    }],
    max_output_tokens: 90,
  });
  return Response.json({ caption: r.output_text?.trim() ?? "" });
}
```

## `app/api/see/route.ts` — on-demand, full detail

Same shape, `detail: "high"`, prompt = the agent's `question`, `max_output_tokens: 200`.

## `app/api/ticket/route.ts` — Zendesk

```ts
export async function POST(req: Request) {
  const { subject, summary, resolution, frame } = await req.json();
  const auth = Buffer.from(
    `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
  ).toString("base64");

  const res = await fetch(
    `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: {
          subject,
          comment: { body: `${summary}\n\nResolution: ${resolution}\n\n— filed by Sightline voice agent` },
          tags: ["sightline", "voice-agent"],
        },
      }),
    }
  );
  const { ticket } = await res.json();
  return Response.json({ id: ticket.id });
}
```
*(Screenshot attachment is a second call to `/api/v2/uploads.json` — do it only if you have time after 6:20.)*

---

## ElevenLabs agent config checklist

- LLM: **GPT-5.2**
- Tool `look_at_screen` — param `question` (string, required). **Wait for response: ON.** Timeout generous.
- Tool `create_support_ticket` — params `subject`, `summary`, `resolution`. **Wait for response: ON.**
- MCP servers: attach for web/docs lookup.
- Agent is **public** for the demo (client-side `agentId` only, no token route).
- System prompt: *"You are a support specialist on a live call. You can see the customer's screen — `[SCREEN]` messages are live observations. Reference what you see specifically: 'the red banner under the Billing tab', never 'an error'. Never ask the customer to describe their screen — call look_at_screen instead. When the issue is resolved, offer to file a ticket."*
