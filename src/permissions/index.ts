export type {
  PermissionMode,
  PermissionBehavior,
  PermissionRule,
  PermissionAllowResult,
  PermissionDenyResult,
  PermissionAskResult,
  PermissionPassthroughResult,
  PermissionResult,
  PermissionDecision,
  PermissionRequest,
  PermissionResponse,
  PermissionHandler,
  PermissionConfig,
  PermissionContext,
} from "./types.js";

export {
  toolMatchesRule,
  contentMatchesRule,
  matchSimpleGlob,
  getMatchingRules,
  isPathInWorkingDirectories,
} from "./rules.js";

export { resolvePermission } from "./pipeline.js";
