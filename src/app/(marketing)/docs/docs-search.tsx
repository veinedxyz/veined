"use client";
import { useEffect, useMemo, useRef, useState } from "react";
// V1.11 docs search (client): filters a small server-built index of the current documentation language. The query
// is only compared as plain text (no regex, no HTML); results render as text links to same-site anchors.
export interface DocsIndexEntry {
  href: string;
  page: string;
  heading: string;
  text: string;
}
export function DocsSearch({
  index,
  label,
  placeholder,
  empty,
}: {
  index: DocsIndexEntry[];
  label: string;
  placeholder: string;
  empty: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [interactive, setInteractive] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // React preserves a text input's live value during hydration. Adopt any
    // text entered after the early shortcut, before the React handlers existed.
    if (input.current?.value) setQuery(input.current.value.slice(0, 80));
    setInteractive(true);
  }, []);
  const results = useMemo(() => {
    const words = query
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 6);
    if (!words.length) return [];
    return index
      .map((e) => {
        const hay = `${e.page} ${e.heading} ${e.text}`.toLocaleLowerCase();
        const score = words.reduce(
          (s, w) =>
            s +
            (hay.includes(w) ? 1 : 0) +
            (e.heading.toLocaleLowerCase().includes(w) ? 2 : 0),
          0,
        );
        return { e, score, all: words.every((w) => hay.includes(w)) };
      })
      .filter((r) => r.all)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [index, query]);
  return (
    <div className="dk-search" role="search">
      <label className="sr-only" htmlFor="docs-search">
        {label}
      </label>
      <input
        ref={input}
        id="docs-search"
        data-interactive={interactive ? "true" : "false"}
        type="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={80}
        placeholder={placeholder}
        value={query}
        role="combobox"
        aria-expanded={query.trim().length >= 2 && results.length > 0}
        aria-controls={results.length ? "docs-search-results" : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          results.length
            ? `docs-result-${Math.min(active, results.length - 1)}`
            : undefined
        }
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            setActive(0);
          }
          if (
            results.length &&
            (e.key === "ArrowDown" || e.key === "ArrowUp")
          ) {
            e.preventDefault();
            setActive(
              (a) =>
                (a + (e.key === "ArrowDown" ? 1 : -1) + results.length) %
                results.length,
            );
          }
          if (e.key === "Enter" && results.length) {
            e.preventDefault();
            window.location.assign(
              results[Math.min(active, results.length - 1)].e.href,
            );
          }
        }}
      />
      {query.trim().length >= 2 &&
        (results.length ? (
          <ul
            id="docs-search-results"
            className="dk-results"
            role="listbox"
            aria-label={label}
          >
            {results.map(({ e }, i) => (
              <li
                key={e.href}
                role="presentation"
                className={
                  i === Math.min(active, results.length - 1) ? "is-active" : ""
                }
              >
                <a
                  id={`docs-result-${i}`}
                  role="option"
                  aria-selected={i === Math.min(active, results.length - 1)}
                  href={e.href}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                >
                  <strong>{e.heading}</strong>
                  <small>
                    {e.page} · {e.text.slice(0, 90)}
                    {e.text.length > 90 ? "…" : ""}
                  </small>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dk-results" role="status">
            {empty}
          </p>
        ))}
    </div>
  );
}
