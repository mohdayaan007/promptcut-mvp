import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
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
  title: "PromptCut",
  description: "Edit videos using natural language",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* Plausible Analytics */}
        <Script
          strategy="afterInteractive"
          data-domain="promptcut-mvp.vercel.app"
          src="https://plausible.io/js/script.js"
        />

        {children}
      </body>
    </html>
  );
}
