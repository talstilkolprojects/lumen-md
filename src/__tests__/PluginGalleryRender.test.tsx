import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("../i18n", () => ({ t: (k: string) => k }));
vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../plugins/pluginSystem", () => ({
  getRegisteredPlugins: vi.fn().mockReturnValue([]),
  registerPlugin: vi.fn().mockResolvedValue(undefined),
  unregisterPlugin: vi.fn(),
}));

describe("PluginGallery", () => {
  it("renders without crashing when open", async () => {
    const { PluginGallery } = await import("../ui/PluginGallery");
    const { container } = render(
      <PluginGallery open={true} onClose={vi.fn()} />,
    );
    expect(container).toBeDefined();
  });

  it("renders null when not open", async () => {
    const { PluginGallery } = await import("../ui/PluginGallery");
    const { container } = render(
      <PluginGallery open={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("has a close button when open", async () => {
    const { PluginGallery } = await import("../ui/PluginGallery");
    const { container } = render(
      <PluginGallery open={true} onClose={vi.fn()} />,
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("has search input when open", async () => {
    const { PluginGallery } = await import("../ui/PluginGallery");
    const { container } = render(
      <PluginGallery open={true} onClose={vi.fn()} />,
    );
    const input = container.querySelector("input[type='text']");
    expect(input).not.toBeNull();
  });

  it("has role=dialog when open", async () => {
    const { PluginGallery } = await import("../ui/PluginGallery");
    const { container } = render(
      <PluginGallery open={true} onClose={vi.fn()} />,
    );
    const dialog = container.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
  });

  it("shows community plugins in the grid", async () => {
    const { PluginGallery } = await import("../ui/PluginGallery");
    const { container } = render(
      <PluginGallery open={true} onClose={vi.fn()} />,
    );
    // Should have some text about plugins
    expect(container.textContent).toContain("pluginGallery.title");
  });
});

describe("PluginGallery — hooks are stable across open/closed", () => {
  it("can be mounted closed and opened later (App mounts it with open=false)", async () => {
    const { PluginGallery } = await import("../ui/PluginGallery");
    const { rerender, container } = render(<PluginGallery open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    // Before the fix this threw "Rendered more hooks than during the
    // previous render": a useMemo lived below the `if (!open) return null`.
    expect(() => rerender(<PluginGallery open={true} onClose={vi.fn()} />)).not.toThrow();
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    expect(container.querySelectorAll("[data-testid='plugin-card']").length).toBeGreaterThan(0);
    expect(() => rerender(<PluginGallery open={false} onClose={vi.fn()} />)).not.toThrow();
    expect(container.firstChild).toBeNull();
  });
});
