// VEINED ocean film: the owner's two videos as the decorative background of the landing page and the application.
// Shared, framework-free logic (unit-tested): which derivative a viewport loads, whether a visitor gets moving film
// at all, how page scroll maps to a frame of the landing descent, and the guarded seek loop that scrubs it.
// Derivatives and their provenance: public/assets/veined/ocean-film/manifest.json (built from the read-only owner
// originals; audio removed). The film is decoration only: aria-hidden, never focusable, never a pointer target.

export const FILM_BASE = "/assets/veined/ocean-film";
/** The landing descent: 240 frames at 24 fps, every frame a keyframe, so any seek decodes exactly one frame. */
export const LANDING_FRAMES = 240;
export const FILM_FPS = 24;
/** Depth stills of the descent (poster and still fallback): surface, mid-water, deep water, ocean floor. */
export const DEPTH_FRAMES = [0, 80, 160, 239] as const;
export type FilmVariant = "l1280" | "l960" | "p456";
export type FilmMode = "pending" | "film" | "still";

/** Portrait screens get the 456×720 crop around the octopus; landscape screens the 960 or 1280 wide render. */
export function filmVariant(
  width: number,
  height: number,
  dpr = 1,
): FilmVariant {
  if (height > 0 && width / height <= 4 / 5) return "p456";
  return width * Math.min(Math.max(dpr, 1), 2) >= 1200 ? "l1280" : "l960";
}

export interface FilmEnvironment {
  reducedMotion: boolean;
  saveData: boolean;
  canPlayH264: boolean;
  cores?: number;
  memoryGb?: number;
  /** Network Information API estimate ("slow-2g" | "2g" | "3g" | "4g"), where the browser offers it. */
  effectiveType?: string;
}
/** Moving film only when the visitor allows motion, does not ask to save data, is not on a slow link, the browser
 * decodes H.264 and the device is not known to be low-end; everyone else gets the still ocean. */
export function filmEligible(env: FilmEnvironment): "film" | "still" {
  if (env.reducedMotion || env.saveData || !env.canPlayH264) return "still";
  if (env.effectiveType && /^(slow-2g|2g|3g)$/.test(env.effectiveType))
    return "still";
  if (env.cores !== undefined && env.cores > 0 && env.cores <= 2)
    return "still";
  if (env.memoryGb !== undefined && env.memoryGb > 0 && env.memoryGb <= 2)
    return "still";
  return "film";
}

/** Browser probe for filmEligible (client only). */
export function browserFilmEnvironment(): FilmEnvironment {
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
    deviceMemory?: number;
  };
  const probe = document.createElement("video");
  return {
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    saveData: nav.connection?.saveData === true,
    canPlayH264:
      typeof probe.canPlayType === "function" &&
      probe.canPlayType('video/mp4; codecs="avc1.640028"') !== "",
    cores: nav.hardwareConcurrency,
    memoryGb: nav.deviceMemory,
    effectiveType: nav.connection?.effectiveType,
  };
}

/** Scroll position as progress through the page, 0 at the top and 1 at the very bottom. */
export function scrollProgress(
  scrollY: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  const max = scrollHeight - viewportHeight;
  if (!(max > 0)) return 0;
  return Math.min(1, Math.max(0, scrollY / max));
}
/** The descent curve: scroll progress → position in the film (both 0..1), piecewise linear and strictly increasing.
 * Measured on the owner's footage (motion-compensated residual per frame, art/film/motion_profile.py): from about
 * frame 160 the arms re-form faster than the camera moves (residual ~2× the open-water baseline, peaking near frame
 * 200). The open-water stretch is given a little more room, that passage is crossed about 1.5× faster, and the
 * settled floor gets the last sixth of the page, under the closing call. */
export const DESCENT_CURVE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.7, 160 / 239],
  [0.84, 212 / 239],
  [1, 1],
];
export function descent(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  for (let i = 1; i < DESCENT_CURVE.length; i++) {
    const [p1, f1] = DESCENT_CURVE[i];
    if (p <= p1) {
      const [p0, f0] = DESCENT_CURVE[i - 1];
      return f0 + ((p - p0) / (p1 - p0)) * (f1 - f0);
    }
  }
  return 1;
}
/** The landing frame for a scroll progress: the surface at the top, the ocean floor at the bottom. */
export function frameAt(progress: number, frames = LANDING_FRAMES): number {
  return Math.round(descent(progress) * (frames - 1));
}
/** Seek target for a frame: the middle of its display interval, so decoders never land on a neighbour. */
export function frameTime(frame: number, fps = FILM_FPS): number {
  return (frame + 0.5) / fps;
}
/** Frame index of a presented media time. */
export function frameOfTime(time: number, fps = FILM_FPS): number {
  return Math.max(0, Math.floor(time * fps + 1e-3));
}
/** Nearest depth still (0..3) for a frame. */
export function depthOf(frame: number): 0 | 1 | 2 | 3 {
  let best = 0;
  for (let i = 1; i < DEPTH_FRAMES.length; i++)
    if (
      Math.abs(DEPTH_FRAMES[i] - frame) < Math.abs(DEPTH_FRAMES[best] - frame)
    )
      best = i;
  return best as 0 | 1 | 2 | 3;
}

