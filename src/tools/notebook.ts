import type { Tool, ToolResult, ToolContext } from "./types.js";

interface NotebookCell {
  cell_type: string;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface NotebookDocument {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export const notebookEditTool: Tool = {
  name: "NotebookEdit",
  description:
    "Edit a Jupyter notebook (.ipynb) file. Can replace, insert, or delete " +
    "cells. The notebook is pure JSON — no kernel execution.",
  isReadOnly: false,
  isConcurrencySafe: false,
  parameters: {
    type: "object",
    properties: {
      notebook_path: {
        type: "string",
        description: "Path to the .ipynb file",
      },
      cell_index: {
        type: "number",
        description: "0-based index of the cell to edit. For insert, the new cell is placed at this index.",
      },
      new_source: {
        type: "string",
        description:
          "The new cell source content. Each line becomes an element in the source array.",
      },
      cell_type: {
        type: "string",
        description: 'Cell type: "code" or "markdown" (default: "code")',
      },
      edit_mode: {
        type: "string",
        description:
          '"replace" (default) — replace existing cell source; ' +
          '"insert" — insert a new cell at cell_index; ' +
          '"delete" — delete the cell at cell_index (new_source is ignored)',
      },
    },
    required: ["notebook_path", "cell_index"],
  },

  async call(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const path = args.notebook_path as string;
    const cellIndex = args.cell_index as number;
    const newSource = (args.new_source as string | undefined) ?? "";
    const cellType = (args.cell_type as string | undefined) ?? "code";
    const editMode = (args.edit_mode as string | undefined) ?? "replace";

    try {
      const raw = await ctx.fs.readFile(path);
      let notebook: NotebookDocument;
      try {
        notebook = JSON.parse(raw);
      } catch {
        return { content: `Not a valid JSON notebook: ${path}`, isError: true };
      }

      if (!Array.isArray(notebook.cells)) {
        return { content: "Notebook has no cells array.", isError: true };
      }

      const sourceLines = newSource.split("\n").map((line, i, arr) =>
        i < arr.length - 1 ? line + "\n" : line,
      );

      switch (editMode) {
        case "replace": {
          if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
            return {
              content: `Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).`,
              isError: true,
            };
          }
          notebook.cells[cellIndex].source = sourceLines;
          notebook.cells[cellIndex].cell_type = cellType;
          break;
        }
        case "insert": {
          if (cellIndex < 0 || cellIndex > notebook.cells.length) {
            return {
              content: `Insert index ${cellIndex} out of range (0-${notebook.cells.length}).`,
              isError: true,
            };
          }
          const newCell: NotebookCell = {
            cell_type: cellType,
            source: sourceLines,
            metadata: {},
            ...(cellType === "code"
              ? { outputs: [], execution_count: null }
              : {}),
          };
          notebook.cells.splice(cellIndex, 0, newCell);
          break;
        }
        case "delete": {
          if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
            return {
              content: `Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).`,
              isError: true,
            };
          }
          notebook.cells.splice(cellIndex, 1);
          break;
        }
        default:
          return {
            content: `Unknown edit_mode: ${editMode}. Use "replace", "insert", or "delete".`,
            isError: true,
          };
      }

      await ctx.fs.writeFile(path, JSON.stringify(notebook, null, 1) + "\n");

      const action =
        editMode === "delete"
          ? `Deleted cell ${cellIndex}`
          : editMode === "insert"
            ? `Inserted new ${cellType} cell at index ${cellIndex}`
            : `Replaced cell ${cellIndex} content`;

      return { content: `${action} in ${path}. Notebook now has ${notebook.cells.length} cells.` };
    } catch (err) {
      return {
        content: `Error editing notebook: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
