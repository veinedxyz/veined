import type { Metadata } from "next";
import { brand } from "../content/brand";
import { indexable } from "./site";

/** Planned canonical identity, independent of API origin authorization. Preview is always noindex. */
export function brandMetadata(
  title: string,
  description: string,
  path?: string,
): Metadata {
  return {
    metadataBase: new URL(brand.publicOrigin),
    title: { absolute: title },
    description,
    applicationName: brand.name,
    manifest: "/manifest.webmanifest",
    ...(path ? { alternates: { canonical: path } } : {}),
    robots: indexable()
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true },
    openGraph: {
      type: "website",
      siteName: brand.name,
      title,
      description,
      ...(path ? { url: path } : {}),
      images: [
        {
          url: "/assets/veined/brand-octopus/og-image.png",
          width: 1200,
          height: 630,
          alt: `${brand.name} — ${brand.category}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/assets/veined/brand-octopus/og-image.png"],
    },
  };
}
