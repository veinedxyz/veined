import type { Metadata } from "next";
import { Product } from "../components/product";
import "./globals.css";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Otherbridge — ONEchain → BSC",
  description:
    "Native ONE to canonical CROSS. Independent interface; mainnet submission disabled.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr" data-theme="dark">
      <body>
        <Product>{children}</Product>
      </body>
    </html>
  );
}
