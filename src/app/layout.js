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
      <head>
        {/* Plausible Analytics */}
        <Script
          strategy="afterInteractive"
          src="https://plausible.io/js/pa-WEGlcoBh-35CmEUTc2FES.js"
          data-domain="promptcut-mvp.vercel.app"
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
