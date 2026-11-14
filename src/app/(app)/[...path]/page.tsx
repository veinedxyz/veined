import { notFound } from "next/navigation";
import { brand } from "../../../content/brand";
import { brandMetadata } from "../../../server/brand-metadata";
import { marketingLocale } from "../../(marketing)/locale";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  const { t } = await marketingLocale();
  const labels = {
    app: t("v119.overview"),
    portfolio: t("v13.portfolio"),
    points: t("points.nav"),
    guardian: t("guardian.nav"),
    swap: t("v13.swap"),
    bridge: t("product.bridge"),
    activity: t("product.activity"),
    scan: "VEINED Scan",
    networks: t("product.networks"),
    help: t("product.help"),
    about: t("product.about"),
    settings: t("product.settings"),
  };
  const label = labels[path[0] as keyof typeof labels];
  const metadata = brandMetadata(
    label ? `${label} · ${brand.name}` : brand.name,
    t("meta.description"),
  );
  // Address-specific state and activity identifiers never become canonicals or indexable metadata.
  return {
    ...metadata,
    robots: { index: false, follow: false, nocache: true },
  };
}
// V1.11: the application lives under /bridge, /swap, /portfolio, /activity(/<id>), /networks, /help, /about and
// /settings; "/" is the public landing page and /docs the public documentation (separate bundles, no wallet code).
// The views themselves are rendered by the Product shell of the (app) layout.
export default async function Page({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  if (
    (path.length === 1 &&
      [
        "app",
        "bridge",
        "swap",
        "portfolio",
        "points",
        "guardian",
        "activity",
        "scan",
        "networks",
        "help",
        "about",
        "settings",
      ].includes(path[0])) ||
    (path.length === 2 &&
      path[0] === "activity" &&
      /^[a-zA-Z0-9-]{1,80}$/.test(path[1]))
  )
    return null;
  notFound();
}
