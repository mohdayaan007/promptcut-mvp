import Image from "next/image";
import Link from "next/link";

export function AppHeader() {
  return (
    <header className="cliponaut-header">
      <Link className="cliponaut-brand" href="/" aria-label="Cliponaut home">
        <Image src="/cliponaut.svg" alt="Cliponaut" width={320} height={86} priority />
      </Link>

      <nav className="cliponaut-header-links" aria-label="Primary navigation">
        <Link href="/pricing">Pricing</Link>
        <Link href="/contact">Support</Link>
        <a href="https://x.com/uxayaan" target="_blank" rel="noreferrer">
          X
        </a>
      </nav>
    </header>
  );
}
