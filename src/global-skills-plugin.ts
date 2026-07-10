import type { Options, SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const INTERNAL_PLUGIN_NAME = "claude-agent-acp-global-skills";
const TEMPORARY_DIRECTORY_PREFIX = "claude-agent-acp-global-skills-";

type BridgeLogger = {
  error: (...args: unknown[]) => void;
};

export type GlobalSkillsPluginBridgeOptions = {
  linkDirectory?: (target: string, linkPath: string, type: "dir" | "junction") => Promise<void>;
  platform?: typeof process.platform;
  temporaryDirectory?: string;
};

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mergeGlobalSkillsPlugin(
  userPlugins: Options["plugins"],
  bridgePlugin: SdkPluginConfig | undefined,
): Options["plugins"] {
  if (!bridgePlugin) {
    return userPlugins;
  }

  const merged: SdkPluginConfig[] = [];
  let bridgeAdded = false;
  for (const plugin of userPlugins ?? []) {
    if (plugin.type === "local" && plugin.path === bridgePlugin.path) {
      if (!bridgeAdded) {
        merged.push(bridgePlugin);
        bridgeAdded = true;
      }
      continue;
    }
    merged.push(plugin);
  }
  if (!bridgeAdded) {
    merged.push(bridgePlugin);
  }
  return merged;
}

export class GlobalSkillsPluginBridge {
  private readonly skillsDirectory: string;
  private readonly linkDirectory: NonNullable<GlobalSkillsPluginBridgeOptions["linkDirectory"]>;
  private readonly platform: typeof process.platform;
  private readonly temporaryDirectory: string;
  private pluginPromise?: Promise<SdkPluginConfig | undefined>;
  private disposed = false;

  constructor(
    claudeConfigDirectory: string,
    private readonly logger: BridgeLogger,
    options: GlobalSkillsPluginBridgeOptions = {},
  ) {
    this.skillsDirectory = path.resolve(claudeConfigDirectory, "skills");
    this.linkDirectory = options.linkDirectory ?? fs.symlink;
    this.platform = options.platform ?? process.platform;
    this.temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
  }

  initialize(): Promise<SdkPluginConfig | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined);
    }
    this.pluginPromise ??= this.createPlugin().catch((error) => {
      this.logger.error(
        `Failed to create the global skills bridge for ${this.skillsDirectory}: ${describeError(error)}`,
      );
      return undefined;
    });
    return this.pluginPromise;
  }

  private async createPlugin(): Promise<SdkPluginConfig | undefined> {
    let skillsStats;
    try {
      skillsStats = await fs.stat(this.skillsDirectory);
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }

    if (!skillsStats.isDirectory()) {
      this.logger.error(
        `Global skills path is not a directory; skipping bridge: ${this.skillsDirectory}`,
      );
      return undefined;
    }

    const pluginDirectory = await fs.mkdtemp(
      path.join(this.temporaryDirectory, TEMPORARY_DIRECTORY_PREFIX),
    );
    try {
      const manifestDirectory = path.join(pluginDirectory, ".claude-plugin");
      await fs.mkdir(manifestDirectory);
      await fs.writeFile(
        path.join(manifestDirectory, "plugin.json"),
        `${JSON.stringify(
          {
            name: INTERNAL_PLUGIN_NAME,
            version: "1.0.0",
            description: "Internal bridge for Claude Code global skills",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const pluginSkillsDirectory = path.join(pluginDirectory, "skills");
      try {
        await this.linkDirectory(
          this.skillsDirectory,
          pluginSkillsDirectory,
          this.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        this.logger.error(
          `Failed to link global skills into the temporary plugin; using a startup snapshot instead: ${describeError(error)}`,
        );
        await fs.rm(pluginSkillsDirectory, { recursive: true, force: true });
        await fs.cp(this.skillsDirectory, pluginSkillsDirectory, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }

      return {
        type: "local",
        path: pluginDirectory,
        skipMcpDiscovery: true,
      };
    } catch (error) {
      await fs.rm(pluginDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const plugin = await this.pluginPromise;
    if (!plugin) {
      return;
    }
    try {
      await fs.rm(plugin.path, { recursive: true, force: true });
    } catch (error) {
      this.logger.error(
        `Failed to remove the global skills bridge at ${plugin.path}: ${describeError(error)}`,
      );
    }
  }
}
