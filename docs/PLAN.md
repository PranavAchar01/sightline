# Screen-Aware Voice Support Agent — Hackathon Battle Plan
**Event:** OpenAI × Start2 × Zendesk Hackathon · Thu Jul 23, 4:00–8:00 PM · Hanwha AI Center, 300 Grant Ave Ste 500, SF

---

## 1. The constraints that actually bind

| Constraint | Reality | What it forces |
|---|---|---|
| **Build window** | 5:00–7:00 PM, submissions close 6:45 → **1h45m of real build time** | Zero architecture decisions made at the event. Everything below is pre-decided. Scaffold + keys + deploy pipeline done *before* 5:00. |
| **"Featured APIs"** | 2–3 APAC dev-tool companies, **not announced yet**. Presentation nomination asks for "the API used." ElevenLabs is US — likely *not* a featured API. | **Highest risk to the idea.** Architect one deliberately swappable subsystem you wire to whatever they announce at 4:15–5:00. Do not let the voice layer be your "featured API" answer. |
| **Presentation slots** | Capped at 5, self-nominated, reviewed and selected | Demo-ready by **6:30**, nomination submitted by **6:35**. The one-liner is a real artifact — write it in advance. |
| **Judges** | OpenAI, Zendesk, Start2, sponsors. Prize = OpenAI credits + **Zendesk Suite** | The story must be a *support* story. Touching the actual Zendesk API is the single highest-ROI 20 minutes of the build. |
| **Build tool** | "Build with Codex" is the stated premise | Drive implementation through Codex at the event. Have the spec ready to paste. |
| **Venue** | Conference wifi, projector, ~5 min on stage | Hotspot as backup. Pre-recorded 60s screen capture as fallback. Never live-demo on venue wifi without one. |
| **Browser reality** | `getDisplayMedia()` is **not Baseline** — desktop Chrome/Edge solid, Safari/Firefox partial, **no mobile** | Demo on a desktop Chrome you control. Say "desktop web" in the pitch, don't let a judge discover it. |

**Free time you're not using:** doors 4:00, tech demos 4:15–5:00. That's 45 minutes to create accounts, provision keys, get the Zendesk trial, and deploy a hello-world. Use it.

---

## 2. The one thing wrong with the idea as stated (and the fix)

**ElevenLabs Agents cannot see.** They are audio-in → audio-out. There is no image channel. MCP tools give the agent *web* access, not *screen* access. If you show up planning to "connect the screen to the ElevenLabs agent," there is nothing to connect it to.

**The fix, and it's the actual technical insight of the project:** the screen reaches the agent as **text**, through two channels running simultaneously.

### Channel A — Ambient push (`sendContextualUpdate`)
A throttled loop captions the screen with an OpenAI vision model and pushes a one-line state summary into the conversation. `sendContextualUpdate()` injects context **without triggering a response** — the agent silently always knows where the user is. Zero added latency at answer time.

### Channel B — On-demand pull (client tool `look_at_screen`)
A registered ElevenLabs **client tool** with *Wait for response* enabled. When the agent needs detail ("what's the error code say?"), it calls the tool, the browser grabs the freshest frame at full resolution, sends it to OpenAI vision with the specific question, and returns a string that lands back in the conversation context.

**Why both:** Channel A means ~80% of questions are answered from context with **no tool call and no added latency** — the agent feels like it's actually watching. Channel B handles the "read me that exact string" cases where you need pixels. Say this on stage; it's the part that sounds like engineering rather than plumbing.

**Latency budget:** ElevenLabs turn latency ~600ms. A vision call adds 800–1500ms. Ambient push is what makes it feel real-time. Design so the tool call is the exception.

---

## 3. Architecture (locked)

