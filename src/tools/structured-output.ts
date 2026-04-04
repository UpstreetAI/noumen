import type { Tool, ToolResult, ToolContext } from "./types.js";
import type { JsonSchemaOutputFormat } from "../providers/types.js";

const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

/**
 * Creates a synthetic tool whose input schema matches the user's desired
 * output schema. When the model calls this tool, the agent loop treats it
 * as the final structured response and terminates.
 *
 * This is the "final_response" pattern: the model reasons freely (using
 * tools), and signals completion by calling StructuredOutput with data
 * that conforms to the schema.
 */
export function createStructuredOutputTool(
  format: JsonSchemaOutputFormat,
): Tool {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description:
      "Return your final structured answer. Call this tool ONCE when you " +
      "have gathered all necessary information and are ready to respond. " +
      "The input MUST conform to the required JSON schema.",
    prompt: "",
    isReadOnly: true,
    isConcurrencySafe: true,
    parameters: {
      type: "object",
      properties: {
        data: {
          type: "object",
          description: "The structured response data conforming to the schema.",
        },
      },
      required: ["data"],
    },

    async call(
      args: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> {
      return {
        content: JSON.stringify(args.data ?? args, null, 2),
      };
    },
  };
}

export { STRUCTURED_OUTPUT_TOOL_NAME };
