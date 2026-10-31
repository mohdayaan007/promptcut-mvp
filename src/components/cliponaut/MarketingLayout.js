import Link from "next/link";
import { AppHeader } from "@/components/cliponaut/AppHeader";

export function MarketingLayout({ children }) {
  return <div className="cliponaut-marketing-shell">
    <AppHeader />
    <main>{children}</main>
    <footer className="cliponaut-footer">
      <Link className="cliponaut-footer-brand" href="/">Cliponaut</Link>
      <nav className="cliponaut-footer-links" aria-label="Site information">
        <Link href="/pricing">Pricing</Link>
        <Link href="/contact">Contact</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/refunds">Refunds & cancellation</Link>
        <Link href="/safety">Content safety</Link>
      </nav>
      <p>© {new Date().getFullYear()} Cliponaut</p>
    </footer>
  </div>;
}

export function PolicyPage({ eyebrow, title, children }) {
  return <MarketingLayout>
    <article className="cliponaut-policy">
      <p className="cliponaut-marketing-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="cliponaut-policy-updated">Updated 31 October 2026 · Early-access information</p>
      <div className="cliponaut-policy-body">{children}</div>
    </article>
  </MarketingLayout>;
}