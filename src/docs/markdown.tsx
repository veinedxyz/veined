// V1.11 minimal, safe Markdown renderer for /docs (server-side). Output is React elements only: there is no raw HTML
// path at all (no raw-HTML injection API is used), every text node is escaped by React, and links are restricted to
// same-site paths, in-page anchors and https URLs (rendered with rel="noopener noreferrer external").
// Supported: # ## ### headings (with stable ids), paragraphs, - / 1. lists, ``` code fences, `code`, **bold**,
// *italic*, [text](href), | tables |, > notes, ---.
import type { ReactNode } from "react";

export function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}
/** Only same-site paths, in-page anchors and https URLs survive; everything else renders as plain text. */
export function safeHref(
  href: string,
): { href: string; external: boolean } | null {
  const h = href.trim();
  if (/^#[\p{L}\p{N}_-]{1,80}$/u.test(h)) return { href: h, external: false };
  if (/^\/(?!\/)[A-Za-z0-9/_#?=&.-]{0,200}$/.test(h) && !h.includes(".."))
    return { href: h, external: false };
  try {
    const u = new URL(h);
    if (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !/[\s<>"'`]/.test(h)
    )
      return { href: u.toString(), external: true };
  } catch {
    /* not a URL */
  }
  return null;
}
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokens: `code`, **bold**, *italic*, [label](href). Anything unmatched stays literal text.
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]{1,200}\]\([^)\s]{1,300}\))/g;
  let last = 0,
    m: RegExpExecArray | null,
    i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2])
      out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else {
      const label = tok.slice(1, tok.indexOf("]("));
      const href = safeHref(tok.slice(tok.indexOf("](") + 2, -1));
      out.push(
        href ? (
          <a
            key={k}
            href={href.href}
            {...(href.external
              ? { rel: "noopener noreferrer external", target: "_blank" }
              : {})}
          >
            {label}
          </a>
        ) : (
          label
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export interface Heading {
  level: 2 | 3;
  text: string;
  id: string;
}
export function renderMarkdown(source: string): {
  title: string;
  nodes: ReactNode[];
  headings: Heading[];
} {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  const headings: Heading[] = [];
  const used = new Set<string>();
  let title = "";
  let i = 0,
    n = 0;
  const id = (text: string) => {
    let base = slugify(text) || "section",
      candidate = base,
      k = 2;
    while (used.has(candidate)) candidate = `${base}-${k++}`;
    used.add(candidate);
    base = candidate;
    return base;
  };
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```"))
        body.push(lines[i++]);
      i++;
      nodes.push(
        <pre key={key} dir="ltr">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      const text = h[2].trim();
      if (h[1].length === 1) {
        title = text;
        nodes.push(<h1 key={key}>{inline(text, key)}</h1>);
      } else {
        const hid = id(text);
        const level = h[1].length as 2 | 3;
        headings.push({ level, text, id: hid });
        nodes.push(
          level === 2 ? (
            <h2 key={key} id={hid}>
              {inline(text, key)}
            </h2>
          ) : (
            <h3 key={key} id={hid}>
              {inline(text, key)}
            </h3>
          ),
        );
      }
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={key} />);
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">"))
        body.push(lines[i++].replace(/^>\s?/, ""));
      nodes.push(
        <blockquote key={key}>
          <p>{inline(body.join(" "), key)}</p>
        </blockquote>,
      );
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i]
          .trim()
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      nodes.push(
        <table key={key}>
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>{inline(c, `${key}h${j}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, j) => (
                  <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const ordered = /^\d+\.\s+/.test(line);
    if (ordered || /^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (
        i < lines.length &&
        (ordered ? /^\d+\.\s+/ : /^[-*]\s+/).test(lines[i])
      ) {
        let item = lines[i].replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]))
          item += " " + lines[i++].trim();
        items.push(item);
      }
      const children = items.map((it, j) => (
        <li key={j}>{inline(it, `${key}i${j}`)}</li>
      ));
      nodes.push(
        ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|```|>|\||[-*]\s|\d+\.\s|---+$)/.test(lines[i])
    )
      para.push(lines[i++].trim());
    nodes.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return { title, nodes, headings };
}
/** Plain text for the search index (markup stripped). */
export function plainText(source: string) {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*#>|_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
