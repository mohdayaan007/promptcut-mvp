import Link from "next/link";
import { AppHeader } from "@/components/cliponaut/AppHeader";

export function MarketingLayout({ children }) {
  return (
    <div className="cliponaut-marketing-shell">
      <AppHeader />
      <main>{children}</main>
      <footer className="cliponaut-footer">
        <Link className="cliponaut-footer-brand" href="/" aria-label="Cliponaut home">Cliponaut</Link>
        <div className="cliponaut-footer-links">
          <Link href="/pricing">Pricing</Link>
          <Link href="/contact">Contact & support</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/refunds">Refunds & cancellation</Link>
        </div>
        <p>© {new Date().getFullYear()} Cliponaut</p>
      </footer>
    </div>
  );
}

export function PolicyPage({ eyebrow, title, updated, children }) {
  return (
    <MarketingLayout>
      <article className="cliponaut-policy">
        <p className="cliponaut-marketing-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="cliponaut-policy-updated">Last updated: {updated}</p>
        <div className="cliponaut-policy-body">{children}</div>
        <aside className="cliponaut-legal-review">
          <strong>Founder review needed</strong>
          <p>Business identity, legal contact details, retention periods, and the final refund terms must be confirmed before publishing this page.</p>
        </aside>
      </article>
    </MarketingLayout>
  );
}
