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

  it("retries when the global skills directory appears after an earlier miss", async () => {
    const configDirectory = path.join(testDirectory, "config");
    const skillFile = path.join(configDirectory, "skills", "late-skill", "SKILL.md");
    const temporaryDirectory = path.join(testDirectory, "temporary");
    await fs.mkdir(temporaryDirectory);
    const bridge = new GlobalSkillsPluginBridge(configDirectory, logger, {
      temporaryDirectory,
    });

    await expect(bridge.initialize()).resolves.toBeUndefined();

    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, "# Late skill\n", "utf8");
    const plugin = await bridge.initialize();

    expect(plugin).toMatchObject({ type: "local", skipMcpDiscovery: true });
    await expect(
      fs.readFile(path.join(plugin!.path, "skills", "late-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Late skill\n");
    await bridge.dispose();
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
    await expect(
      fs.realpath(path.join(plugin!.path, "skills", "example-skill", "SKILL.md")),
    ).resolves.not.toBe(await fs.realpath(skillFile));

    await bridge.dispose();
    await expect(fs.stat(plugin!.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Example skill\n");
  });

  it("uses a startup snapshot instead of sharing source files", async () => {
    const configDirectory = path.join(testDirectory, "config");
    const skillFile = path.join(configDirectory, "skills", "fallback-skill", "SKILL.md");
    const temporaryDirectory = path.join(testDirectory, "temporary");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.mkdir(temporaryDirectory);
    await fs.writeFile(skillFile, "# Fallback skill\n", "utf8");

    const bridge = new GlobalSkillsPluginBridge(configDirectory, logger, {
      temporaryDirectory,
    });
    const plugin = await bridge.initialize();

    expect(plugin).toMatchObject({ type: "local", skipMcpDiscovery: true });
    await expect(
      fs.readFile(path.join(plugin!.path, "skills", "fallback-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Fallback skill\n");

    await fs.writeFile(skillFile, "# Updated source skill\n", "utf8");
    await expect(
      fs.readFile(path.join(plugin!.path, "skills", "fallback-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Fallback skill\n");

    await bridge.dispose();
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Updated source skill\n");
  });

  it("dereferences a symlinked global skills directory", async () => {
    const configDirectory = path.join(testDirectory, "config");
    const sourceDirectory = path.join(testDirectory, "shared-skills");
    const skillFile = path.join(sourceDirectory, "linked-skill", "SKILL.md");
    const temporaryDirectory = path.join(testDirectory, "temporary");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.mkdir(configDirectory);
    await fs.mkdir(temporaryDirectory);
    await fs.writeFile(skillFile, "# Linked skill\n", "utf8");
    await fs.symlink(sourceDirectory, path.join(configDirectory, "skills"), "dir");

    const bridge = new GlobalSkillsPluginBridge(configDirectory, logger, {
      temporaryDirectory,
    });
    const plugin = await bridge.initialize();
    const pluginSkillFile = path.join(plugin!.path, "skills", "linked-skill", "SKILL.md");

    await expect(fs.readFile(pluginSkillFile, "utf8")).resolves.toBe("# Linked skill\n");
    await expect(fs.realpath(pluginSkillFile)).resolves.not.toBe(await fs.realpath(skillFile));

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
