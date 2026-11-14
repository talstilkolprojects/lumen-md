import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { tRich } from "../i18n/rich";

describe("tRich", () => {
  it("puts React nodes where the sentence has placeholders", () => {
    const { container } = render(<p>{tRich("block.database.kanbanNeeds", { field: <code>groupBy:</code> })}</p>);
    expect(container.textContent).toBe("Kanban needs a groupBy: column. Add one to the database spec.");
    expect(container.querySelector("code")?.textContent).toBe("groupBy:");
  });

  it("takes plain values too and keeps unknown placeholders as written", () => {
    const { container } = render(
      <p>{tRich("block.insights.freqSummary", { field: <b>tags</b>, total: 12 })}</p>,
    );
    expect(container.textContent).toBe("Field tags · 12 occurrences · {distinct} distinct");
  });
});
