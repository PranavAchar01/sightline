# Architecture

## The problem this design exists to solve

ElevenLabs Agents are audio-in, audio-out. There is no image channel. So the screen
has to reach the agent as **text**.

And there is a second, sharper problem specific to using **MCP** as the connector:

> ElevenLabs calls an MCP server **from their backend**, not from the browser.

The MCP server therefore cannot call `getDisplayMedia()`. It has no screen. Wiring an
MCP server directly to "the screen" is not a thing that exists — something has to
carry pixels from the customer's browser to a server ElevenLabs can reach.

That carrier is the **session bridge**.

```
  Browser (customer)                Vercel                    ElevenLabs
  ──────────────────                ──────                    ──────────
  getDisplayMedia()
        │
        ├─ 32×32 diff gate
        │  (only on change)
        │
        ├─ POST /api/session/:id ──▶ vision caption ──┐
        │                            store frame       │
        │                            store caption     │
        │                                              │
        │◀───────────── caption ───────────────────────┘
        │
        └─ sendContextualUpdate("[SCREEN] …") ────────────────▶ agent context
                                                                    │
                                                                    │ needs detail
                                                                    ▼
                       /api/mcp ◀──── look_at_screen(session_id, q) ─┘
                          │
                          ├─ readSession(session_id) ──▶ Redis
                          ├─ OpenAI vision (full detail)
                          └─ answer ──────────────────────────────▶ agent speaks
```

## Two channels, on purpose

**Channel A — ambient push.** `sendContextualUpdate()` injects text into the
conversation *without triggering a response*. A diff-gated loop captions the screen
and pushes one line whenever it meaningfully changes. The agent silently always knows
where the customer is, at zero latency when it's time to answer.

**Channel B — on-demand pull.** The MCP tool `look_at_screen`. Costs a round trip, so
it's reserved for reading exact pixels: error codes, reference numbers, field values.

The ratio is the point. Most questions are answered from Channel A with **no tool call
at all** — that's the difference between an agent that's watching and one that pauses
to think. Channel B is the exception, not the mechanism.

## Session correlation

MCP server config in ElevenLabs is static — you set a URL, a secret token, and fixed
headers once. There is no per-conversation header. So the session id travels as a
**tool parameter**, and it gets into the agent's head as a **dynamic variable**:

1. Browser mints `sessionId = crypto.randomUUID()`
2. `startSession({ …, dynamicVariables: { session_id } })`
3. Agent's system prompt contains `Your session id is {{session_id}}.`
4. Agent passes it to every tool call
5. MCP server does `readSession(session_id)` and finds that browser's latest frame

## Why Redis is not optional in production

`lib/store.ts` falls back to an in-memory `Map` so `next dev` works with no setup. On
Vercel that fallback is a trap: the browser's `POST /api/session/:id` and ElevenLabs'
`POST /api/mcp` will land on **different serverless instances**, and every tool call
will report "no screen is being shared" while the browser insists it's streaming fine.

Provision Upstash Redis before deploying. Frames are stored with a 300s TTL.

## MCP vs. client tools

`components/Call.tsx` also registers `look_at_screen` as an ElevenLabs **client tool**
hitting `/api/see`. Both paths call the same `lib/vision.ts`, so they cannot drift.

| | MCP (`/api/mcp`) | Client tool (`/api/see`) |
|---|---|---|
| Hops | ElevenLabs → Vercel → OpenAI | Browser → Vercel → OpenAI |
| Latency | Higher | Lower |
| Works when browser is closed | Yes | No |
| Portable to other agents/platforms | Yes | No |

Configure the agent with **one or the other, never both** — duplicate tool names will
confuse the model. MCP is the connector story and the more general system; client
tools are the fast path if the stage demo needs every millisecond.

## Files

```
app/
  page.tsx                     landing + demo surface
  api/mcp/route.ts             MCP server ElevenLabs connects to
  api/session/[id]/route.ts    browser pushes frames + gets captions back
  api/see/route.ts             client-tool fast path for look_at_screen
lib/
  screen.ts                    getDisplayMedia + 32×32 perceptual diff gate
  store.ts                     the session bridge (Redis | in-memory)
  vision.ts                    OpenAI vision — caption() and inspect()
  zendesk.ts                   ticket creation + screenshot upload
components/
  Call.tsx                     conversation wiring + ambient loop + live feed
```
