/**
 * SearchDialog result-count badge + the plural-aware `tPlural` helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const searchWorkspace = vi.fn();
vi.mock("../storage/workspaceIndex", () => ({
  searchWorkspace: (...a: unknown[]) => searchWorkspace(...a),
}));
vi.mock("../storage/workspace", () => ({
  isOPFSAvailable: () => true,
  readWorkspaceFile: vi.fn(async () => ""),
}));
vi.mock("../ai/semanticSearch", () => ({
  indexWorkspace: vi.fn(),
  searchHybrid: vi.fn(async () => []),
}));
vi.mock("../ai/embeddings", () => ({ semanticSearch: vi.fn(async () => []) }));

import { SearchDialog } from "../ui/SearchDialog";
import { applyLocale, tPlural, loadLocale } from "../i18n";

const hit = (i: number) => ({ path: `f${i}.md`, name: `f${i}.md`, score: 1, snippet: null });

beforeEach(() => {
  applyLocale("en");
  searchWorkspace.mockReset();
});
afterEach(() => {
  cleanup();
  applyLocale("en");
});

describe("tPlural", () => {
  it("selects .one / .other by Intl.PluralRules", () => {
    expect(tPlural("search.results", 1)).toBe("1 result");
    expect(tPlural("search.results", 0)).toBe("0 results");
    expect(tPlural("search.results", 7)).toBe("7 results");
  });

  it("works in Hebrew", async () => {
    await loadLocale("he");
    applyLocale("he");
    expect(tPlural("search.results", 1)).toBe("1 תוצאה");
    expect(tPlural("search.results", 5)).toBe("5 תוצאות");
  });

  it("falls back to .other for categories a locale bundle lacks (ru few/many)", async () => {
    await loadLocale("ru");
    applyLocale("ru");
    expect(tPlural("search.results", 1)).toBe("1 результат");
    expect(tPlural("search.results", 3)).toBe("Результатов: 3");
  });
});

describe("SearchDialog: what a /regex/ could not check (2.39)", () => {
  it("says how many long notes a /regex/ skipped, that a runaway one was stopped, and nothing otherwise", async () => {
    type Opts = { onRegexInfo?: (i: { regexSkipped: number; regexMaxChars?: number; regexTimedOut?: true }) => void };
    searchWorkspace.mockImplementation(async (q: string, o: Opts) => {
      if (q === "/skip/") o.onRegexInfo?.({ regexSkipped: 2, regexMaxChars: 500000 });
      else if (q === "/(a+)+$/") o.onRegexInfo?.({ regexSkipped: 0, regexTimedOut: true });
      else o.onRegexInfo?.({ regexSkipped: 0 });
      return [hit(1)];
    });
    render(<SearchDialog open onClose={() => {}} onOpenFile={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/skip/" } });
    await waitFor(() => expect(screen.getByTestId("search-regex-note").textContent).toBe("/regex/ skipped 2 very long notes (over 500,000 characters)."));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/(a+)+$/" } });
    await waitFor(() => expect(screen.getByTestId("search-regex-note").textContent).toContain("took too long and was stopped"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "plain" } });
    await waitFor(() => expect(screen.queryByTestId("search-regex-note")).toBeNull());
  });
});

describe("SearchDialog result-count badge", () => {
  it("is hidden for an empty query and shows a pluralised count after searching", async () => {
    searchWorkspace.mockResolvedValue([]);
    render(<SearchDialog open onClose={() => {}} onOpenFile={() => {}} />);
    await waitFor(() => expect(searchWorkspace).toHaveBeenCalled());
    expect(screen.queryByTestId("search-result-count")).toBeNull();

    searchWorkspace.mockResolvedValue([hit(1), hit(2), hit(3)]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "notes" } });
    await waitFor(() =>
      expect(screen.getByTestId("search-result-count").textContent).toBe("3 results"),
    );

    searchWorkspace.mockResolvedValue([hit(1)]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "notes2" } });
    await waitFor(() =>
      expect(screen.getByTestId("search-result-count").textContent).toBe("1 result"),
    );

    searchWorkspace.mockResolvedValue([]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzz" } });
    await waitFor(() =>
      expect(screen.getByTestId("search-result-count").textContent).toBe("0 results"),
    );
  });
});
