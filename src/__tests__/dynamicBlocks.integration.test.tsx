import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GraphvizBlock from "../plugins/GraphvizBlock";
import HtmlPreviewBlock from "../plugins/HtmlPreviewBlock";
import LiveSvgBlock from "../plugins/LiveSvgBlock";
import MermaidBlock from "../plugins/MermaidBlock";
import PlantUMLBlock from "../plugins/PlantUMLBlock";

let fetchMock: ReturnType<typeof vi.fn>;

// Graphviz lays out in a Worker (F4); jsdom has none, so a stand-in answers
// the worker protocol { id, dot, engine } → { id, svg }.
class FakeGraphvizWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    postMessage(m: { id: number }) {
      setTimeout(() => this.onmessage?.({ data: { id: m.id, svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' } }), 0);
    }
    terminate() {}
}

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => ({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${source}</text></svg>`,
      bindFunctions: vi.fn(),
    })),
  },
}));

describe("dynamic block integration smoke", () => {
  beforeEach(() => {
    // kroki.io is a third-party service: allowed under the cloud policy only (#352, plan 6.17).
    localStorage.setItem("lumen.ai.policy", "cloud");
    fetchMock = vi.fn(async () =>
      new Response("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>plantuml</text></svg>"),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Mock IntersectionObserver for MermaidBlock
    vi.stubGlobal("IntersectionObserver", class MockIO {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      constructor(cb: IntersectionObserverCallback) {
        const entry = { isIntersecting: true, target: document.createElement("div") } as unknown as IntersectionObserverEntry;
        setTimeout(() => cb([entry], this as unknown as IntersectionObserver), 0);
      }
    });
  });

  afterEach(() => {
    localStorage.removeItem("lumen.ai.policy");
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sanitizes HTML preview source", () => {
    render(<HtmlPreviewBlock source="<div>safe</div><script>alert(1)</script>" />);
    expect(
      screen.getByText(/Some HTML content was sanitized before preview for safety\./i),
    ).toBeTruthy();
  });

  it("renders PlantUML block with sanitizer-safe success state", async () => {
    render(<PlantUMLBlock source="Alice -> Bob" />);
    await waitFor(() => {
      expect(screen.getByText(/PlantUML/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(/Rendered/i)).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://kroki.io/plantuml/svg",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows PlantUML failure path on non-200 responses", async () => {
    // PlantUMLBlock uses fetchWithRetry (maxRetries: 2, baseDelayMs:
    // 500). Make ALL attempts fail so the block surfaces the error
    // instead of a retry succeeding against the default beforeEach
    // mock. The retry chain takes ~1.5s so waitFor needs a longer
    // timeout than the default 1s.
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    render(<PlantUMLBlock source="bad source" />);
    await waitFor(
      () => {
        expect(
          screen.getByText(/PlantUML error \(rendered via kroki.io\)/),
        ).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  it("retries on transient failures and recovers — fail-fail-succeed", async () => {
    // Pins retry-then-success behavior: the first two calls 500,
    // the third returns a valid SVG. The block must end in
    // "Rendered" state and fetch must have been called 3×.
    fetchMock
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValue(
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>retried</text></svg>'),
      );
    render(<PlantUMLBlock source="retry me" />);
    await waitFor(
      () => {
        expect(screen.getByText(/Rendered in/)).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("renders Graphviz block with mocked wasm backend", async () => {
    vi.stubGlobal("Worker", FakeGraphvizWorker);
    render(<GraphvizBlock source="digraph { A -> B }" />);
    await waitFor(() => {
      expect(screen.getByText(/Graphviz · dot/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(/Rendered/i)).toBeTruthy();
    });
  });

  it("renders Mermaid block through mocked renderer", async () => {
    render(<MermaidBlock source="graph TD; A --> B" />);
    await waitFor(() => {
      expect(screen.getByText(/Mermaid/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(/Rendered in/)).toBeTruthy();
    });
  });

  it("renders LiveSvg block in safe mode", () => {
    render(<LiveSvgBlock source={`<circle cx="50" cy="50" r="10" fill="red" />`} />);
    expect(screen.getAllByText(/SVG/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Rendered/i)).toBeTruthy();
  });
});
