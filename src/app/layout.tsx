import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

// analyticsOS (page views, clicks, scrolls, forms, errors, Web Vitals). Unset
// key = nothing loads: the off switch for local dev and previews. NEXT_PUBLIC_
// values are inlined at BUILD time, so changing them on Railway needs a redeploy.
const ANALYTICS_HOST = process.env.NEXT_PUBLIC_ANALYTICS_HOST;
const ANALYTICS_KEY = process.env.NEXT_PUBLIC_ANALYTICS_KEY;

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
      <body className="min-h-full flex flex-col">
        {children}
        {/* next/script, never a plain <script>: React doesn't run a script tag
            it adds during a client-side navigation. The stub queues aos()
            calls made before the real script arrives; it is beforeInteractive
            because AnalyticsIdentify's mount effect runs BEFORE an
            afterInteractive script is injected, and would find no window.aos. */}
        {ANALYTICS_HOST && ANALYTICS_KEY && (
          <>
            <Script id="aos-stub" strategy="beforeInteractive">
              {`window.aos=window.aos||function(){(window.aos.q=window.aos.q||[]).push(arguments)}`}
            </Script>
            <Script src={`${ANALYTICS_HOST}/s/${ANALYTICS_KEY}.js`} strategy="afterInteractive" />
          </>
        )}
      </body>
    </html>
  );
}
