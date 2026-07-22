# Architecture

## The problem

ElevenLabs Agents are audio-in, audio-out. There is no image channel. So the screen
has to reach the agent some other way — and the obvious route, an MCP connector, has
a hole in it:

> ElevenLabs calls an MCP server **from their backend**, not from the browser.

The MCP server has no `getDisplayMedia`, no DOM, no pixels. Something has to carry
frames from the customer's browser to a server ElevenLabs can reach, and something has
to get those frames in front of the model *while it is thinking*.

## The unlock: Custom LLM

ElevenLabs Agents accept a **Custom LLM** — any OpenAI-compatible
`/v1/chat/completions` endpoint. Point the agent at [`/api/llm`](../app/api/llm) and
every turn of the conversation passes through our server on its way to the model.

So we attach the customer's live screen frame to the request before forwarding it.

**The agent's own reasoning model sees the screen every single time it thinks.** No
tool call. No captioning lag. No round trip. The model is not told *about* the screen —
it is looking at it, on the same turn it's forming a reply.

This is what "fully live" means here, and it's why captioning and `look_at_screen`
demoted from *the mechanism* to *escalation paths*.

```
  Browser (customer)                 Vercel                       ElevenLabs
  ──────────────────                 ──────                       ──────────
  getDisplayMedia()
        │
  requestVideoFrameCallback
        │  (fires per decoded frame)
        ├─ 32×32 diff gate
        │
        └─ POST /api/session/:id ──▶ store frame ──▶ Redis
                                     caption (on change)
                                              │
                                              ▼
                        ┌──── readSession() ──┴──┐
                        │                        │
   agent turn ─────────▶│  POST /api/llm         │  ← ElevenLabs Custom LLM
                        │  attach frame + timeline│
                        │  ──▶ OpenAI ──▶ SSE ───┼──▶ streamed straight back
                        └────────────────────────┘
                        │
   needs exact text ───▶│  POST /api/mcp  look_at_screen(high detail)
                        └────────────────────────
```

## Three tiers of sight

| Tier | Mechanism | Cost | When |
|---|---|---|---|
| **Live** | Custom LLM proxy injects the frame at `detail: low` | ~85 tokens/turn | Every turn, automatically |
| **Temporal** | Captions stored server-side, replayed as a timeline | 1 vision call per screen change | So the model knows what changed *between* turns |
| **Deep** | MCP `look_at_screen` at `detail: high` | 1 vision call, on request | Reading exact characters — error codes, reference numbers |

Low detail on the live tier is deliberate. It's plenty to know which page the customer
is on and whether something is visibly broken, which covers almost every question. When
the agent needs to read exact characters it escalates to the deep tier and pays for one
full-detail frame.

## Capture is compositor-driven, not timer-driven

`lib/screen.ts` drives off `requestVideoFrameCallback`, which fires once per decoded
frame, so we react the moment the screen changes rather than up to a tick late. A 32×32
grayscale mean-absolute-delta then decides whether a frame is worth uploading — without
that gate this would be ~120 uploads a minute instead of ~8.

Uploads run with bounded concurrency (2 in flight). A single serialized request would
mean one slow caption stalls the whole stream, and the frame the model sees goes stale
exactly when the screen is most active.

Safari and older Chromium fall back to a 500ms poll.

## Session correlation

MCP and Custom LLM config in ElevenLabs are both static — a URL, a secret, fixed
headers, set once. There is no per-conversation header. So the session id travels as
data, and [`lib/inject.ts`](../lib/inject.ts) tries four routes in order:

1. `session_id` at the top level of the request body
2. `elevenlabs_extra_body.session_id`
3. `?session_id=` on the server URL
4. **scraped out of the resolved system prompt** — the agent is always told
   `Your session id is {{session_id}}`, so this one cannot realistically fail

Route 4 is the safety net: even if the dashboard's extra-body config is wrong or
missing, the proxy still finds the right browser. All four are covered by
[`tests/inject.test.ts`](../tests/inject.test.ts).

The response carries `X-Sightline-Screen: attached|none` and `X-Sightline-Session`, so
when something is wrong you can tell a bad API key apart from a broken bridge without
guessing.

## Why Redis is not optional in production

`lib/store.ts` falls back to an in-memory `Map` so `next dev` works with no setup. On
Vercel that fallback is a trap: the browser's `POST /api/session/:id` and ElevenLabs'
`POST /api/llm` land on **different serverless instances**, so the proxy would inject
nothing while the browser insists it's streaming fine — and the symptom is an agent
that politely asks you to describe your screen.

Provision Upstash Redis before deploying. Frames carry a 300s TTL.

## MCP vs. client tools

`components/Call.tsx` also registers `look_at_screen` as an ElevenLabs **client tool**
hitting `/api/see`. Both paths call the same `lib/vision.ts`, so they cannot drift.

| | MCP (`/api/mcp`) | Client tool (`/api/see`) |
|---|---|---|
| Hops | ElevenLabs → Vercel → OpenAI | Browser → Vercel → OpenAI |
| Latency | Higher | Lower |
| Works when browser is closed | Yes | No |
| Portable to other agents | Yes | No |

Configure the agent with **one or the other, never both** — duplicate tool names
confuse the model.

## Files

```
app/
  page.tsx                      landing + demo surface
  api/llm/[[...path]]/route.ts  ★ Custom LLM proxy — injects the live screen
  api/mcp/route.ts              MCP server (deep tier + ticketing)
  api/session/[id]/route.ts     browser pushes frames, gets captions back
  api/see/route.ts              client-tool fast path for look_at_screen
lib/
  screen.ts                     rVFC capture + 32×32 perceptual diff gate
  store.ts                      the session bridge (Redis | in-memory)
  inject.ts                     session resolution + screen splicing (tested)
  vision.ts                     OpenAI vision — caption() and inspect()
  zendesk.ts                    ticket creation + screenshot upload
components/
  Call.tsx                      conversation wiring + live loop + observation feed
tests/
  inject.test.ts                12 cases over the proxy's pure logic
```
