// Ocean film candidate: the pure logic behind the landing descent and the application film (no browser needed).
// Scroll → frame mapping is deterministic and reversible; the scrubber keeps one seek in flight, glides toward the
// scroll target and always settles on it exactly (forward, backward, after jumps); fallbacks follow the visitor's
// preferences and device.
import { describe, expect, it } from "vitest";
import {
  DEPTH_FRAMES,
  DESCENT_CURVE,
  FilmScrubber,
  LANDING_FRAMES,
  depthOf,
  filmEligible,
  filmVariant,
  frameAt,
  frameOfTime,
  frameTime,
  descent,
  scrollProgress,
  type Seekable,
} from "../../src/components/ocean-film";

/** A video double: seeks complete when the test says so (like a decoder), and every seek is recorded. */
class FakeVideo implements Seekable {
  seeks: number[] = [];
  private time = 0;
  private listeners = new Set<() => void>();
  pending = false;
  get currentTime() {
    return this.time;
  }
  set currentTime(value: number) {
    if (this.pending)
      throw new Error("a second seek was issued while one was in flight");
    this.pending = true;
    this.time = value;
    this.seeks.push(value);
  }
  addEventListener(_type: "seeked" | "error", listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "seeked" | "error", listener: () => void) {
    this.listeners.delete(listener);
  }
  complete() {
    if (!this.pending) return false;
    this.pending = false;
    for (const l of this.listeners) l();
    return true;
  }
}
/** Manual animation-frame clock (16.7 ms per frame). */
function clock() {
  let now = 0;
  const queue = new Map<number, (t: number) => void>();
  let id = 0;
  return {
    now: () => now,
    schedule: (cb: (t: number) => void) => {
      queue.set(++id, cb);
      return id;
    },
    cancel: (h: number) => void queue.delete(h),
    frame() {
      now += 1000 / 60;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(now);
      return due.length;
    },
    idle: () => queue.size === 0,
  };
}
/** Run frames until the scrubber is idle, completing each seek on the next frame (a fast decoder). */
function settle(video: FakeVideo, c: ReturnType<typeof clock>, limit = 2000) {
  for (let i = 0; i < limit; i++) {
    const ran = c.frame();
    const seeked = video.complete();
    if (!ran && !seeked && c.idle() && !video.pending) return i;
  }
  throw new Error("scrubber never settled");
}

