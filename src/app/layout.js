import { Manrope } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400"], // Regular
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
      <body className={`${manrope.className} bg-black text-white antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
