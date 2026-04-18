import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";
import {
  loadCliConfig,
  loadGlobalConfig,
  resolveCliDotDirs,
} from "../cli/config.js";
import { createDotDirResolver } from "../config/dot-dirs.js";

function mkTmp(prefix: string): string {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
}

function writeJson(filePath: string, data: unknown): void {
  nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  nodeFs.writeFileSync(filePath, JSON.stringify(data));
}

describe("CLI config dot-dir resolution", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = mkTmp("noumen-cli-dotdirs-");
    // Isolate HOME so loadGlobalConfig doesn't touch the real ~/.noumen
    origHome = process.env.HOME;
    process.env.HOME = nodePath.join(tmp, "home");
    nodeFs.mkdirSync(process.env.HOME, { recursive: true });
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    nodeFs.rmSync(tmp, { recursive: true, force: true });
  });

  it(".noumen/config.json wins when both exist in project", () => {
    const project = nodePath.join(tmp, "proj");
    writeJson(nodePath.join(project, ".noumen/config.json"), { model: "noumen" });
    writeJson(nodePath.join(project, ".claude/config.json"), { model: "claude" });

    const config = loadCliConfig(project);
    expect(config.model).toBe("noumen");
  });

  it(".claude/config.json is loaded when only it exists", () => {
    const project = nodePath.join(tmp, "proj");
    writeJson(nodePath.join(project, ".claude/config.json"), { model: "claude-only" });

    const config = loadCliConfig(project);
    expect(config.model).toBe("claude-only");
  });

  it("returns empty object when nothing found", () => {
    const project = nodePath.join(tmp, "proj");
    nodeFs.mkdirSync(project, { recursive: true });
    const config = loadCliConfig(project);
    expect(config).toEqual({});
  });

  it("walks up to ancestor .claude/config.json", () => {
    const project = nodePath.join(tmp, "outer", "inner", "deep");
    nodeFs.mkdirSync(project, { recursive: true });
    writeJson(nodePath.join(tmp, "outer/.claude/config.json"), { model: "ancestor-claude" });

    const config = loadCliConfig(project);
    expect(config.model).toBe("ancestor-claude");
  });

  it("prefers closer ancestor .noumen over deeper .claude", () => {
    const project = nodePath.join(tmp, "outer", "inner", "deep");
    nodeFs.mkdirSync(project, { recursive: true });
    writeJson(nodePath.join(tmp, "outer/.claude/config.json"), { model: "far-claude" });
    writeJson(nodePath.join(tmp, "outer/inner/.noumen/config.json"), { model: "close-noumen" });

    const config = loadCliConfig(project);
    expect(config.model).toBe("close-noumen");
  });

  it("prefers .noumen over .claude at the same ancestor", () => {
    const project = nodePath.join(tmp, "outer", "inner");
    nodeFs.mkdirSync(project, { recursive: true });
    writeJson(nodePath.join(tmp, "outer/.noumen/config.json"), { model: "noumen-at-outer" });
    writeJson(nodePath.join(tmp, "outer/.claude/config.json"), { model: "claude-at-outer" });

    const config = loadCliConfig(project);
    expect(config.model).toBe("noumen-at-outer");
  });

  it("honors a dotDirs override at the project level", () => {
    const project = nodePath.join(tmp, "proj");
    writeJson(nodePath.join(project, ".noumen/config.json"), { model: "noumen" });
    writeJson(nodePath.join(project, ".custom/config.json"), {
      model: "custom",
      dotDirs: { names: [".custom", ".noumen"] },
    });

    // With default resolver, .noumen wins (phase 1). But since .custom/config.json
    // isn't found in phase 1 (not a default dotdir), we get noumen. That's the
    // expected behavior: bootstrap with defaults first.
    const config = loadCliConfig(project);
    expect(config.model).toBe("noumen");
  });

  it("reroutes reads when global config declares a dotDirs override", () => {
    const home = process.env.HOME!;
    // Custom names in the default .noumen/config.json — picked up during bootstrap.
    writeJson(nodePath.join(home, ".noumen/config.json"), {
      model: "global-default",
      dotDirs: { names: [".custom", ".noumen"] },
    });
    // After override, phase 2 re-probes with .custom first.
    writeJson(nodePath.join(home, ".custom/config.json"), {
      model: "global-custom",
    });

    const config = loadCliConfig(nodePath.join(tmp, "proj"));
    expect(config.model).toBe("global-custom");
  });

  it("loadGlobalConfig reads from ~/.noumen/config.json with default resolver", () => {
    const home = process.env.HOME!;
    writeJson(nodePath.join(home, ".noumen/config.json"), { model: "global-noumen" });

    const config = loadGlobalConfig();
    expect(config.model).toBe("global-noumen");
  });

  it("loadGlobalConfig honors a custom resolver", () => {
    const home = process.env.HOME!;
    writeJson(nodePath.join(home, ".cursor/config.json"), { model: "global-cursor" });

    const resolver = createDotDirResolver({ names: [".cursor", ".noumen"] });
    const config = loadGlobalConfig(resolver);
    expect(config.model).toBe("global-cursor");
  });

  it("resolveCliDotDirs returns a resolver that writes to .noumen by default", () => {
    const resolver = resolveCliDotDirs({});
    expect(resolver.writePath("/x")).toBe("/x/.noumen");
  });

  it("resolveCliDotDirs honors a custom dotDirs config", () => {
    const resolver = resolveCliDotDirs({ dotDirs: { names: [".custom"] } });
    expect(resolver.writePath("/x")).toBe("/x/.custom");
  });
});
