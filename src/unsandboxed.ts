// Unsandboxed local binding — raw host access, no isolation.
//
// Importing this subpath is the explicit opt-in to a sandbox that gives the
// agent everything the host process has. The root barrel (`noumen`) does not
// re-export this module, so reaching for unsandboxed execution always shows
// up as a dedicated import line.
//
//   import { UnsandboxedLocal } from "noumen/unsandboxed";

export {
  UnsandboxedLocal,
  type UnsandboxedLocalOptions,
} from "./virtual/unsandboxed.js";
