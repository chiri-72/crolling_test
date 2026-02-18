import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  title: "StartupFeed",
  description: "Global startup news aggregator with Korean translation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-gray-50 text-gray-900`}
      >
        <header className="sticky top-0 z-10 border-b bg-white/85 backdrop-blur">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
            <div>
              <Link href="/" className="text-lg font-bold tracking-tight">
                StartupFeed
              </Link>
              <p className="text-[11px] text-gray-500">Crawl monitoring and translated startup briefings</p>
            </div>
            <div className="flex gap-4 text-sm text-gray-600">
              <Link href="/" className="hover:text-gray-900">Home</Link>
              <Link href="/sources" className="hover:text-gray-900">Sources</Link>
              <Link href="/runs" className="hover:text-gray-900">Crawl Logs</Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
