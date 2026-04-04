import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "noumen — programmatic AI coding agents",
  description:
    "Headless, provider-agnostic coding agent library with pluggable AI providers and virtual infrastructure.",
  openGraph: {
    title: "noumen — programmatic AI coding agents",
    description:
      "Headless, provider-agnostic coding agent library with pluggable AI providers and virtual infrastructure.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="bg-[var(--color-base-body)] text-[var(--color-text-primary)] min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
