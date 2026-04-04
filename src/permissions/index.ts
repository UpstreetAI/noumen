export type {
  PermissionMode,
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
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
  PermissionUpdate,
  AutoModeConfig,
  DenialTrackingConfig,
} from "./types.js";

export { RULE_SOURCE_PRECEDENCE } from "./types.js";

export {
  toolMatchesRule,
  contentMatchesRule,
  matchSimpleGlob,
  getMatchingRules,
  isPathInWorkingDirectories,
} from "./rules.js";

export { resolvePermission } from "./pipeline.js";
export type { ResolvePermissionOptions } from "./pipeline.js";

export { applyPermissionUpdate, applyPermissionUpdates } from "./updates.js";

export { DenialTracker } from "./denial-tracking.js";
export type { DenialLimits, DenialState } from "./denial-tracking.js";

export { classifyPermission } from "./classifier.js";
export type { ClassifierResult } from "./classifier.js";
