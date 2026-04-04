import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseLayoutOptions(): BaseLayoutProps {
  return {
    nav: {
      enabled: false,
    },
    links: [],
  };
}
