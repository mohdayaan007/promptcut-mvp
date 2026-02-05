import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

/* Fonts */

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

/* Metadata */

export const metadata = {
  title: "Cliponaut — Edit videos using prompts",
  description:
    "Cliponaut is an AI-powered video editor where you edit videos by typing what you want. No timelines, no complexity.",
  openGraph: {
    title: "Cliponaut",
    description: "AI-powered video editing with simple prompts",
    url: "https://cliponaut.com",
    siteName: "Cliponaut",
    type: "website",
  },
};

/* Root Layout */

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable}`}
    >
      <body className="antialiased bg-black text-white">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
