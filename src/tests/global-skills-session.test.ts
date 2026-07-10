import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionNotification } from "@agentclientprotocol/sdk";
import type { Options, SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

const capturedOptions: Options[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: ({ options }: { options: Options }) => {
    capturedOptions.push(options);
    return {
      initializationResult: async () => ({
        models: [
          {
            value: "claude-sonnet-4-6",
            displayName: "Claude Sonnet",
            description: "Fast",
          },
        ],
      }),
      setModel: async () => {},
      setPermissionMode: async () => {},
      supportedCommands: async () => [],
      close: () => {},
      interrupt: async () => ({ still_queued: [] }),
      [Symbol.asyncIterator]: async function* () {},
    };
  },
}));

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

describe("global skills session plugin", () => {
  let agent: ClaudeAcpAgentType;
  let testDirectory: string;
  let configDirectory: string;
  let originalClaudeConfigDirectory: string | undefined;

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  beforeEach(async () => {
    capturedOptions.length = 0;
    testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "global-skills-session-test-"));
    configDirectory = path.join(testDirectory, "custom-claude-config");
    await fs.mkdir(configDirectory);
    originalClaudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDirectory;

    vi.resetModules();
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    agent = new ClaudeAcpAgent(createMockClient());
  });

  afterEach(async () => {
    await agent.dispose();
    if (originalClaudeConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDirectory;
    }
    await fs.rm(testDirectory, { recursive: true, force: true });
  });

  it("leaves caller plugins unchanged when the global skills directory is absent", async () => {
    const callerPlugin: SdkPluginConfig = { type: "local", path: "/caller/plugin" };

    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { claudeCode: { options: { plugins: [callerPlugin] } } },
    });

    expect(capturedOptions[0].plugins).toEqual([callerPlugin]);
  });

  it("loads global skills created after ACP initialization but before session creation", async () => {
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const skillFile = path.join(configDirectory, "skills", "late-session-skill", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, "# Late session skill\n", "utf8");

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    const bridge = capturedOptions[0].plugins?.[0];
    expect(bridge).toMatchObject({ type: "local", skipMcpDiscovery: true });
    await expect(
      fs.readFile(path.join(bridge!.path, "skills", "late-session-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Late session skill\n");
  });

  it("appends one bridge to caller plugins and reuses it across sessions", async () => {
    const skillFile = path.join(configDirectory, "skills", "example-skill", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, "# Example skill\n", "utf8");
    const callerPlugin: SdkPluginConfig = { type: "local", path: "/caller/plugin" };

    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { claudeCode: { options: { plugins: [callerPlugin] } } },
    });
    const bridge = capturedOptions[0].plugins?.at(-1);
    expect(capturedOptions[0].plugins?.[0]).toEqual(callerPlugin);
    expect(bridge).toMatchObject({ type: "local", skipMcpDiscovery: true });

    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { claudeCode: { options: { plugins: [callerPlugin, bridge!, bridge!] } } },
    });

    expect(capturedOptions[1].plugins).toEqual([callerPlugin, bridge]);
    expect(
      capturedOptions[1].plugins?.filter((plugin) => plugin.path === bridge?.path),
    ).toHaveLength(1);
  });

  it("removes the shared bridge on disposal without touching source skills", async () => {
    const skillFile = path.join(configDirectory, "skills", "cleanup-skill", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, "# Cleanup skill\n", "utf8");
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const bridgePath = capturedOptions[0].plugins?.[0].path;

    await agent.dispose();

    await expect(fs.stat(bridgePath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Cleanup skill\n");
  });
});

describe("CLAUDE_CONFIG_DIR resolution", () => {
  it("defaults to the home .claude directory", async () => {
    const originalClaudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    vi.resetModules();
    try {
      const { CLAUDE_CONFIG_DIR } = await import("../acp-agent.js");
      expect(CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), ".claude"));
    } finally {
      if (originalClaudeConfigDirectory === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDirectory;
      }
    }
  });
});