```
┌─ Browser (Next.js on Vercel, desktop Chrome) ────────────────┐
│                                                               │
│  getDisplayMedia() ──▶ <video> ──▶ <canvas>                   │
│         │                             │                       │
│         │                    ┌────────┴────────┐              │
│         │                    │  perceptual     │              │
│         │                    │  diff (32×32)   │              │
│         │                    └────────┬────────┘              │
│         │                   changed? or 8s elapsed             │
│         │                             ▼                       │
│         │                    POST /api/caption ──▶ OpenAI      │
│         │                             │            vision      │
│         │                             ▼                       │
│         │              conversation.sendContextualUpdate(txt)  │
│         │                                                      │
│  @elevenlabs/react useConversation (WebRTC)                    │
│         │  clientTools: { look_at_screen, create_ticket }       │
│         │                                                       │
│         └──▶ look_at_screen(q) ──▶ POST /api/see ──▶ OpenAI     │
│                                                      vision     │
│         └──▶ create_ticket(...) ──▶ POST /api/ticket ──▶ Zendesk│
└───────────────────────────────────────────────────────────────┘
                             │
                  ElevenLabs Agent (LLM: GPT-5.2)
                  + MCP servers for web/general knowledge
```

**Stack:** Next.js App Router + TypeScript + Tailwind, `pnpm`, deployed on Vercel. One `vercel --prod`. No Electron, no Chrome extension.

**Why browser over Electron/extension:**
- Zero install — a judge can open the URL on their own laptop mid-Q&A. That moment wins rooms.
- Vercel deploy in 40 seconds vs. codesigning hell.
- Chrome's own "Sharing your screen" bar is a free trust signal for an enterprise support product.
- `monitorTypeSurfaces: 'include'` lets them share the **whole desktop**, so the agent watches the real Zendesk web app in another window. This is what makes the demo not look like a toy.