/** The minimal media surface the scrubber needs (an HTMLVideoElement in the browser, a double in unit tests). */
export interface Seekable {
  currentTime: number;
  addEventListener(type: "seeked" | "error", listener: () => void): void;
  removeEventListener(type: "seeked" | "error", listener: () => void): void;
}
export interface ScrubOptions {
  fps?: number;
  frames?: number;
  /** Time constant of the glide toward the scroll target (ms); 0 snaps. */
  glideMs?: number;
  /** Called with each frame whose seek completed. */
  onFrame?: (frame: number) => void;
  /** Called once when seeks are too slow for this device (median of the first 24 above slowMs). */
  onSlow?: () => void;
  slowMs?: number;
  now?: () => number;
  schedule?: (callback: (time: number) => void) => number;
  cancel?: (handle: number) => void;
}

/** Scroll-driven scrubbing of an all-intra video: the target frame is a pure function of scroll position; the shown
 * frame glides toward it and settles on it exactly. At most one seek is in flight (a new one starts only after
 * `seeked`), so fast scrolling never queues stale seeks, and reverse scrolling is the same operation. */
export class FilmScrubber {
  private readonly fps: number;
  private readonly frames: number;
  private readonly glideMs: number;
  private target = 0;
  private position = 0;
  private requested = -1;
  private seeking = false;
  private seekStarted = 0;
  private handle = 0;
  private last = 0;
  private disposed = false;
  private slowReported = false;
  readonly seekDurations: number[] = [];
  private readonly now: () => number;
  private readonly schedule: (callback: (time: number) => void) => number;
  private readonly cancel: (handle: number) => void;
  constructor(
    private readonly media: Seekable,
    private readonly options: ScrubOptions = {},
  ) {
    this.fps = options.fps ?? FILM_FPS;
    this.frames = options.frames ?? LANDING_FRAMES;
    this.glideMs = options.glideMs ?? 90;
    this.now = options.now ?? (() => performance.now());
    this.schedule =
      options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.cancel = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
    media.addEventListener("seeked", this.onSeeked);
  }
  /** Jump without gliding (first paint, restored scroll position). */
  start(frame: number) {
    this.target = this.position = this.clamp(frame);
    this.kick();
  }
  setTarget(frame: number) {
    this.target = this.clamp(frame);
    this.kick();
  }
  get targetFrame() {
    return this.target;
  }
  get requestedFrame() {
    return this.requested;
  }
  dispose() {
    this.disposed = true;
    if (this.handle) this.cancel(this.handle);
    this.handle = 0;
    this.media.removeEventListener("seeked", this.onSeeked);
  }
  private clamp(frame: number) {
    return Math.min(this.frames - 1, Math.max(0, Math.round(frame)));
  }
  private kick() {
    if (this.disposed || this.handle) return;
    this.last = this.now();
    this.handle = this.schedule(this.step);
  }
  private readonly step = () => {
    this.handle = 0;
    if (this.disposed) return;
    const now = this.now();
    const dt = Math.max(0, now - this.last);
    this.last = now;
    if (this.glideMs <= 0) this.position = this.target;
    else {
      this.position +=
        (this.target - this.position) * (1 - Math.exp(-dt / this.glideMs));
      if (Math.abs(this.target - this.position) < 0.5)
        this.position = this.target;
    }
    const frame = Math.round(this.position);
    if (!this.seeking && frame !== this.requested) {
      this.seeking = true;
      this.requested = frame;
      this.seekStarted = now;
      this.media.currentTime = frameTime(frame, this.fps);
    }
    // Keep gliding while the position moves; a completed seek re-arms the loop if the frame changed meanwhile.
    if (this.position !== this.target) this.handle = this.schedule(this.step);
  };
  private readonly onSeeked = () => {
    if (this.disposed) return;
    this.seeking = false;
    const took = this.now() - this.seekStarted;
    if (this.seekDurations.length < 240) this.seekDurations.push(took);
    this.options.onFrame?.(this.requested);
    const slow = this.options.slowMs ?? 120;
    if (!this.slowReported && this.seekDurations.length === 24) {
      const sorted = [...this.seekDurations].sort((a, b) => a - b);
      if (sorted[12] > slow) {
        this.slowReported = true;
        this.options.onSlow?.();
      }
    }
    if (Math.round(this.position) !== this.requested) this.kick();
  };
}
