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
  title: "noumen — the coding agent you npm install",
  description:
    "The missing layer between LLMs and codebases. Tool loop, file editing, shell execution, and session management in one TypeScript package.",
  openGraph: {
    title: "noumen — the coding agent you npm install",
    description:
      "The missing layer between LLMs and codebases. Tool loop, file editing, shell execution, and session management in one TypeScript package.",
    images: [{ url: "/images/og-image.webp", width: 1536, height: 864 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "noumen — the coding agent you npm install",
    description:
      "The missing layer between LLMs and codebases. Tool loop, file editing, shell execution, and session management in one TypeScript package.",
    images: ["/images/og-image.webp"],
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
