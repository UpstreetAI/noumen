import type { ReactNode } from "react";
import "./docs.css";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { baseLayoutOptions } from "@/lib/docs/layout.shared";
import { source } from "@/lib/docs/source";
import { SidebarInstallCTA } from "./sidebar-install-cta";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen">
      <div
        className="pointer-events-none fixed inset-0 z-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 20% 10%, rgba(96,165,250,0.05) 0%, transparent 70%), radial-gradient(ellipse 50% 40% at 80% 80%, rgba(34,211,238,0.03) 0%, transparent 70%)",
        }}
      />
      <RootProvider theme={{ enabled: false }}>
        <DocsLayout
          {...baseLayoutOptions()}
          tree={source.getPageTree()}
          themeSwitch={{ enabled: false }}
          sidebar={{ footer: <SidebarInstallCTA key="install-cta" /> }}
        >
          {children}
        </DocsLayout>
      </RootProvider>
    </div>
  );
}
