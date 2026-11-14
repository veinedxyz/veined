import { PointsAdmin } from "../../../../components/points-admin";
import { brand } from "../../../../content/brand";
export const dynamic = "force-dynamic";
// V1.22 internal points administration. Outside the wallet shell; every figure is fetched per request from the
// bearer-authenticated admin API, so this page itself carries no data and is never indexed.
export const metadata = {
  title: `Points admin · ${brand.name}`,
  robots: { index: false, follow: false, nocache: true },
};
export default function PointsAdminPage() {
  return <PointsAdmin />;
}
