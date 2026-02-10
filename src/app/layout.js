import { Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
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
    <html lang="en" className={inter.variable}>
      <body className="bg-black text-white antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
