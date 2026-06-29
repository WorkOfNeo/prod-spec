import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Every page should set its own `title` (see the per-page `metadata` /
  // `generateMetadata` exports). This template wraps that page title so the
  // browser tab reads e.g. "Styles · Prod Spec", which is what makes the app
  // navigable across many open tabs. Pages that don't set a title fall back
  // to `default`.
  title: {
    default: "Prod Spec",
    template: "%s · Prod Spec",
  },
  description: "Generate print-ready PDFs from Monday.com data",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
