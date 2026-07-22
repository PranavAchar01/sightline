/**
 * Minimal Zendesk ticket creation. Basic auth with an API token:
 *   Authorization: Basic base64("<email>/token:<api_token>")
 */

export type TicketInput = {
  subject: string;
  summary: string;
  resolution?: string;
  /** Latest screen frame as a JPEG data URI — attached to the ticket if present. */
  frame?: string | null;
};

export type TicketResult = { id: number; url: string };

function auth(): string {
  const raw = `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function base(): string {
  return `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
}

export function zendeskConfigured(): boolean {
  return Boolean(
    process.env.ZENDESK_SUBDOMAIN &&
      process.env.ZENDESK_EMAIL &&
      process.env.ZENDESK_API_TOKEN,
  );
}

/** Uploads the screenshot and returns an attachment token, or null if it fails. */
async function uploadFrame(frame: string): Promise<string | null> {
  try {
    const bytes = Buffer.from(frame.replace(/^data:image\/\w+;base64,/, ""), "base64");
    const res = await fetch(`${base()}/uploads.json?filename=screen.jpg`, {
      method: "POST",
      headers: { Authorization: auth(), "Content-Type": "application/binary" },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.upload?.token ?? null;
  } catch {
    return null;
  }
}

export async function createTicket(input: TicketInput): Promise<TicketResult> {
  const uploads: string[] = [];
  if (input.frame) {
    const token = await uploadFrame(input.frame);
    if (token) uploads.push(token);
  }

  const body = [
    input.summary,
    input.resolution ? `\nResolution: ${input.resolution}` : "",
    "\n\n— filed automatically by the Sightline voice agent, which watched the customer's screen during this call.",
  ].join("");

  const res = await fetch(`${base()}/tickets.json`, {
    method: "POST",
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    body: JSON.stringify({
      ticket: {
        subject: input.subject,
        comment: { body, uploads },
        tags: ["sightline", "voice-agent"],
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Zendesk returned ${res.status}: ${await res.text()}`);
  }

  const { ticket } = await res.json();
  return {
    id: ticket.id,
    url: `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${ticket.id}`,
  };
}
