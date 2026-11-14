import type { MetadataRoute } from "next";
import { indexable, publicOrigin } from "../server/site";
// V1.11: crawling is opt-in (OTHERBRIDGE_PUBLIC_INDEXING=true + OTHERBRIDGE_PUBLIC_ORIGIN). Local, development and
// staging deployments are noindex by default. API routes are never crawled.
export default function robots(): MetadataRoute.Robots {
  const origin = publicOrigin();
  if (!indexable() || !origin)
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/activity", "/portfolio", "/settings"],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
