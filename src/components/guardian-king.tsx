// VEINED Guardian's character, the King Octopus: the owner-supplied artwork (derivatives and provenance in
// /assets/veined/guardian/guardian-manifest.json). It represents the assistant only; the approved VEINED octopus stays the
// brand symbol in the header, icons and the Guardian title. Static rasters, decorative (the surrounding control or
// heading carries the name). Plain <img>: next/image would add an inline style, which the CSP forbids.
const ART = "/assets/veined/guardian";

/** Conversation identity, floating assistant and review-panel crest (crown, face and upper arms). */
export function KingAvatar({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static character raster (CSP: no inline style).
    <img
      className={`king-avatar ${className}`}
      src={
        size > 32 ? `${ART}/king-avatar-128.webp` : `${ART}/king-avatar-64.webp`
      }
      srcSet={
        size > 32
          ? undefined
          : `${ART}/king-avatar-64.webp 1x, ${ART}/king-avatar-128.webp 2x`
      }
      width={size}
      height={size}
      alt=""
      decoding="async"
      draggable={false}
    />
  );
}

/** The whole figure, for the Guardian page hero. */
export function KingHero({ className = "" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static character raster (CSP: no inline style).
    <img
      className={`king-hero ${className}`}
      src={`${ART}/king-hero-400.webp`}
      srcSet={`${ART}/king-hero-400.webp 400w, ${ART}/king-hero-800.webp 800w`}
      sizes="(max-width: 720px) 200px, 300px"
      width={400}
      height={500}
      alt=""
      decoding="async"
      draggable={false}
    />
  );
}
