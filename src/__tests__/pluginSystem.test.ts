/**
 * Unit tests for the plugin system.
 *
 * Run with: npx vitest run
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPlugin,
  unregisterPlugin,
  getPluginCommands,
  getRegisteredPlugins,
  type LumenPlugin,
} from "../plugins/pluginSystem";

describe("Plugin System", () => {
  const testPlugin: LumenPlugin = {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    description: "A test plugin",
    activate: (api) => {
      api.registerCommand({
        id: "test.hello",
        label: "Hello",
        action: () => {},
      });
    },
    deactivate: () => {},
  };

  beforeEach(() => {
    // Unregister if already registered from a previous test
    try { unregisterPlugin("test-plugin"); } catch { /* why: the plugin is not registered on the first run */ }
  });

  it("registers a plugin", async () => {
    await registerPlugin(testPlugin);
    const list = getRegisteredPlugins();
    expect(list.some((p) => p.id === "test-plugin")).toBe(true);
  });

  it("marks plugin as active after registration", async () => {
    await registerPlugin(testPlugin);
    const list = getRegisteredPlugins();
    const entry = list.find((p) => p.id === "test-plugin");
    expect(entry?.active).toBe(true);
  });

  it("adds plugin commands to the palette", async () => {
    await registerPlugin(testPlugin);
    const cmds = getPluginCommands();
    expect(cmds.some((c) => c.id === "test.hello")).toBe(true);
  });

  it("unregisters a plugin", async () => {
    await registerPlugin(testPlugin);
    unregisterPlugin("test-plugin");
    const list = getRegisteredPlugins();
    expect(list.some((p) => p.id === "test-plugin")).toBe(false);
  });

  it("removes commands after unregistration", async () => {
    await registerPlugin(testPlugin);
    unregisterPlugin("test-plugin");
    const cmds = getPluginCommands();
    expect(cmds.some((c) => c.id === "test.hello")).toBe(false);
  });

  it("does not duplicate plugins on re-register", async () => {
    await registerPlugin(testPlugin);
    await registerPlugin(testPlugin); // second call should be ignored
    const list = getRegisteredPlugins();
    const count = list.filter((p) => p.id === "test-plugin").length;
    expect(count).toBe(1);
  });
});
