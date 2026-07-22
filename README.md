# Sightline

A voice support agent that watches the customer's screen in real time, diagnoses the
problem by looking instead of asking, and files the Zendesk ticket itself.

Built for the OpenAI × Start2 × Zendesk hackathon — Jul 23, 2026.

- **Voice** — ElevenLabs Agents (WebRTC), LLM set to GPT-5.2
- **Sight** — OpenAI vision over `getDisplayMedia()` frames, diff-gated
- **Connector** — an MCP server at `/api/mcp` the agent calls for screen context
- **Outcome** — a real Zendesk ticket with the screenshot attached

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the screen actually reaches an
audio-only agent, and why that needs a session bridge.

## Run it

```bash
pnpm install
cp .env.example .env.local   # fill in at minimum OPENAI_API_KEY + agent id
pnpm dev
```

Desktop Chrome or Edge only — `getDisplayMedia()` is not supported on mobile browsers.

## Configure the ElevenLabs agent

1. Create a **public** agent at [elevenlabs.io/app/agents](https://elevenlabs.io/app/agents).
2. Set the LLM to **GPT-5.2** — ElevenLabs' own docs recommend high-intelligence models
   for reliable tool calling.
3. Add a custom MCP server:
   - **Server URL**: `https://<your-deployment>/api/mcp`
   - **Secret Token**: the same value as `MCP_SHARED_SECRET`
   - **Approval mode**: **No Approval**

   > Approval mode defaults to **Always Ask**, which makes the agent verbally request
   > permission every single time it looks at the screen. On stage that reads as
   > broken. Change it.
4. System prompt:

   ```
   You are a support specialist on a live call with a customer who is sharing
   their screen with you.

   Your session id is {{session_id}}. Pass it to every tool call.

   Messages beginning with [SCREEN] are live observations of what the customer is
   looking at right now. Use them freely — they are current.

   Never ask the customer to describe what is on their screen. Look instead:
   get_screen_context is instant, look_at_screen reads exact text.

   Be specific about what you see: "the red banner under the Billing tab", never
   "an error". Keep replies short — this is a phone call, not a document.

   Once the issue is understood, offer to file a ticket, then call
   create_support_ticket.
   ```
5. Put the agent id in `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`.

## Deploy

```bash
vercel --prod
```

Provision **Upstash Redis** from the Vercel Marketplace first and set
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. Without Redis the in-memory
fallback silently breaks in production — see ARCHITECTURE.md.

## Verify the MCP server

```bash
curl -X POST https://<your-deployment>/api/mcp -H "Authorization: Bearer $MCP_SHARED_SECRET" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should list `get_screen_context`, `look_at_screen`, and `create_support_ticket`.
