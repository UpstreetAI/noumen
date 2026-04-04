import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseLayoutOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-1.5 font-bold">noumen</span>
      ),
      url: "/docs",
    },
    links: [
      {
        text: "GitHub",
        url: "https://github.com/user/noumen",
      },
      {
        text: "npm",
        url: "https://www.npmjs.com/package/noumen",
      },
    ],
  };
}
