/**
 * Formulas and the map view in the database block (plan 4.11): formula
 * columns are computed per note, read-only, usable in the filter; the
 * formula box checks a formula as you type and can ask the formula agent;
 * the map view loads Leaflet only when picked and puts a marker per note
 * with coordinates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { applyFormulas, compileFormulas, parseLatLng, rowLatLng, runDatabaseQuery, specView, type DatabaseRow } from "../views/database";
import { mapPoints } from "../views/DatabaseMapView";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

const agentCalls: unknown[] = [];
vi.mock("../agents/runtime", () => ({
  runAgentOrThrow: async (def: { id: string }, input: unknown) => {
    agentCalls.push({ id: def.id, input });
    return "price * qty";
  },
}));

const markers: Array<{ at: [number, number]; title?: string }> = [];
let leafletLoads = 0;
vi.mock("../plugins/map/leaflet", () => {
  const layer = (): Record<string, unknown> => ({ addTo: () => layer(), bindPopup: () => layer() });
  const L = {
    map: () => ({ setView: () => ({}), fitBounds: () => ({}), remove: () => {} }),
    tileLayer: () => layer(),
    marker: (at: [number, number], opts?: { title?: string }) => {
      markers.push({ at, title: opts?.title });
      return layer();
    },
    latLngBounds: (pts: unknown) => pts,
  };
  return {
    getLeaflet: async () => {
      leafletLoads++;
      return L;
    },
  };
});

import DatabaseBlock from "../views/DatabaseBlock";

const note = (fm: string) => `---\ntype: item\n${fm}---\n\nBody.\n`;

beforeEach(async () => {
  installFakeOpfs();
  markers.length = 0;
  agentCalls.length = 0;
  leafletLoads = 0;
  await writeWorkspaceFile("shop/Apple.md", note("price: 2\nqty: 5\nlocation: \"32.08, 34.78\"\n"));
  await writeWorkspaceFile("shop/Bread.md", note("price: 7.5\nqty: 2\nlat: 31.77\nlng: 35.21\n"));
  await writeWorkspaceFile("shop/Cheese.md", note("price: x\nqty: 1\n"));
});
afterEach(() => cleanup());

const SPEC = "source: shop\ntype: item\nformulas:\n  total: price * qty\n  big: total >= 10\n";
const titles = () => screen.getAllByRole("link").map((a) => a.textContent);

describe("formulas — engine glue", () => {
  const rows: DatabaseRow[] = [
    { path: "a.md", basename: "a", fm: { price: 2, qty: 3 } },
    { path: "b.md", basename: "b", fm: { price: "x", qty: 3 } },
  ];

  it("compiles the spec's formulas once; a bad one keeps its message", () => {
    const fs = compileFormulas({ total: "price * qty", broken: "price *", n: 3, skip: { a: 1 } });
    expect(fs.map((f) => [f.name, f.tree !== null])).toEqual([["total", true], ["broken", false], ["n", true]]);
    expect(fs[1].error?.at).toBe(7);
    expect(compileFormulas(["x"])).toEqual([]);
    // YAML `blank: null` is the null literal, a column like any other.
    const nul = compileFormulas({ blank: null });
    expect(nul.map((f) => [f.name, f.source, f.tree?.kind])).toEqual([["blank", "null", "null"]]);
    expect(compileFormulas(undefined)).toEqual([]);
    // An unquoted `[a, b]` is a YAML list: a broken entry that says to quote it, not a silent skip.
    const list = compileFormulas({ pair: ["price", "qty"] });
    expect(list.map((f) => [f.name, f.tree])).toEqual([["pair", null]]);
    expect(list[0].error?.message).toMatch(/quotes/);
    // An unquoted 1e309 is Infinity after YAML: a broken entry, not a field named "Infinity".
    const inf = compileFormulas({ value: Infinity });
    expect(inf.map((f) => [f.name, f.tree])).toEqual([["value", null]]);
    expect(inf[0].error?.message).toMatch(/too large/);
  });

  it("adds formula columns per row, in order, with errors per cell", () => {
    const { rows: out, errors } = applyFormulas(rows, compileFormulas({ total: "price * qty", double: "total * 2" }));
    expect(out.map((r) => [r.fm.total, r.fm.double])).toEqual([[6, 12], [null, null]]);
    expect(errors.get("b.md")?.get("total")).toMatch(/needs a number/);
    // The loaded rows are not touched.
    expect(rows[0].fm).toEqual({ price: 2, qty: 3 });
  });

  it("a column named __proto__ is an ordinary column", () => {
    const { rows: out } = applyFormulas(rows, compileFormulas(JSON.parse('{"__proto__": "[price]", "next": "len(prop(\\"__proto__\\"))"}')));
    expect(Object.getPrototypeOf(out[0].fm)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out[0].fm, "__proto__")).toBe(true);
    expect(out[0].fm.next).toBe(1);
  });

  it("runDatabaseQuery filters and sorts on formula columns", async () => {
    const out = await runDatabaseQuery({ source: "shop", type: "item", formulas: { total: "price * qty" }, where: "total > 0", sort: "-total" });
    expect(out.map((r) => [r.basename, r.fm.total])).toEqual([["Bread", 15], ["Apple", 10]]);
  });
});

describe("map — coordinates", () => {
  it("parses the usual shapes and rejects the rest", () => {
    expect(parseLatLng("32.08, 34.78")).toEqual({ lat: 32.08, lng: 34.78 });
    expect(parseLatLng("-33.9 18.4")).toEqual({ lat: -33.9, lng: 18.4 });
    expect(parseLatLng([51.5, "-0.12"])).toEqual({ lat: 51.5, lng: -0.12 });
    expect(parseLatLng({ latitude: 1, longitude: 2 })).toEqual({ lat: 1, lng: 2 });
    expect(parseLatLng({ lat: 1, lon: 2 })).toEqual({ lat: 1, lng: 2 });
    for (const bad of ["Tel Aviv", "91, 0", "0, 181", [1], null, 5, new Date(0), { lat: "x", lng: 1 }, [null, null], ["", ""], [true, false], { lat: "", lng: " " }, { lat: true, lng: 1 }]) expect(parseLatLng(bad)).toBeNull();
  });

  it("a row's point: the spec's column, else location, else lat + lng", () => {
    const r = (fm: Record<string, unknown>): DatabaseRow => ({ path: "x.md", basename: "x", fm });
    expect(rowLatLng(r({ place: "1, 2", location: "3, 4" }), { location: "place" })).toEqual({ lat: 1, lng: 2 });
    expect(rowLatLng(r({ location: "3, 4" }), {})).toEqual({ lat: 3, lng: 4 });
    expect(rowLatLng(r({ lat: 5, lng: 6 }), {})).toEqual({ lat: 5, lng: 6 });
    expect(rowLatLng(r({ lat: 5 }), {})).toBeNull();
    // A place name in `location` falls back to `coordinates`, then to lat + lng.
    expect(rowLatLng(r({ location: "Tel Aviv", coordinates: "32.08, 34.78" }), {})).toEqual({ lat: 32.08, lng: 34.78 });
    expect(rowLatLng(r({ location: "Tel Aviv", lat: 1, lng: 2 }), {})).toEqual({ lat: 1, lng: 2 });
    expect(rowLatLng(r({ lat: "", latitude: 3, lng: 4 }), {})).toEqual({ lat: 3, lng: 4 });
    expect(mapPoints([r({ location: "1, 1" }), r({})], {})).toHaveLength(1);
    expect(specView({ view: "map" })).toBe("map");
  });
});

describe("DatabaseBlock — formulas", () => {
  it("shows formula columns, read-only, with an error cell for a note they can't compute", async () => {
    render(<DatabaseBlock source={SPEC} />);
    await waitFor(() => expect(titles()).toEqual(["Apple", "Bread", "Cheese"]));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Title", "price", "qty", "location", "lat", "lng", "total", "big"]);
    const cells = screen.getAllByTestId("database-formula-cell").map((c) => c.textContent);
    // Cheese: no total, and an empty value is never >= 10.
    expect(cells).toEqual(["10", "true", "15", "true", "false"]);
    // Cheese's price is not a number: its total is an error (with the message for screen readers), not a crash.
    const errs = screen.getAllByTestId("database-formula-error");
    expect(errs[0].textContent).toContain("needs a number");
    // Formula cells are not editable buttons.
    expect(screen.queryByRole("button", { name: "Edit total of Apple" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit price of Apple" })).toBeTruthy();
  });

  it("the filter can use a formula column", async () => {
    render(<DatabaseBlock source={SPEC} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    const filter = screen.getByTestId("database-filter");
    fireEvent.change(filter, { target: { value: "total > 12" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    await waitFor(() => expect(titles()).toEqual(["Bread"]));
  });

  it("a formula in the spec that does not parse says where", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\nformulas:\n  bad: price * (qty\n"} />);
    expect((await screen.findByTestId("database-formula-spec-error")).textContent).toContain("Formula bad:");
  });

  it("the formula box checks as you type, then adds the column", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\n"} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    fireEvent.click(screen.getByTestId("database-formula-open"));
    fireEvent.change(screen.getByTestId("database-formula-name"), { target: { value: "sum" } });
    const input = screen.getByTestId("database-formula-input");
    fireEvent.change(input, { target: { value: "price +" } });
    expect((await screen.findByRole("alert")).textContent).toContain("Formula:");
    expect((screen.getByTestId("database-formula-add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "price + qty" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByTestId("database-formula-add"));
    // `+` joins when a side is plain text ("x" + 1 → "x1").
    await waitFor(() => expect(screen.getAllByTestId("database-formula-cell").map((c) => c.textContent)).toEqual(["7", "9.5", "x1"]));
    // How to keep it: the spec line to add.
    // Quoted YAML scalars, so a formula with ": " or " #" survives the copy (review #267).
    expect(screen.getByText(/formulas:/).textContent).toContain('"sum": "price + qty"');
  });

  it("with fields: in the spec, an added formula column still shows", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\nfields: [price]\n"} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    fireEvent.click(screen.getByTestId("database-formula-open"));
    fireEvent.change(screen.getByTestId("database-formula-name"), { target: { value: "double" } });
    fireEvent.change(screen.getByTestId("database-formula-input"), { target: { value: "qty * 2" } });
    fireEvent.click(screen.getByTestId("database-formula-add"));
    await waitFor(() => expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Title", "price", "double"]));
    expect(screen.getAllByTestId("database-formula-cell").map((c) => c.textContent)).toEqual(["10", "4", "2"]);
  });

  it("with fields: in the spec, the spec's formulas: columns show after them, once", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\nfields: [price, total]\nformulas:\n  total: price * qty\n  half: price / 2\n"} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Title", "price", "total", "half"]);
  });

  it("“Write with AI” runs the formulator agent with the database's properties", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\n"} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    fireEvent.click(screen.getByTestId("database-formula-open"));
    const input = screen.getByTestId("database-formula-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "מחיר כפול כמות" } });
    fireEvent.click(screen.getByTestId("database-formula-ai"));
    await waitFor(() => expect(input.value).toBe("price * qty"));
    expect(agentCalls).toHaveLength(1);
    const call = agentCalls[0] as { id: string; input: { text: string; extra: { fields: Array<{ name: string; example?: string }> } } };
    expect(call.id).toBe("formulator");
    expect(call.input.text).toBe("מחיר כפול כמות");
    expect(call.input.extra.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["price", "qty", "type"]));
    expect(call.input.extra.fields.find((f) => f.name === "price")?.example).toBe("2");
  });

  it("a formulas: value that isn't a map adds no columns (review #267)", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\nfields: [price]\nformulas: price * qty\n"} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Title", "price"]);
    expect(screen.queryAllByTestId("database-formula-cell")).toHaveLength(0);
  });

  it("“Write with AI” also offers the formula columns already defined (review #267)", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\nformulas:\n  total: price * qty\n"} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    fireEvent.click(screen.getByTestId("database-formula-open"));
    fireEvent.change(screen.getByTestId("database-formula-input"), { target: { value: "סך הכל מעל 10" } });
    fireEvent.click(screen.getByTestId("database-formula-ai"));
    await waitFor(() => expect(agentCalls).toHaveLength(1));
    const call = agentCalls[0] as { input: { extra: { fields: Array<{ name: string; example?: string }> } } };
    expect(call.input.extra.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["price", "qty", "total"]));
  });

  it("editing a property recomputes its formulas and writes only the property", async () => {
    render(<DatabaseBlock source={SPEC} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Edit qty of Apple" }));
    const input = screen.getByRole("textbox", { name: "Edit qty of Apple" });
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByTestId("database-formula-cell")[0].textContent).toBe("12"));
    await waitFor(async () => expect(await readWorkspaceFile("shop/Apple.md")).toBe(note('price: 2\nqty: 6\nlocation: "32.08, 34.78"\n')));
  });
});

describe("DatabaseBlock — map view", () => {
  it("loads Leaflet only when the map is picked, with a marker per note that has coordinates", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\n"} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    expect(leafletLoads).toBe(0);
    fireEvent.click(screen.getByTestId("database-view-map"));
    const region = await screen.findByTestId("database-map");
    expect(region.getAttribute("aria-label")).toBe("Map of 2 notes");
    await waitFor(() => expect(markers.slice(-2).map((m) => [m.title, m.at])).toEqual([["Apple", [32.08, 34.78]], ["Bread", [31.77, 35.21]]]));
    expect(leafletLoads).toBeGreaterThan(0);
    expect(within(region.parentElement!).getByText("1 notes without coordinates are not shown.")).toBeTruthy();
  });

  it("says what to add when no note has coordinates", async () => {
    render(<DatabaseBlock source={"source: shop\ntype: item\nview: map\nlocation: place\n"} />);
    expect((await screen.findByTestId("database-map-empty")).textContent).toContain("place");
    expect(leafletLoads).toBe(0);
  });
});
