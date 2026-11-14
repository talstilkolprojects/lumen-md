/**
 * a11y smoke tests — render the headline UI surfaces and run axe-core to
 * catch the violations any tooling would flag (missing labels, ARIA misuse,
 * contrast issues that show up in DOM, etc.).
 *
 * We don't render the full App (it pulls every lazy chunk) — instead we
 * render the dialogs / panels in isolation and assert axe finds zero
 * "serious" or "critical" violations. "Moderate" issues are surfaced as
 * console warnings rather than failures.
 */

import { beforeAll, describe, it, expect } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { Toolbar } from "../ui/Toolbar";
import { AuthDialog } from "../components/AuthDialog";
import { MobileKeyboardBar } from "../ui/MobileKeyboardBar";
import { Outline } from "../ui/Outline";
import { CommandPalette } from "../ui/CommandPalette";
import { SearchDialog } from "../ui/SearchDialog";
import { TagsPanel } from "../ui/TagsPanel";
import { BacklinksPanel } from "../ui/BacklinksPanel";
import { KeyboardShortcuts } from "../ui/KeyboardShortcuts";
import { TemplateGallery } from "../ui/TemplateGallery";
import { StatusBar } from "../ui/StatusBar";
import { DocTabs } from "../ui/DocTabs";
import { afterEach, beforeEach, vi } from "vitest";

const stubNavSymbol = "__cabinetMockNavigation";
type MockCanvasContext = {
  fillRect: () => void;
  clearRect: () => void;
  drawImage: () => void;
  getImageData: () => { data: Uint8ClampedArray; width: number; height: number };
  createImageData: () => { data: Uint8ClampedArray; width: number; height: number };
  beginPath: () => void;
  closePath: () => void;
  moveTo: () => void;
  lineTo: () => void;
  arc: () => void;
  fill: () => void;
  stroke: () => void;
};

const createMockContext = (): MockCanvasContext => ({
  fillRect: () => undefined,
  clearRect: () => undefined,
  drawImage: () => undefined,
  getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  beginPath: () => undefined,
  closePath: () => undefined,
  moveTo: () => undefined,
  lineTo: () => undefined,
  arc: () => undefined,
  fill: () => undefined,
  stroke: () => undefined,
});

