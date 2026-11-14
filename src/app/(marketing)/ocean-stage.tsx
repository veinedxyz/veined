"use client";
// The landing's underwater descent (owner video 01, see components/ocean-film.ts). One fixed, decorative stage
// behind the whole page: the visitor starts at the surface and, as they scroll, the camera sinks through the water
// with the octopus to the ocean floor at the closing call. The film's frame is a pure function of scroll position
// (all-intra H.264, one guarded seek at a time, the descent curve in ocean-film.ts), so scrolling back up plays the
// same journey in reverse, fast scrolls and jumps land on the exact frame, and a reload at a saved position resumes
// at its depth.
// Deep refinement (ux5): the water never freezes into a photograph.
// - A cinematic camera frames the animal per section (it steps aside where an illustration needs the space and comes
//   forward at the hero and the floor); a deep-water haze over its side thickens with the section and with depth.
// - The living current: a slow sway of the whole shot and three layers of marine snow that drift on their own and
//   stream past as the visitor descends. Compositor-only transforms through the CSSOM, no canvas, no infinite CSS
//   animation; the loop pauses while the tab is hidden and never runs for the still ocean. A device that cannot
//   keep its frame rate falls back to the light current (no snow, no idle sway; data-living="lite").
// - A depth gauge at the inline-end edge reads the descent in metres (decorative, aria-hidden).
// - Server render: the surface still is the hero image (eager, high priority); the film loads only after the page
//   has loaded, and only one derivative for this viewport. No audio track exists.
// - Still ocean (reduced motion, data saving, no H.264, low-end device, decode failure or seeks too slow for the
//   device): four depth stills follow the visitor down the page; no camera, no current.
// Nothing here can delay scrolling, input or navigation: passive listeners, layout reads only on resize.
import { useEffect, useRef, useState } from "react";
import {
  FILM_BASE,
  FilmScrubber,
  depthOf,
  frameAt,
  scrollProgress,
  type FilmMode,
} from "../../components/ocean-film";
import { useOceanFilm } from "../../components/use-ocean-film";

const progressNow = () =>
  scrollProgress(
    window.scrollY,
    document.documentElement.scrollHeight,
    window.innerHeight,
  );

/** Camera per section: [x, y] in % of the viewport (positive x moves the animal toward the inline end), s = scale
 * around the animal, haze = deep water over its side (0..1). Values between sections are eased. */
type Shot = readonly [x: number, y: number, s: number, haze: number];
const CAMERA: Record<string, Shot> = {
  top: [0, 0, 1, 0],
  swap: [8, -1, 1.12, 0.42],
  bridge: [9, 2, 1.14, 0.46],
  portfolio: [9, -2, 1.14, 0.46],
  find: [3, 0, 1.06, 0.36],
  points: [9, 0, 1.13, 0.46],
  networks: [-1, 0, 1.04, 0.4],
  how: [-2, 1, 1.06, 0.36],
  safety: [4, 0, 1.08, 0.3],
  data: [8, 0, 1.12, 0.46],
  faq: [10, 0, 1.15, 0.56],
  final: [0, 0, 1.02, 0.14],
};
/** The animal's place in the frame (cover crop at 71 % of the width, see ocean-landing.css). */
const ANIMAL_X = 0.71;
/** Smallest scale that keeps the film covering the viewport after a translation (origin at the animal). */
function cover([x, y, s]: Shot, origin: number): number {
  const dx = x / 100,
    dy = Math.abs(y) / 100;
  const needX = dx >= 0 ? 1 + dx / origin : 1 + -dx / (1 - origin);
  return Math.max(s, needX + 0.012, 1 + 2 * dy + 0.012);
}
const ease = (t: number) => t * t * (3 - 2 * t);
/** Marine snow: tile size (px), own drift (px/s, positive = sinking), share of the scroll it streams past with. */
const SNOW = [
  [300, 7, 0.18],
  [380, 11, 0.42],
  [460, 16, 0.75],
] as const;
/** A frame later than this (ms) is late; more than 30 % late frames turn the current light (see the loop). */
const LATE_FRAME_MS = 34;
/** Share of late frames while scrolling that turns the current light (measured: GPU ≈ 0.1 %, software ≈ 9 %). */
const LATE_SCROLL_SHARE = 0.04;
/** Full descent in metres for the gauge (decorative scale, not a claim about the footage). */
const FLOOR_METRES = 4000;

