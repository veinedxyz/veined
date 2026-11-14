import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOCS } from "../../../../docs/content.generated";
import {
  DOC_PAGES,
  docLocaleFor,
  isDocSlug,
  type DocSlug,
} from "../../../../docs/pages";
import { docConstants, substitute } from "../../../../docs/constants";
import { plainText, renderMarkdown, slugify } from "../../../../docs/markdown";
import { marketingLocale } from "../../locale";
import { brandMetadata } from "../../../../server/brand-metadata";
import { DocsSearch, type DocsIndexEntry } from "../docs-search";
// V1.11 public documentation. Repository Markdown (English + Turkish), rendered server-side by a safe renderer with
// live product constants; no wallet, routing, portfolio or G7 code is loaded here.
function resolve(slug?: string[]): DocSlug | null {
  if (!slug || !slug.length) return "start";
  const joined = slug.join("/");
  return isDocSlug(joined) ? joined : null;
}
function source(page: DocSlug, docLocale: "en" | "tr", appLocale: string) {
  return substitute(DOCS[page][docLocale], docConstants(appLocale));
}
const indexCache = new Map<string, DocsIndexEntry[]>();
function searchIndex(docLocale: "en" | "tr", appLocale: string) {
  const key = `${docLocale}:${appLocale}`;
  const hit = indexCache.get(key);
  if (hit) return hit;
  const out: DocsIndexEntry[] = [];
  for (const page of DOC_PAGES) {
    const md = source(page, docLocale, appLocale);
    const title = /^#\s+(.+)$/m.exec(md)?.[1] ?? page;
    // One entry per section (## / ###): heading + its first ~240 characters of plain text.
    const parts = md.split(/^(?=#{2,3}\s)/m);
    parts.forEach((part, i) => {
      const heading =
        i === 0 ? title : (/^#{2,3}\s+(.+)$/m.exec(part)?.[1] ?? title);
      out.push({
        href: `/docs/${page === "start" ? "" : page}${i === 0 ? "" : `#${slugify(heading)}`}`.replace(
          "/docs/#",
          "/docs#",
        ),
        page: title,
        heading,
        text: plainText(part.replace(/^#{1,3}\s+.+$/m, "")).slice(0, 240),
      });
    });
  }
  indexCache.set(key, out);
  return out;
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const page = resolve((await params).slug);
  if (!page) return {};
  const { locale, t } = await marketingLocale();
  const docLocale = docLocaleFor(locale);
  const { title } = renderMarkdown(source(page, docLocale, locale));
  const path = page === "start" ? "/docs" : `/docs/${page}`;
  return brandMetadata(
    `${title} · ${t("docs.metaSuffix")}`,
    t("docs.metaDescription"),
    path,
  );
}
export default async function DocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const page = resolve((await params).slug);
  if (!page) notFound();
  const { locale, t } = await marketingLocale();
  const docLocale = docLocaleFor(locale);
  const { nodes } = renderMarkdown(source(page, docLocale, locale));
  const titles = DOC_PAGES.map((p) => ({
    slug: p,
    title: /^#\s+(.+)$/m.exec(DOCS[p][docLocale])?.[1] ?? p,
  }));
  const at = DOC_PAGES.indexOf(page);
  const prev = at > 0 ? titles[at - 1] : null,
    next = at < titles.length - 1 ? titles[at + 1] : null;
  const href = (slug: string) => (slug === "start" ? "/docs" : `/docs/${slug}`);
  const navigation = () => (
    <nav aria-label={t("docs.navLabel")}>
      {titles.map((p) => (
        <Link
          key={p.slug}
          href={href(p.slug)}
          aria-current={p.slug === page ? "page" : undefined}
        >
          {p.title}
        </Link>
      ))}
    </nav>
  );
  return (
    <div className="dk">
      <aside className="dk-side" aria-label={t("docs.navLabel")}>
        <DocsSearch
          index={searchIndex(docLocale, locale)}
          label={t("docs.searchLabel")}
          placeholder={t("docs.searchPlaceholder")}
          empty={t("docs.searchEmpty")}
        />
        <div className="dk-desktop-nav">{navigation()}</div>
        <details className="dk-mobile-nav">
          <summary>
            {t("landing.docs")} <span aria-hidden="true">⌄</span>
          </summary>
          {navigation()}
        </details>
        {docLocale !== locale && (
          <p className="dk-lang-note">{t("docs.languageNote")}</p>
        )}
      </aside>
      <article className="dk-article" lang={docLocale}>
        <p className="dk-meta">{t("docs.metaLine")}</p>
        {nodes}
        <nav className="dk-pager" aria-label={t("docs.pager")}>
          {prev ? <Link href={href(prev.slug)}>← {prev.title}</Link> : <span />}
          {next ? <Link href={href(next.slug)}>{next.title} →</Link> : <span />}
        </nav>
      </article>
    </div>
  );
}
