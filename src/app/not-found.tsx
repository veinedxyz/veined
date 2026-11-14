import { brand } from "../content/brand";
import { BrandLogo } from "../components/brand-logo";
import Link from "next/link";
import styles from "./not-found.module.css";

// The framework default embeds a style block without the request nonce.
// Keep the error page inside the application's strict CSP and locale layout.
export default function NotFound() {
  return (
    <main className={styles.page}>
      <h1>404</h1>
      <Link href="/" dir="ltr" aria-label={brand.name}>
        <BrandLogo decorative />
      </Link>
    </main>
  );
}
