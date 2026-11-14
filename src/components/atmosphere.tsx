/** Local, pre-encoded artwork. No runtime image service, inline styles or client JS.
 * The dimensions and positioned parent reserve space; the solid surface is the
 * fallback. Artwork is conceptual, never a route or coverage data source.
 * Ocean film layer: open water under the surface, cut from the owner's descent film (no animal in it, so the card
 * never shows a second octopus beside the living film behind the page). One image serves both themes. */

/** The first-scan texture is visible immediately. Its subdued backdrop does not
 * need the full-resolution render or a lazy-loading discovery round after hydration. */
export function PortfolioAtmosphere() {
  return (
    <picture className="veined-atmosphere">
      <img
        src="/assets/veined/ocean-film/portfolio-water-l960.webp"
        width={960}
        height={540}
        alt=""
        loading="eager"
        fetchPriority="auto"
        decoding="async"
      />
    </picture>
  );
}