export function OceanStage() {
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // Film or still ocean: decided once the page (and its hero image) has loaded; reduced motion is followed live. A
  // decode failure or seeks too slow for the device turn this visit into the still ocean.
  const film = useOceanFilm();
  const [failed, setFailed] = useState(false);
  const mode: FilmMode =
    failed || film === "still" ? "still" : film === "pending" ? film : "film";
  const variant = mode === "film" ? film : null;

  // Depth gauge (every mode) and, for the still ocean, the depth still nearest to the scroll position.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const marker = el.querySelector<HTMLElement>(".ocean-gauge-mark");
    const label = el.querySelector<HTMLElement>(".ocean-gauge-value");
    const metres = new Intl.NumberFormat(document.documentElement.lang || "en");
    let raf = 0;
    const update = () => {
      raf = 0;
      const p = progressNow();
      if (mode !== "film") el.dataset.depth = String(depthOf(frameAt(p)));
      if (marker) marker.style.setProperty("--p", p.toFixed(4));
      if (label)
        label.textContent = `${metres.format(Math.round((p * FLOOR_METRES) / 10) * 10)} m`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [mode]);

  // Film: scroll position → frame, scrubbed by guarded seeks.
  useEffect(() => {
    const el = stage.current,
      media = video.current;
    if (mode !== "film" || !el || !media) return;
    let scrubber: FilmScrubber | null = null;
    let raf = 0;
    const onScroll = () => {
      if (raf || !scrubber) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        scrubber?.setTarget(frameAt(progressNow()));
      });
    };
    const ready = () => {
      if (scrubber) return;
      scrubber = new FilmScrubber(media, {
        onFrame: (frame) => {
          el.dataset.frame = String(frame);
          // The poster gives way only once a real frame is on screen (never a black or empty video box).
          if (el.dataset.film !== "film") el.dataset.film = "film";
        },
        onSlow: () => setFailed(true),
      });
      scrubber.start(frameAt(progressNow()));
    };
    media.addEventListener("loadedmetadata", ready);
    if (media.readyState >= 1) ready();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      scrubber?.dispose();
      media.removeEventListener("loadedmetadata", ready);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      delete el.dataset.film;
      delete el.dataset.frame;
    };
  }, [mode]);

  // Camera and living current (film only). Section anchors are measured on resize; every frame only interpolates.
  useEffect(() => {
    const el = stage.current;
    if (mode !== "film" || !el) return;
    const camera = el.querySelector<HTMLElement>(".ocean-camera");
    const haze = el.querySelector<HTMLElement>(".ocean-haze");
    const snow = [...el.querySelectorAll<HTMLElement>(".ocean-snow")];
    if (!camera || !haze) return;
    let anchors: { at: number; shot: Shot }[] = [];
    let portrait = false;
    let rtl = false;
    const measure = () => {
      portrait = window.innerWidth / window.innerHeight <= 4 / 5;
      rtl = document.documentElement.dir === "rtl";
      const page = el.closest(".ocean-landing") ?? document.body;
      const list = [{ at: 0, shot: CAMERA.top }];
      for (const section of page.querySelectorAll<HTMLElement>(
        ":scope > section[id], :scope > section.mk-final",
      )) {
        const shot = CAMERA[section.id || "final"];
        if (!shot) continue;
        const box = section.getBoundingClientRect();
        // A section's shot is fully held while its middle crosses the middle of the viewport.
        list.push({
          at:
            box.top + window.scrollY + box.height / 2 - window.innerHeight / 2,
          shot,
        });
      }
      anchors = list.sort((a, b) => a.at - b.at);
    };
    const shotAt = (y: number): Shot => {
      if (!anchors.length) return CAMERA.top;
      if (y <= anchors[0].at) return anchors[0].shot;
      for (let i = 1; i < anchors.length; i++) {
        const b = anchors[i];
        if (y <= b.at) {
          const a = anchors[i - 1];
          const t = ease((y - a.at) / Math.max(1, b.at - a.at));
          return [0, 1, 2, 3].map(
            (k) => a.shot[k] + (b.shot[k] - a.shot[k]) * t,
          ) as unknown as Shot;
        }
      }
      return anchors[anchors.length - 1].shot;
    };
    const offsets = SNOW.map(() => 0);
    let lastY = window.scrollY;
    let last = performance.now();
    let raf = 0;
    let painted = 0;
    // A device that cannot keep the frame rate (software compositing, a busy GPU) gets the light current: no snow,
    // no idle sway; the section camera still follows the visitor. Judged after a settling second, once per visit:
    // at rest on the last 120 frames (more than 30 % late), and while the visitor scrolls on the last 150 scrolling
    // frames (more than 4 % late; a GPU-composited desktop or phone stays near 0.1 %).
    const gaps: number[] = [];
    const scrolling: boolean[] = [];
    let previous = 0;
    let settledAt = performance.now() + 1500;
    let scrolledAt = 0;
    let lite = false;
    let written = "";
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (previous) {
        const gap = now - previous;
        gaps.push(gap);
        if (gaps.length > 120) gaps.shift();
        if (now - scrolledAt < 250 && now > settledAt) {
          scrolling.push(gap > LATE_FRAME_MS);
          if (scrolling.length > 150) scrolling.shift();
        }
      }
      previous = now;
      if (
        !lite &&
        now > settledAt &&
        ((gaps.length >= 60 &&
          gaps.filter((g) => g > LATE_FRAME_MS).length / gaps.length > 0.3) ||
          (scrolling.length >= 90 &&
            scrolling.filter(Boolean).length / scrolling.length >
              LATE_SCROLL_SHARE))
      ) {
        lite = true;
        el.dataset.living = "lite";
        snow.forEach((layer) => layer.style.removeProperty("transform"));
      }
      // About 30 updates a second: the current is slow, and the compositor interpolates nothing in between.
      if (now - painted < 30) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = painted = now;
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      if (dy !== 0) scrolledAt = now;
      const t = now / 1000;
      const [x0, y0, s0, h0] = shotAt(y);
      const shot: Shot = portrait
        ? [0, 0, 1 + (s0 - 1) * 0.4, h0]
        : [x0, y0, s0, h0];
      const origin = rtl ? 1 - ANIMAL_X : ANIMAL_X;
      // The sway of a camera held in moving water: a few tenths of a percent, on slow, unrelated periods.
      const calm = lite ? 0 : 1;
      const swayX = Math.sin((t * Math.PI * 2) / 11.5) * 0.45 * calm;
      const swayY = Math.sin((t * Math.PI * 2) / 8.7) * 0.32 * calm;
      const breathe = Math.sin((t * Math.PI * 2) / 14.3) * 0.004 * calm;
      const x = (rtl ? -shot[0] : shot[0]) + (rtl ? -swayX : swayX);
      const scale = cover([x, shot[1] + swayY, shot[2], 0], origin) + breathe;
      const transform = `translate3d(${x.toFixed(3)}%, ${(shot[1] + swayY).toFixed(3)}%, 0) scale(${scale.toFixed(4)})`;
      // Write only on change: at rest the light current costs nothing.
      const depthHaze = (shot[3] + 0.25 * progressNow()).toFixed(3);
      if (transform + depthHaze !== written) {
        written = transform + depthHaze;
        camera.style.transform = transform;
        haze.style.opacity = depthHaze;
      }
      if (lite) return;
      snow.forEach((layer, i) => {
        const [size, drift, share] = SNOW[i];
        offsets[i] =
          (((offsets[i] + drift * dt - dy * share) % size) + size) % size;
        const sway = Math.sin(t / (6 + i * 2.3) + i) * (4 + i * 3);
        layer.style.transform = `translate3d(${sway.toFixed(2)}px, ${(offsets[i] - size).toFixed(2)}px, 0)`;
      });
    };
    const start = () => {
      if (!raf && !document.hidden) {
        last = painted = performance.now();
        lastY = window.scrollY;
        // A hidden tab pauses frames: the judgement restarts after it returns.
        previous = 0;
        gaps.length = 0;
        scrolling.length = 0;
        settledAt = last + 1500;
        raf = requestAnimationFrame(frame);
      }
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onResize = () => measure();
    measure();
    // Fonts and lazy images can move sections after the first measurement.
    const settle = window.setTimeout(measure, 1200);
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    el.dataset.living = "on";
    start();
    return () => {
      stop();
      window.clearTimeout(settle);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      camera.style.removeProperty("transform");
      haze.style.removeProperty("opacity");
      snow.forEach((layer) => layer.style.removeProperty("transform"));
      delete el.dataset.living;
    };
  }, [mode]);

  return (
    <div
      ref={stage}
      className="ocean-stage"
      aria-hidden="true"
      data-mode={mode}
      data-depth="0"
    >
      <div className="ocean-camera">
        {/* The surface: hero image and the film's first frame (identical pixels, so the hand-off is invisible). */}
        <picture className="ocean-still">
          <source
            media="(max-aspect-ratio: 4/5)"
            srcSet={`${FILM_BASE}/landing-d0-p456.webp`}
          />
          {/* Local pre-encoded still (next/image would add an inline style, blocked by the CSP). */}
          <img
            src={`${FILM_BASE}/landing-d0-l1280.webp`}
            width={1280}
            height={720}
            alt=""
            loading="eager"
            fetchPriority="high"
            decoding="async"
          />
        </picture>
        {/* Deeper stills for the still ocean, painted in CSS so only the depth in view is ever requested. */}
        <span className="ocean-depth" />
        {mode === "film" && variant && (
          <video
            ref={video}
            className="ocean-film"
            src={`${FILM_BASE}/landing-${variant}.mp4`}
            muted
            playsInline
            preload="auto"
            disablePictureInPicture
            disableRemotePlayback
            // Attached with the element, so even an immediate decode failure reaches the still ocean.
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {/* Deep water gathering over the animal's side (opacity follows the section and the depth). */}
      <div className="ocean-haze" />
      {/* Marine snow: far, mid and near layers of the living current (film only). */}
      <div className="ocean-snow is-far" />
      <div className="ocean-snow is-mid" />
      <div className="ocean-snow is-near" />
      <div className="ocean-veil" />
      <div className="ocean-gauge">
        <span className="ocean-gauge-track" />
        <span className="ocean-gauge-mark">
          <span className="ocean-gauge-value">0 m</span>
        </span>
      </div>
    </div>
  );
}
