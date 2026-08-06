import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const satoshiFallback = localFont({
  src: "../../public/fonts/Inter-Variable.ttf",
  variable: "--font-satoshi",
  display: "swap",
});

const displayFallback = localFont({
  src: "../../public/fonts/InstrumentSerif-Regular.ttf",
  variable: "--font-display",
  display: "swap",
});

export const metadata = {
  title: "Cliponaut — Video editing, simplified by AI",
  description:
    "Edit videos by describing what you want. No timelines. No complexity.",
  openGraph: {
    title: "Cliponaut",
    description: "Video editing, simplified by AI",
    url: "https://cliponaut.com",
    siteName: "Cliponaut",
    type: "website",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${satoshiFallback.variable} ${displayFallback.variable} antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
