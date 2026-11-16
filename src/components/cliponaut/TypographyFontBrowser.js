"use client";

import { useEffect, useMemo, useState } from "react";
import { googleFontPreviewStylesheet, searchGoogleFonts } from "@/lib/typography/google-font-catalog";

/**
 * Progressive font explorer. This component is not yet wired into the live
 * editor; server export support must be in place before broader "Use" actions.
 * UI font loading uses Google's public CSS only for members of the allowlist.
 */
export function TypographyFontBrowser({ initialText = "BANGALORE AFTER DARK", onUseFont = null }) {
  const [query, setQuery] = useState("");
  const [sample, setSample] = useState(initialText);
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState(null);
  const [loaded, setLoaded] = useState({});
  const page = useMemo(() => searchGoogleFonts({ query, offset, limit: 12 }), [query, offset]);

  useEffect(() => {
    let cancelled = false;
    const nodes = [];
    const fonts = page.families;
    async function load() {
      await Promise.all(fonts.map(async (font) => {
        const href = googleFontPreviewStylesheet(font.family);
        if (!href) return;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.dataset.cliponautFontPreview = font.slug;
        document.head.appendChild(link);
        nodes.push(link);
        try {
          await new Promise((resolve, reject) => {
            link.onload = resolve;
            link.onerror = reject;
          });
          await document.fonts.load(`400 26px "${font.family.replace(/["\\]/g, "")}"`, "Typography");
          if (!cancelled) setLoaded((current) => ({ ...current, [font.slug]: true }));
        } catch {
          if (!cancelled) setLoaded((current) => ({ ...current, [font.slug]: false }));
        }
      }));
    }
    load();
    return () => { cancelled = true; for (const node of nodes) node.remove(); };
  }, [page]);

  const chosen = active && page.families.find((font) => font.slug === active);
  return (
    <section aria-label="Typography font library" style={{ display: "grid", gap: 12 }}>
      <header>
        <h2 style={{ fontSize: 18, fontWeight: 650 }}>Explore fonts</h2>
        <p style={{ fontSize: 13, opacity: 0.7 }}>AI chooses the first font. Browse alternatives only when you want to change it.</p>
      </header>
      <label style={{ display: "grid", gap: 4 }}>
        <span>Search font families</span>
        <input aria-label="Search Google Fonts" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); setActive(null); }} placeholder="Try Anton, Playfair, Noto Sans..." maxLength={80} />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span>Preview your own title</span>
        <input aria-label="Font preview text" value={sample} onChange={(event) => setSample(event.target.value)} maxLength={140}/>
      </label>
      <p aria-live="polite" style={{ fontSize: 12, opacity: 0.7 }}>{page.total} font families · Showing {page.families.length} · Previews require Google Fonts access</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        {page.families.map((font) => {
          const hasLoaded = loaded[font.slug] === true;
          return (
            <button
              key={font.slug}
              type="button"
              onClick={() => setActive(font.slug)}
              aria-pressed={active === font.slug}
              style={{ textAlign: "left", border: active === font.slug ? "2px solid currentColor" : "1px solid #9998", borderRadius: 12, padding: 12, background: "transparent", color: "inherit", cursor: "pointer" }}
            >
              <span style={{ display: "block", fontSize: 12, marginBottom: 10 }}>{font.family}</span>
              <span style={{ display: "block", overflowWrap: "anywhere", fontFamily: hasLoaded ? `"${font.family}", sans-serif` : "inherit", fontSize: 25, minHeight: 58 }}>
                {hasLoaded ? (sample || "Your title") : loaded[font.slug] === false ? "Preview unavailable" : "Loading font…"}
              </span>
              <span style={{ display: "block", fontSize: 11, opacity: 0.65, marginTop: 8 }}>{font.exportReady ? "Available for export" : "Preview only · Export not yet provisioned"}</span>
            </button>
          );
        })}
      </div>
      {chosen && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: 13 }}>Selected: {chosen.family}</span>
          <button type="button" disabled={!chosen.exportReady || !loaded[chosen.slug] || !onUseFont} onClick={() => onUseFont?.(chosen.family)}>
            {chosen.exportReady ? "Use selected font" : "Export support coming"}
          </button>
        </div>
      )}
      <nav aria-label="Font pages" style={{ display: "flex", gap: 10 }}>
        <button type="button" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 12)); setActive(null); }}>Previous</button>
        <button type="button" disabled={offset + 12 >= page.total} onClick={() => { setOffset(offset + 12); setActive(null); }}>Next</button>
      </nav>
    </section>
  );
}
