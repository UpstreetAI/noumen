import type { ComponentProps, ComponentType } from "react";
import type { MDXComponents } from "mdx/types";
import { notFound } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import { getMDXComponents } from "../../../../../mdx-components";
import { source } from "@/lib/docs/source";

type PageProps = {
  params: Promise<{ slug?: string[] }>;
};

export function generateStaticParams() {
  return source.generateParams();
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug ?? []);

  if (!page) {
    notFound();
  }

  const pageData = page.data as typeof page.data & {
    body: ComponentType<{ components?: MDXComponents }>;
    toc?: ComponentProps<typeof DocsPage>["toc"];
    title?: string;
    description?: string;
  };
  const MDX = pageData.body;

  return (
    <DocsPage toc={pageData.toc}>
      <DocsTitle>{pageData.title}</DocsTitle>
      {pageData.description ? (
        <DocsDescription>{pageData.description}</DocsDescription>
      ) : null}
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}
