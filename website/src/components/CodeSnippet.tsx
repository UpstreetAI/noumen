export function CodeSnippet({
  code,
  filename,
}: {
  code: string;
  filename?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-base-body)] p-4 font-mono text-[13px] leading-6 shadow-lg overflow-x-auto">
      <div className="mb-3 flex items-center gap-2">
        <div className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <div className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <div className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        {filename && (
          <span className="ml-2 text-[10px] text-[var(--color-text-tertiary)]">
            {filename}
          </span>
        )}
      </div>
      <pre className="whitespace-pre">
        <code className="text-[var(--color-text-secondary)]">{code}</code>
      </pre>
    </div>
  );
}
