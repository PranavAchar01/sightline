import { caption } from "@/lib/vision";
import { endSession, putCaption, putFrame } from "@/lib/store";

export const maxDuration = 30;

/**
 * The browser pushes here. Two modes:
 *   { frame }                   → just refresh the stored frame (cheap, frequent)
 *   { frame, describe: true }   → also caption it and return the caption, which the
 *                                 client feeds to conversation.sendContextualUpdate()
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { frame, describe } = await request.json();

  if (typeof frame !== "string" || !frame.startsWith("data:image/")) {
    return Response.json({ error: "frame must be an image data URI" }, { status: 400 });
  }

  await putFrame(id, frame);

  if (!describe) return Response.json({ ok: true });

  try {
    const text = await caption(frame);
    if (text) await putCaption(id, text);
    return Response.json({ caption: text });
  } catch {
    // A failed caption is not worth failing the request over — the frame is stored,
    // so look_at_screen still works.
    return Response.json({ caption: "" });
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await endSession(id);
  return Response.json({ ok: true });
}