describe("ocean film: scroll → frame", () => {
  it("maps the top of the page to the surface and the bottom to the ocean floor, monotonically", () => {
    expect(scrollProgress(0, 10000, 900)).toBe(0);
    expect(scrollProgress(9100, 10000, 900)).toBe(1);
    expect(scrollProgress(99999, 10000, 900)).toBe(1);
    expect(scrollProgress(-50, 10000, 900)).toBe(0);
    expect(scrollProgress(100, 800, 900)).toBe(0);
    expect(frameAt(0)).toBe(0);
    expect(frameAt(1)).toBe(LANDING_FRAMES - 1);
    let last = -1;
    for (let y = 0; y <= 9100; y += 7) {
      const f = frameAt(scrollProgress(y, 10000, 900));
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
    // The same position always gives the same frame, whichever way the visitor arrived.
    expect(frameAt(scrollProgress(4321, 10000, 900))).toBe(
      frameAt(scrollProgress(4321, 10000, 900)),
    );
  });
  it("follows the descent curve: strictly increasing, open water first, the arm-morph passage crossed faster", () => {
    expect(DESCENT_CURVE[0]).toEqual([0, 0]);
    expect(DESCENT_CURVE.at(-1)).toEqual([1, 1]);
    for (let i = 1; i < DESCENT_CURVE.length; i++) {
      expect(DESCENT_CURVE[i][0]).toBeGreaterThan(DESCENT_CURVE[i - 1][0]);
      expect(DESCENT_CURVE[i][1]).toBeGreaterThan(DESCENT_CURVE[i - 1][1]);
    }
    expect(descent(-1)).toBe(0);
    expect(descent(2)).toBe(1);
    // Knots land on their frames exactly.
    expect(frameAt(0.7)).toBe(160);
    expect(frameAt(0.84)).toBe(212);
    // Frames 160–212 take 14 % of the page (a linear map would give them 21.8 %); the settled floor gets 16 %.
    const linear = (212 - 160) / 239;
    expect(0.84 - 0.7).toBeLessThan(linear * 0.7);
    expect(1 - 0.84).toBeGreaterThan((239 - 212) / 239);
    // Every frame stays reachable: consecutive positions never skip more than two frames at 1 px of a long page.
    let last = 0;
    for (let y = 0; y <= 9100; y++) {
      const f = frameAt(scrollProgress(y, 10000, 900));
      expect(f - last).toBeLessThanOrEqual(2);
      last = f;
    }
  });
  it("seeks to the middle of a frame and reads presented times back to the same frame", () => {
    for (let f = 0; f < LANDING_FRAMES; f++) {
      expect(frameOfTime(frameTime(f))).toBe(f);
      expect(frameTime(f)).toBeLessThan(LANDING_FRAMES / 24);
    }
  });
  it("chooses the nearest depth still", () => {
    expect(DEPTH_FRAMES).toEqual([0, 80, 160, 239]);
    expect(depthOf(0)).toBe(0);
    expect(depthOf(39)).toBe(0);
    expect(depthOf(41)).toBe(1);
    expect(depthOf(150)).toBe(2);
    expect(depthOf(239)).toBe(3);
  });
});

describe("ocean film: delivery and fallbacks", () => {
  it("loads one derivative for the viewport: portrait crop, mid or wide render", () => {
    expect(filmVariant(390, 844, 3)).toBe("p456");
    expect(filmVariant(768, 1024, 2)).toBe("p456");
    expect(filmVariant(1024, 768, 1)).toBe("l960");
    expect(filmVariant(1024, 768, 2)).toBe("l1280");
    expect(filmVariant(1440, 900, 1)).toBe("l1280");
    expect(filmVariant(900, 600, 1)).toBe("l960");
  });
  it("gives the still ocean to reduced motion, data saving, slow links, no H.264 and low-end devices", () => {
    const ok = { reducedMotion: false, saveData: false, canPlayH264: true };
    expect(filmEligible(ok)).toBe("film");
    expect(filmEligible({ ...ok, cores: 8, memoryGb: 8 })).toBe("film");
    expect(filmEligible({ ...ok, reducedMotion: true })).toBe("still");
    expect(filmEligible({ ...ok, saveData: true })).toBe("still");
    expect(filmEligible({ ...ok, canPlayH264: false })).toBe("still");
    expect(filmEligible({ ...ok, cores: 2 })).toBe("still");
    expect(filmEligible({ ...ok, memoryGb: 1 })).toBe("still");
    expect(filmEligible({ ...ok, effectiveType: "3g" })).toBe("still");
    expect(filmEligible({ ...ok, effectiveType: "slow-2g" })).toBe("still");
    expect(filmEligible({ ...ok, effectiveType: "4g" })).toBe("film");
  });
});

describe("ocean film: scrubber", () => {
  const make = (glideMs = 90) => {
    const video = new FakeVideo();
    const c = clock();
    const frames: number[] = [];
    const scrubber = new FilmScrubber(video, {
      glideMs,
      now: c.now,
      schedule: c.schedule,
      cancel: c.cancel,
      onFrame: (f) => frames.push(f),
    });
    return { video, c, frames, scrubber };
  };
  it("starts on the restored frame without gliding", () => {
    const { video, c, frames, scrubber } = make();
    scrubber.start(120);
    settle(video, c);
    expect(video.seeks).toEqual([frameTime(120)]);
    expect(frames).toEqual([120]);
  });
  it("glides forward and settles exactly; never more than one seek in flight", () => {
    const { video, c, frames, scrubber } = make();
    scrubber.start(0);
    settle(video, c);
    scrubber.setTarget(60);
    settle(video, c);
    expect(frames.at(-1)).toBe(60);
    expect(frameOfTime(video.currentTime)).toBe(60);
    // A glide shows intermediate frames in order (a visible descent, not a cut).
    const forward = frames.slice(1);
    expect(forward.length).toBeGreaterThan(3);
    for (let i = 1; i < forward.length; i++)
      expect(forward[i]).toBeGreaterThan(forward[i - 1]);
  });
  it("plays the same journey backwards when the visitor scrolls up", () => {
    const { video, c, frames, scrubber } = make();
    scrubber.start(200);
    settle(video, c);
    scrubber.setTarget(20);
    settle(video, c);
    const back = frames.slice(1);
    expect(back.at(-1)).toBe(20);
    for (let i = 1; i < back.length; i++)
      expect(back[i]).toBeLessThan(back[i - 1]);
  });
  it("lands on the latest target after fast, reversing scrolls while seeks are slow", () => {
    const { video, c, frames, scrubber } = make();
    scrubber.start(0);
    settle(video, c);
    // Targets change every frame while the decoder only completes every 4th frame.
    const targets = [30, 90, 160, 239, 200, 120, 40, 75];
    for (const t of targets) {
      scrubber.setTarget(t);
      for (let i = 0; i < 4; i++) c.frame();
      video.complete();
    }
    settle(video, c);
    expect(frames.at(-1)).toBe(75);
    expect(frameOfTime(video.currentTime)).toBe(75);
  });
  it("snaps without gliding when glide is 0 and clamps out-of-range targets", () => {
    const { video, c, frames, scrubber } = make(0);
    scrubber.start(10);
    settle(video, c);
    scrubber.setTarget(999);
    settle(video, c);
    expect(frames).toEqual([10, 239]);
    scrubber.setTarget(-5);
    settle(video, c);
    expect(frames.at(-1)).toBe(0);
  });
  it("reports a device whose seeks are too slow, once", () => {
    const video = new FakeVideo();
    const c = clock();
    let slow = 0;
    const scrubber = new FilmScrubber(video, {
      glideMs: 0,
      now: c.now,
      schedule: c.schedule,
      cancel: c.cancel,
      slowMs: 120,
      onSlow: () => slow++,
    });
    scrubber.start(0);
    for (let f = 1; f <= 40; f++) {
      scrubber.setTarget(f * 5);
      for (let i = 0; i < 12; i++) c.frame(); // 200 ms per seek
      video.complete();
    }
    expect(slow).toBe(1);
    scrubber.dispose();
  });
  it("stops touching the video once disposed", () => {
    const { video, c, scrubber } = make();
    scrubber.start(5);
    settle(video, c);
    scrubber.dispose();
    scrubber.setTarget(100);
    for (let i = 0; i < 20; i++) c.frame();
    expect(video.seeks).toEqual([frameTime(5)]);
  });
});