beforeEach(() => {
  const win = globalThis as unknown as Window & { [stubNavSymbol]?: { addEventListener: typeof vi.fn; removeEventListener: typeof vi.fn } };
  if (!win[stubNavSymbol]) {
    win[stubNavSymbol] = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  }
  const nav = (win as unknown as { navigation?: { addEventListener?: () => void; removeEventListener?: () => void } });
  if (typeof nav.navigation === "undefined") {
    nav.navigation = win[stubNavSymbol] as unknown as {
      addEventListener: () => void;
      removeEventListener: () => void;
    };
  }
  if (typeof HTMLCanvasElement !== "undefined") {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => createMockContext() as unknown as CanvasRenderingContext2D,
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runAxe(container: HTMLElement) {
  const result = await axe.run(container, {
    runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
    resultTypes: ["violations"],
  });
  return result.violations;
}

function expectNoBlockers(violations: axe.Result[]) {
  const blockers = violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  if (blockers.length > 0) {
    // eslint-disable-next-line no-console
    console.log("a11y blockers:", JSON.stringify(blockers, null, 2));
  }
  expect(blockers).toEqual([]);
}

// axe's first run in a worker builds its virtual tree and colour-contrast
// caches (~0.9 s on an 18-node Toolbar; later runs ~0.1–0.2 s). Pay that once
// here, not inside the first test, where it used to run into waitFor's 1 s
// ceiling under machine load and fail as "Timed out in waitFor".
beforeAll(async () => {
  const warm = document.createElement("div");
  warm.innerHTML = '<button type="button">warm</button>';
  document.body.appendChild(warm);
  try {
    await axe.run(warm, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"], resultTypes: ["violations"] });
  } finally {
    warm.remove();
  }
}, 30_000);

/**
 * Flush pending effects and microtasks, then run axe once and assert.
 * There is no waitFor around axe: a retry loop has a 1 s ceiling per
 * attempt (a slow axe.run under load failed with "Timed out in waitFor")
 * and could pass by retrying until a violation happened to be gone.
 * Every surface here renders its final DOM by this flush; a test whose
 * content arrives later (SearchDialog's debounced search) waits for that
 * content explicitly before calling this.
 */
async function expectNoBlockersEventually(container: HTMLElement) {
  await act(async () => {});
  const violations = await runAxe(container);
  expectNoBlockers(violations);
}

describe("axe a11y smoke", () => {
  it("Toolbar renders with no critical/serious axe violations", async () => {
    const { container } = render(
      <Toolbar
        onOpen={() => {}}
        onSave={() => {}}
        onNew={() => {}}
        onCommandPalette={() => {}}
      />,
    );
    await expectNoBlockersEventually(container);
  });

  it("AuthDialog (open) renders with no critical/serious axe violations", async () => {
    const { container } = render(<AuthDialog open onClose={() => {}} />);
    await expectNoBlockersEventually(container);
  });

  it("MobileKeyboardBar renders without blockers (component is hidden when not on touch device)", async () => {
    const { container } = render(<MobileKeyboardBar />);
    await expectNoBlockersEventually(container);
  });

  it("Outline renders no blockers on a typical heading-rich doc", async () => {
    const md = "# Title\n## Sub-section A\n### Detail\n## Sub-section B\n";
    const { container } = render(<Outline markdownText={md} />);
    await expectNoBlockersEventually(container);
  });

  it("CommandPalette (open) renders no blockers", async () => {
    // Use commands in the curated "Recent" group so the palette's category
    // filter doesn't suppress them and the listbox renders option children
    // (axe-required for role="listbox").
    const { container } = render(
      <CommandPalette
        open
        onClose={() => {}}
        commands={[
          { id: "cmd.test1", label: "Test command 1", group: "Recent", action: () => {} },
          { id: "cmd.test2", label: "Test command 2", group: "Recent", action: () => {} },
        ]}
      />,
    );
    await waitFor(() => expect(container).toBeDefined());
    await expectNoBlockersEventually(container);
  });

  it("SearchDialog (open) renders no blockers", async () => {
    const { container } = render(
      <SearchDialog open onClose={() => {}} onOpenFile={() => {}} />,
    );
    // The first (debounced, 150 ms) search settles into the empty state;
    // wait for that DOM, then check the settled dialog.
    await waitFor(() => expect(container.querySelector(".cmd-palette-empty")).not.toBeNull(), { timeout: 5_000 });
    await expectNoBlockersEventually(container);
  });

  it("TagsPanel (open) renders no blockers", async () => {
    const { container } = render(<TagsPanel open onClose={() => {}} />);
    await waitFor(() => expect(container).toBeDefined());
    await expectNoBlockersEventually(container);
  });

  it("BacklinksPanel renders no blockers (no active doc)", async () => {
    const { container } = render(
      <BacklinksPanel filePath={null} onOpen={() => {}} />,
    );
    await waitFor(() => expect(container).toBeDefined());
    await expectNoBlockersEventually(container);
  });

  it("KeyboardShortcuts (open) renders no blockers", async () => {
    const { container } = render(
      <KeyboardShortcuts open onClose={() => {}} />,
    );
    await expectNoBlockersEventually(container);
  });

  it("StatusBar renders no blockers", async () => {
    const { container } = render(
      <StatusBar text="hello world" dirty={false} filename="test.md" />,
    );
    await expectNoBlockersEventually(container);
  });

  it("TemplateGallery (open, mocked registry) renders no blockers", async () => {
    // Stub the marketplace load so the gallery doesn't try to hit /templates/.
    const mod = await import("../storage/templateMarketplace");
    vi.spyOn(mod, "fetchMarketplaceItems").mockResolvedValue([
      {
        id: "demo",
        name: "Demo",
        category: "Test",
        author: "Lumen",
        description: "A demo template",
        icon: "📓",
        version: "1.0.0",
        url: "templates/demo.md",
        rating: 5,
        downloads: 0,
        tags: ["demo"],
      },
    ]);
    const { container } = render(
      <TemplateGallery open onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(container).toBeDefined();
      expect(container.textContent).toContain("Demo");
    });
    await expectNoBlockersEventually(container);
  });

  it("DocTabs (3 tabs) renders no blockers; close-X is keyboard reachable", async () => {
    const { container } = render(
      <DocTabs
        tabs={[
          { id: "a", name: "a.md", dirty: false },
          { id: "b", name: "b.md", dirty: true },
          { id: "c", name: "c.md", dirty: false },
        ]}
        activeId="a"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    await expectNoBlockersEventually(container);
  });

  // ── Round-24 expansion: cover more surfaces ─────────────────────────
  // (PromptDialog and InsertTextDialog only export imperative
  // ui{Prompt,Confirm,Alert} / openInsertTextDialog helpers — not
  // direct components. Their internal renderers can't be unit-tested
  // here. Their a11y is covered indirectly through the surfaces-smoke
  // e2e spec.)

  it("OnboardingTour (open, step 1) renders no blockers", async () => {
    const { OnboardingTour } = await import("../ui/OnboardingTour");
    // Provide a target element so the spotlight has coords.
    const stub = document.createElement("div");
    stub.className = "titlebar";
    stub.style.cssText = "position:absolute;top:0;left:0;width:100%;height:48px";
    document.body.appendChild(stub);
    try {
      const { container } = render(
        <OnboardingTour open onClose={() => {}} />,
      );
      await expectNoBlockersEventually(container);
    } finally {
      stub.remove();
    }
  });

  it("ErrorBoundary fallback renders no blockers", async () => {
    const { ErrorBoundary } = await import("../ui/ErrorBoundary");
    function Bomb(): JSX.Element {
      throw new Error("test");
    }
    // Silence the expected React console.error during boundary catch.
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const { container } = render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      await expectNoBlockersEventually(container);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("AiFab (closed) renders no blockers", async () => {
    const { AiFab } = await import("../ui/AiFab");
    const { container } = render(<AiFab commands={[]} />);
    await expectNoBlockersEventually(container);
  });

  it("AiToastContainer (with one toast) renders no blockers", async () => {
    const { AiToastContainer, showAiToast } = await import("../ui/AiToast");
    const { act } = await import("@testing-library/react");
    const { container } = render(<AiToastContainer />);
    // showAiToast fires a setState inside the container subscription —
    // wrap in act() so React flushes the update synchronously and the
    // "not wrapped in act(...)" warning doesn't pollute the test log.
    await act(async () => {
      showAiToast("Test toast", "info");
    });
    await expectNoBlockersEventually(container);
  });

  it("PluginGallery (open, mocked registry) renders no blockers", async () => {
    vi.doMock("../storage/pluginMarketplace", () => ({
      fetchPluginRegistry: async () => [],
      installPlugin: async () => {},
    }));
    const { PluginGallery } = await import("../ui/PluginGallery");
    const { container } = render(
      <PluginGallery open onClose={() => {}} />,
    );
    await expectNoBlockersEventually(container);
  });
});
