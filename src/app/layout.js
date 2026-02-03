import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
