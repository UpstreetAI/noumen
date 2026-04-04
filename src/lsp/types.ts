export interface LspServerConfig {
  /** Command to start the LSP server. */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Root URI for the workspace. */
  rootUri?: string;
  /** File extensions this server handles (e.g., [".ts", ".tsx", ".js"]). */
  fileExtensions: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
}

export type LspServerState = "stopped" | "starting" | "running" | "error";

export interface LspDiagnostic {
  filePath: string;
  line: number;
  character: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol";

export interface LspLocation {
  filePath: string;
  line: number;
  character: number;
}

export interface LspSymbol {
  name: string;
  kind: string;
  location: LspLocation;
  containerName?: string;
}
