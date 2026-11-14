"use client";
// The shared abyssal field: one fixed, decorative underwater world behind every application surface. Ocean film
// candidate: the owner's living-ocean video (02, its seam repaired into an 8 s loop; see ocean-film.ts and the
// derivative manifest) plays behind the shell. It is mounted once in the application layout, so navigating between
// Overview, Swap, Bridge, Portfolio, Points, Activity, Networks and Help never restarts it; it pauses while the tab is
// hidden. Reduced motion, data saving, no H.264, a decode failure or a device that drops frames get the still ocean.
// Nothing here is interactive, focusable or announced; navigation and input never wait for it. No canvas or WebGL.
import { useEffect, useRef, useState } from "react";
import { FILM_BASE, type FilmMode } from "./ocean-film";
import { useOceanFilm } from "./use-ocean-film";

export type AbyssScene =
  | "overview"
  | "swap"
  | "bridge"
  | "portfolio"
  | "points"
  | "activity"
  | "networks"
  | "help";

/** Route → scene. Settings and About share the calm water of Help. */
export function abyssScene(path: string): AbyssScene {
  const top = path.split("/")[1] ?? "";
  if (top === "app") return "overview";
  if (
    top === "swap" ||
    top === "bridge" ||
    top === "portfolio" ||
    top === "points" ||
    top === "activity" ||
    top === "networks"
  )
    return top;
  return "help";
}

/** A device that cannot keep up (more than a quarter of the frames dropped after a few seconds) gets the still. */
const DROPPED_LIMIT = 0.25;

export function AbyssField({
  scene,
  tint = "",
}: {
  scene: AbyssScene;
  /** Network ambient classes (source/destination glow) of the current route, used by the Bridge scene. */
  tint?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  // Film or still ocean: decided once the page has loaded (the interface comes first); reduced motion is followed
  // live. A decode failure or a device that drops frames turn this visit into the still ocean.
  const film = useOceanFilm();
  const [failed, setFailed] = useState(false);
  const mode: FilmMode =
    failed || film === "still" ? "still" : film === "pending" ? film : "film";
  const variant = mode === "film" ? film : null;

  useEffect(() => {
    const media = video.current;
    if (mode !== "film" || !media) return;
    const field = media.closest<HTMLElement>(".abyss");
    // Muted, inline and decorative: allowed to play without a gesture. A refused play() leaves the still in place.
    const play = () => {
      if (document.hidden) return;
      media.muted = true;
      media.play().catch(() => {});
    };
    const onVisibility = () => {
      if (document.hidden) media.pause();
      else play();
    };
    const onPlaying = () => {
      if (field) field.dataset.film = "playing";
    };
    let check = 0;
    const watchQuality = () => {
      const q = media.getVideoPlaybackQuality?.();
      if (
        q &&
        q.totalVideoFrames >= 96 &&
        q.droppedVideoFrames / q.totalVideoFrames > DROPPED_LIMIT
      )
        setFailed(true);
    };
    media.addEventListener("playing", onPlaying);
    document.addEventListener("visibilitychange", onVisibility);
    check = window.setInterval(watchQuality, 4000);
    play();
    return () => {
      window.clearInterval(check);
      media.removeEventListener("playing", onPlaying);
      document.removeEventListener("visibilitychange", onVisibility);
      media.pause();
      if (field) delete field.dataset.film;
    };
  }, [mode]);

  return (
    <div
      className={`abyss ${tint}`}
      data-scene={scene}
      data-mode={mode}
      aria-hidden="true"
    >
      {/* One stage holds the film and its still, so RTL mirrors the whole world at once. */}
      <div className="abyss-stage">
        <span className="abyss-still" />
        {mode === "film" && variant && (
          <video
            ref={video}
            className="abyss-film"
            src={`${FILM_BASE}/app-${variant}.mp4`}
            muted
            loop
            playsInline
            preload="auto"
            disablePictureInPicture
            disableRemotePlayback
            // Attached with the element, so even an immediate decode failure reaches the still ocean.
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {/* Bridge: the source and destination networks' light in the water (live network colours). */}
      <div className="abyss-glow" />
      <div className="abyss-veil" />
    </div>
  );
}
