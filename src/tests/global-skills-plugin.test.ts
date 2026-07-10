import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { GlobalSkillsPluginBridge, mergeGlobalSkillsPlugin } from "../global-skills-plugin.js";

describe("GlobalSkillsPluginBridge", () => {
  let testDirectory: string;
  const logger = { error: vi.fn() };

  beforeEach(async () => {
    testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "global-skills-plugin-test-"));
    logger.error.mockReset();
  });

  afterEach(async () => {
    await fs.rm(testDirectory, { recursive: true, force: true });
  });

  it("does not create a plugin when the global skills directory is absent", async () => {
    const temporaryDirectory = path.join(testDirectory, "temporary");
    await fs.mkdir(temporaryDirectory);
    const bridge = new GlobalSkillsPluginBridge(path.join(testDirectory, "config"), logger, {
      temporaryDirectory,
    });

    await expect(bridge.initialize()).resolves.toBeUndefined();
    expect(await fs.readdir(temporaryDirectory)).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("creates a valid local plugin that exposes the global skills directory", async () => {
    const configDirectory = path.join(testDirectory, "custom-config");
    const skillsDirectory = path.join(configDirectory, "skills");
    const skillFile = path.join(skillsDirectory, "example-skill", "SKILL.md");
    const temporaryDirectory = path.join(testDirectory, "temporary");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.mkdir(temporaryDirectory);
    await fs.writeFile(skillFile, "# Example skill\n", "utf8");

    const bridge = new GlobalSkillsPluginBridge(configDirectory, logger, {
      temporaryDirectory,
    });
    const plugin = await bridge.initialize();

    expect(plugin).toMatchObject({ type: "local", skipMcpDiscovery: true });
    expect(plugin?.path).toContain(temporaryDirectory);
    const manifest = JSON.parse(
      await fs.readFile(path.join(plugin!.path, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("claude-agent-acp-global-skills");
    await expect(
      fs.readFile(path.join(plugin!.path, "skills", "example-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Example skill\n");

    await bridge.dispose();
    await expect(fs.stat(plugin!.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Example skill\n");
  });

  it("falls back to a copied snapshot when directory linking fails", async () => {
    const configDirectory = path.join(testDirectory, "config");
    const skillFile = path.join(configDirectory, "skills", "fallback-skill", "SKILL.md");
    const temporaryDirectory = path.join(testDirectory, "temporary");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.mkdir(temporaryDirectory);
    await fs.writeFile(skillFile, "# Fallback skill\n", "utf8");

    const bridge = new GlobalSkillsPluginBridge(configDirectory, logger, {
      temporaryDirectory,
      linkDirectory: async (_target, linkPath) => {
        await fs.mkdir(linkPath);
        throw new Error("links unavailable");
      },
    });
    const plugin = await bridge.initialize();

    expect(plugin).toMatchObject({ type: "local", skipMcpDiscovery: true });
    await expect(
      fs.readFile(path.join(plugin!.path, "skills", "fallback-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Fallback skill\n");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("using a startup snapshot"));

    await bridge.dispose();
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Fallback skill\n");
  });

  it("requests a junction on Windows", async () => {
    const configDirectory = path.join(testDirectory, "config");
    const skillsDirectory = path.join(configDirectory, "skills");
    const temporaryDirectory = path.join(testDirectory, "temporary");
    await fs.mkdir(skillsDirectory, { recursive: true });
    await fs.mkdir(temporaryDirectory);
    const linkDirectory = vi.fn(async (target: string, linkPath: string) => {
      await fs.cp(target, linkPath, { recursive: true });
    });
    const bridge = new GlobalSkillsPluginBridge(configDirectory, logger, {
      temporaryDirectory,
      platform: "win32",
      linkDirectory,
    });

    await bridge.initialize();

    expect(linkDirectory).toHaveBeenCalledWith(
      path.resolve(skillsDirectory),
      expect.any(String),
      "junction",
    );
    await bridge.dispose();
  });
});

describe("mergeGlobalSkillsPlugin", () => {
  it("preserves caller plugins and keeps the internal bridge exactly once", () => {
    const bridge: SdkPluginConfig = {
      type: "local",
      path: "/temporary/global-skills-plugin",
      skipMcpDiscovery: true,
    };
    const callerPlugin: SdkPluginConfig = {
      type: "local",
      path: "/caller/plugin",
    };

    expect(mergeGlobalSkillsPlugin([callerPlugin, bridge, bridge], bridge)).toEqual([
      callerPlugin,
      bridge,
    ]);
  });
});
