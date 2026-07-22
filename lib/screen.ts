/**
 * Screen capture, driven by the compositor rather than a timer.
 *
 * `requestVideoFrameCallback` fires once per decoded frame, so we react the moment
 * the screen actually changes instead of discovering it up to a tick late. A 32x32
 * grayscale mean-absolute-delta then decides whether the frame is worth sending —
 * without that gate this would be ~120 uploads a minute.
 */

export type FrameEvent = {
  /** True when the screen changed meaningfully since the last frame we looked at. */
  changed: boolean;
  /** True when it's simply been a while and the stored frame needs refreshing. */
  heartbeat: boolean;
};

export type Capture = {
  start: () => Promise<void>;
  stop: () => void;
  grab: (maxWidth?: number, quality?: number) => string | null;
  isActive: () => boolean;
  /** Called on every meaningful frame. Returns an unsubscribe function. */
  subscribe: (handler: (event: FrameEvent) => void) => () => void;
  onEnded: (fn: () => void) => void;
};

const DIFF_THRESHOLD = 6;
/** Floor between change-triggered emissions, so a video playing doesn't flood us. */
const MIN_CHANGE_INTERVAL_MS = 700;
/** Refresh the stored frame at least this often so the proxy never sees it stale. */
const HEARTBEAT_MS = 4000;

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function createCapture(): Capture {
  const video = document.createElement("video") as VideoWithRVFC;
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

  const handlers = new Set<(event: FrameEvent) => void>();
  let lastChange = 0;
  let lastHeartbeat = 0;
  let rvfcHandle: number | null = null;
  let timerHandle: ReturnType<typeof setInterval> | null = null;

  function diffExceedsThreshold(): boolean {
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
  }

  function evaluate() {
    if (!video.videoWidth) return;

    const now = Date.now();
    const changed = diffExceedsThreshold() && now - lastChange > MIN_CHANGE_INTERVAL_MS;
    const heartbeat = now - lastHeartbeat > HEARTBEAT_MS;

    if (!changed && !heartbeat) return;
    if (changed) lastChange = now;
    lastHeartbeat = now;

    for (const handler of handlers) handler({ changed, heartbeat });
  }

  function pump() {
    if (!stream) return;
    evaluate();
    rvfcHandle = video.requestVideoFrameCallback!(pump);
  }

  function startPump() {
    if (typeof video.requestVideoFrameCallback === "function") {
      rvfcHandle = video.requestVideoFrameCallback(pump);
    } else {
      // Safari and older Chromium: fall back to polling at roughly frame rate.
      timerHandle = setInterval(evaluate, 500);
    }
  }

  function stopPump() {
    if (rvfcHandle !== null) {
      video.cancelVideoFrameCallback?.(rvfcHandle);
      rvfcHandle = null;
    }
    if (timerHandle !== null) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  return {
    async start() {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 4 },
        // No tab audio: the agent speaks through the same speakers and it fights the mic.
        audio: false,
        selfBrowserSurface: "exclude", // don't let the user mirror this tab into itself
        monitorTypeSurfaces: "include", // allow sharing the whole desktop
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions);

      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        stopPump();
        stream = null;
        endedHandler?.();
      });

      video.srcObject = stream;
      await video.play();
      startPump();
    },

    stop() {
      stopPump();
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      previous = null;
      lastChange = 0;
      lastHeartbeat = 0;
    },

    isActive() {
      return stream !== null && video.videoWidth > 0;
    },

    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
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
  };
}