**ElevenLabs agent config:**
- LLM: **GPT-5.2** (ElevenLabs' own docs recommend high-intelligence models for tool calling; also keeps the whole reasoning path OpenAI, which matters in this room)
- Client tools: `look_at_screen`, `create_support_ticket` — both with **Wait for response** ticked, generous response timeout
- MCP servers: web search / docs, as you planned (ElevenLabs supports SSE + HTTP streamable custom MCP servers)
- System prompt: "You are a support specialist on a live call. You can see the customer's screen. Reference what you see specifically — say 'the red banner under the Billing tab', not 'an error'. Never ask the customer to describe what's on screen; look instead."

---

## 4. The Zendesk play (this is the win condition)

Do **not** pitch "a voice assistant that can see your screen." Pitch the support-call failure mode everyone in that room has lived.

> **The pitch:** Tier-1 support dies on one sentence — *"Can you describe what you're seeing?"* The customer can't. The agent can't guess. Average handle time balloons. So: the customer shares their screen, and the AI support agent *looks*.

**The closing move that wins the Zendesk prize:** at the end of the call, the agent calls `create_support_ticket` — a real `POST /api/v2/tickets` against a Zendesk trial subdomain — filing a ticket with the transcript summary, the resolution, and **the screenshot attached**. On stage: switch to the actual Zendesk inbox, the ticket is sitting there.

That's the "it writes itself into your product" beat. Get a Zendesk trial subdomain + API token during the 4:15–5:00 window; basic auth with `email/token:APITOKEN` is all it takes.

**Expansion line for the last 20 seconds (agent-facing framing):** "Flip the camera around and it's a co-pilot for *your* support agents — watching their screen, hearing the customer, drafting the ticket. Zendesk says AI saves teams 7.3 hours a week. This is where the next 7 come from." Mirroring their own metric back at them is cheap and it lands.

---

## 5. Timeline

| Time | Do |
|---|---|
| **Before 4:00** | Repo scaffolded, Vercel project linked, hello-world deployed, ElevenLabs agent created, OpenAI key in env. This is *setup*, not the build. |
| **4:00–4:15** | Arrive, seat, wifi, hotspot tested. |
| **4:15–5:00** | Tech demos — **listen for which APAC APIs are featured.** Simultaneously: Zendesk trial + API token, verify a test ticket via curl. |
| **5:00–5:15** | Decide the featured-API slot. Wire it into the one swappable subsystem. |
| **5:15–6:00** | Core loop: screen capture → diff → caption → `sendContextualUpdate`. Get the agent visibly reacting to the screen. **This is the demo. Everything after is garnish.** |
| **6:00–6:20** | `look_at_screen` client tool + `/api/see`. |
| **6:20–6:35** | `create_support_ticket` → Zendesk. Deploy prod. **Submit the nomination.** |
| **6:35–6:45** | Rehearse the 5-min demo twice, end to end, on the deployed URL. Record the fallback video. |
| **6:45–7:00** | Freeze. No commits. |

**Hard rule:** if 5:15–6:00 slips, cut `create_support_ticket` and fake the Zendesk screenshot. Never cut the ambient loop.

---

## 6. Demo script (5 minutes, to the second)

**0:00–0:30 — The problem, no slides.** "Every support call has the same dead 40 seconds: *can you describe what you're seeing?* Watch what happens when the agent can just look."

**0:30–1:00 — Start the call.** Click Start. Mic prompt, screen picker, pick *Entire Screen*. Agent greets: *"Hey — I can see your screen. What's going on?"* Say nothing else. Let the room register that it opened unprompted.

**1:00–2:30 — The see-it moment.** Have a broken app open (a fake SaaS billing page with a cryptic error). Ask vaguely: *"It's not letting me pay."* Agent, without being told: *"I see the card form under Billing — there's a red banner reading declined, code AVS_MISMATCH. Your billing ZIP is 94108 but the card on file was added with a different one. Click Edit next to the card."* **Do not narrate.** Silence sells this.

**2:30–3:15 — The pull channel.** Scroll to something small — a log line, an order ID. *"What's that reference number?"* Agent reads it back exactly. This proves it's real pixels, not a scripted response. **This is your anti-skeptic beat** — a judge is at this moment wondering if it's hardcoded.

**3:15–4:00 — The Zendesk close.** *"Can you file this for me?"* Agent confirms, calls the tool. Alt-tab to the live Zendesk inbox. Ticket is there — summary, resolution, screenshot attached. Say: "That's a real ticket in a real Zendesk instance, created by the voice agent, sixty seconds ago."

**4:00–4:45 — Expansion + how.** The agent-facing flip. Then one line of architecture: "Voice models can't see. So we run two channels — an ambient loop that captions the screen only when it changes and pushes it into the agent's context for free, and a tool call for when it needs to read exact pixels. That's why it answers instantly instead of thinking for two seconds."

**4:45–5:00 — Ask.** Name the featured API you used and what you'd build next.

**Rules:** rehearse twice. Deployed URL, never localhost. Hotspot on. Fallback video queued in a background tab. Do not resize windows mid-demo. Close Slack/Mail — you are sharing your entire screen to a projector.

---

## 7. Gotchas that will cost you 30 minutes each if you hit them cold

1. **Vercel body limit (4.5MB).** Downscale frames to ≤1280px wide, JPEG q=0.6 → ~150KB. A raw 1080p base64 PNG will 413 and you'll blame the wrong thing.
2. **Client tool timeout.** Keep vision calls short (`detail: low` for ambient, capped output tokens). Return a fallback string on error — never throw out of the tool handler, it poisons the turn.
3. **Audio echo.** Set `audio: false` in `getDisplayMedia`. You don't need tab audio and it fights the mic.
4. **Infinite mirror.** `selfBrowserSurface: 'exclude'` or sharing your own tab creates a hall of mirrors on the projector.
5. **Permission order.** Mic prompt then screen picker, one user gesture each. Two prompts stacked looks broken.
6. **Vision cost/latency.** Perceptual diff gate (32×32 grayscale, mean abs delta) drops you from 60 calls/min to ~8. Also a good stage line: "we only pay for a frame when the screen actually changes."
7. **Public vs. private agent.** A public ElevenLabs agent needs only `agentId` client-side. Private needs a signed URL / conversation token from a server route. Use public for the demo; don't burn build time on auth.

---

## 8. Naming

`Sightline` · `Shoulder` (as in over-the-shoulder support) · `Second Pair`

## 9. Nomination one-liner (draft)

> **Sightline** — a voice support agent that watches the customer's screen in real time, diagnoses the problem by looking instead of asking, and files the Zendesk ticket itself. Built on OpenAI vision + GPT-5.2, ElevenLabs Agents, and [featured API].
