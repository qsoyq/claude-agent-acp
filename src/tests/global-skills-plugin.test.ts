import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GlobalSkillsPluginBridge } from "../global-skills-plugin.js";

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
});
