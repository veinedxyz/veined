import type { MetadataRoute } from "next";
import { DOC_PAGES } from "../docs/pages";
import { indexable, publicOrigin } from "../server/site";
// Public pages only; wallet-specific Portfolio and Activity never enter the sitemap.
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  if (!indexable() || !origin) return [];
  const paths = [
    "/",
    "/docs",
    ...DOC_PAGES.filter((p) => p !== "start").map((p) => `/docs/${p}`),
    "/bridge",
    "/swap",
    "/networks",
    "/help",
  ];
  return paths.map((p) => ({
    url: `${origin}${p === "/" ? "" : p}`,
    changeFrequency: p.startsWith("/docs") ? "weekly" : "daily",
    priority: p === "/" ? 1 : p.startsWith("/docs") ? 0.6 : 0.8,
  }));
}
