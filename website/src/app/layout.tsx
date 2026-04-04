import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "optional",
});

export const metadata: Metadata = {
  title: "noumen — coding agents are products. This is the library.",
  description:
    "Every AI startup is rebuilding the same agent loop. This is the TypeScript SDK that replaces it — 7 providers, 4 sandboxes, 9 tools. MIT licensed.",
  openGraph: {
    title: "noumen — coding agents are products. This is the library.",
    description:
      "Every AI startup is rebuilding the same agent loop. This is the TypeScript SDK that replaces it — 7 providers, 4 sandboxes, 9 tools. MIT licensed.",
    images: [{ url: "/images/og-image.webp", width: 1536, height: 864 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "noumen — coding agents are products. This is the library.",
    description:
      "Every AI startup is rebuilding the same agent loop. This is the TypeScript SDK that replaces it — 7 providers, 4 sandboxes, 9 tools. MIT licensed.",
    images: ["/images/og-image.webp"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon.webp", type: "image/webp", sizes: "1024x1024" },
    ],
    apple: [{ url: "/apple-icon.webp", type: "image/webp", sizes: "1024x1024" }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${spaceGrotesk.variable}`} suppressHydrationWarning>
      <body className="bg-[var(--color-base-body)] text-[var(--color-text-primary)] min-h-screen antialiased">
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
