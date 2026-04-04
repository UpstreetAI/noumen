import type { PermissionContext, PermissionUpdate } from "./types.js";

/**
 * Apply a permission update to an in-memory context.
 * Returns the mutated context (same reference).
 */
export function applyPermissionUpdate(
  ctx: PermissionContext,
  update: PermissionUpdate,
): PermissionContext {
  switch (update.type) {
    case "addRules":
      ctx.rules.push(...update.rules);
      break;

    case "removeRules":
      ctx.rules = ctx.rules.filter((r) => {
        if (r.toolName !== update.toolName) return true;
        if (update.behavior && r.behavior !== update.behavior) return true;
        return false;
      });
      break;

    case "setMode":
      ctx.mode = update.mode;
      break;

    case "addDirectories":
      for (const dir of update.directories) {
        if (!ctx.workingDirectories.includes(dir)) {
          ctx.workingDirectories.push(dir);
        }
      }
      break;

    case "removeDirectories":
      ctx.workingDirectories = ctx.workingDirectories.filter(
        (d) => !update.directories.includes(d),
      );
      break;
  }

  return ctx;
}

/**
 * Apply multiple permission updates in order.
 */
export function applyPermissionUpdates(
  ctx: PermissionContext,
  updates: PermissionUpdate[],
): PermissionContext {
  for (const update of updates) {
    applyPermissionUpdate(ctx, update);
  }
  return ctx;
}
