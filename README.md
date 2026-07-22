# Sightline

A voice support agent that **watches the customer's screen live**, diagnoses the
problem by looking instead of asking, and files the Zendesk ticket itself.

Built for the OpenAI × Start2 × Zendesk hackathon — Jul 23, 2026.

## How it sees

Voice agents are audio-only — there is no image channel. Sightline gets around that by
running the agent on a **Custom LLM proxy**: ElevenLabs accepts any OpenAI-compatible
`/v1/chat/completions` endpoint, so every turn of the conversation passes through
[`/api/llm`](app/api/llm), where the customer's current screen frame is attached before
the request is forwarded to OpenAI.

The agent's reasoning model sees the screen **every time it thinks** — no tool call, no
captioning lag, no round trip.

Three tiers, cheapest first:

| Tier | How | When |
|---|---|---|
| **Live** | Frame injected at `detail: low` into every turn | Always, automatically |
| **Temporal** | Server-side captions replayed as a timeline | So it knows what changed between turns |
| **Deep** | MCP `look_at_screen` at `detail: high` | Reading exact error codes and reference numbers |

Full write-up in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

```bash
pnpm verify
```

Runs the test suite, typecheck, and a production build.

Desktop Chrome or Edge only — `getDisplayMedia()` is not supported on mobile browsers.

## Configure the ElevenLabs agent

1. Create a **public** agent at [elevenlabs.io/app/agents](https://elevenlabs.io/app/agents).

2. **LLM → Custom LLM.** This is the part that makes it see.
   - **Server URL**: `https://<your-deployment>/api/llm`
   - **Model ID**: `gpt-5.2`
   - **API key**: a secret matching `CUSTOM_LLM_API_KEY`
   - **Extra body** (optional — there's a fallback): `{"session_id": "{{session_id}}"}`

3. Add a custom MCP server for the deep tier and ticketing:
   - **Server URL**: `https://<your-deployment>/api/mcp`
   - **Secret Token**: matching `MCP_SHARED_SECRET`
   - **Approval mode**: **No Approval**

   > Approval defaults to **Always Ask**, which makes the agent verbally request
   > permission every time it looks at the screen. On stage that reads as broken.

4. System prompt — the `{{session_id}}` line is load-bearing, it's how the proxy finds
   the right browser even if the extra-body config is wrong:

   ```
   You are a support specialist on a live call with a customer who is sharing
   their screen with you.

   Your session id is {{session_id}}. Pass it to every tool call.

   You can see the customer's screen. Images marked [LIVE SCREEN] are what they
   are looking at right now — use them directly.

   Never ask the customer to describe what is on their screen. If you need to read
   exact text such as an error code or reference number, call look_at_screen.

   Be specific about what you see: "the red banner under the Billing tab", never
   "an error". Keep replies short — this is a phone call, not a document.

   Once the issue is understood, offer to file a ticket, then call
   create_support_ticket.
   ```

5. Put the agent id in `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`.

## Deploy

The session bridge needs a durable store — without one the browser and the proxy land
on different serverless instances, the proxy injects nothing, and the agent starts
asking the customer to describe their screen. Vercel Blob is the default:

```bash
vercel blob create-store sightline-frames --access private --yes --environment production --environment preview --environment development
```

```bash
vercel --prod
```

Upstash Redis is ~200ms/turn faster and takes precedence automatically if you set
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

## Verify a deployment

```bash
curl -sD- -o/dev/null -X POST https://<your-deployment>/api/llm -H "Content-Type: application/json" -H "Authorization: Bearer $CUSTOM_LLM_API_KEY" -d '{"model":"gpt-5.2","stream":true,"messages":[{"role":"system","content":"Your session id is 00000000-0000-0000-0000-000000000000."},{"role":"user","content":"hi"}]}' | grep -i x-sightline
```

`X-Sightline-Session` should echo the id, and `X-Sightline-Screen` should read `none`
until a browser is actually sharing — then `attached`. Those two headers tell a bad API
key apart from a broken session bridge without guessing.

```bash
curl -X POST https://<your-deployment>/api/mcp -H "Authorization: Bearer $MCP_SHARED_SECRET" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should list `get_screen_context`, `look_at_screen`, and `create_support_ticket`.

## Health check

```bash
curl -s https://sightline-nine.vercel.app/api/health
```

Reports which env vars are missing and — critically — whether the session bridge is
on Redis or the in-memory fallback. Every misconfiguration here presents identically
from the ElevenLabs side: the agent just asks the customer to describe their screen.
