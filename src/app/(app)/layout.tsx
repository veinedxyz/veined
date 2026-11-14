import { headers } from "next/headers";
import { Product } from "../../components/product";
import { g7LocalPilotGate } from "../../server/g7-local-pilot";
export const dynamic = "force-dynamic";
// The application shell (wallet layer, Bridge/Swap/Portfolio/Activity/Networks). Only /bridge … /settings render
// inside it; the public landing page and /docs never load this module.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pilot = g7LocalPilotGate((await headers()).get("host"));
  return <Product pilot={pilot}>{children}</Product>;
}
