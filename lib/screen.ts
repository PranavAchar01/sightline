/**
 * Screen capture with a perceptual diff gate.
 *
 * Naively captioning every frame would be ~120 vision calls a minute. Gating on a
 * 32x32 grayscale mean-absolute-delta drops that to roughly 8 — we only pay for a
 * frame when the screen actually changes.
 */

export type Capture = {
  start: () => Promise<void>;
  stop: () => void;
  /** Latest frame as a JPEG data URI, or null if nothing is being shared yet. */
  grab: (maxWidth?: number, quality?: number) => string | null;
  hasChanged: () => boolean;
  isActive: () => boolean;
  /** Fires when the user clicks Chrome's "Stop sharing" button. */
  onEnded: (fn: () => void) => void;
};

const DIFF_THRESHOLD = 6;

export function createCapture(): Capture {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const tiny = document.createElement("canvas");
  tiny.width = 32;
  tiny.height = 32;
  const tctx = tiny.getContext("2d", { willReadFrequently: true })!;

  let previous: Float32Array | null = null;
  let stream: MediaStream | null = null;
  let endedHandler: (() => void) | null = null;

  return {
    async start() {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 2 },
        // No tab audio: the agent speaks through the same speakers and it fights the mic.
        audio: false,
        selfBrowserSurface: "exclude", // don't let the user mirror this tab into itself
        monitorTypeSurfaces: "include", // allow sharing the whole desktop
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions);

      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        stream = null;
        endedHandler?.();
      });

      video.srcObject = stream;
      await video.play();
    },

    stop() {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      previous = null;
    },

    isActive() {
      return stream !== null && video.videoWidth > 0;
    },

    onEnded(fn) {
      endedHandler = fn;
    },

    grab(maxWidth = 1280, quality = 0.6) {
      if (!video.videoWidth) return null;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // ~150KB at these settings, comfortably under Vercel's 4.5MB body limit.
      return canvas.toDataURL("image/jpeg", quality);
    },

    hasChanged() {
      if (!video.videoWidth) return false;
      tctx.drawImage(video, 0, 0, 32, 32);
      const pixels = tctx.getImageData(0, 0, 32, 32).data;

      const luma = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const p = i * 4;
        luma[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
      }

      if (!previous) {
        previous = luma;
        return true;
      }

      let total = 0;
      for (let i = 0; i < 1024; i++) total += Math.abs(luma[i] - previous[i]);
      previous = luma;

      return total / 1024 > DIFF_THRESHOLD;
    },
  };
}
