/**
 * Plan W5.21: the classroom panel clicked through on one device that is both
 * teacher and student — make an assignment from the open note, join from its
 * link, hand in, read the submission, comment, and get the comment back into
 * the note — against an in-memory relay with the drop box rules of
 * sync-server/vault-relay.js (the real relay runs in classroom.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClassroomPanel } from "../sync/e2ee/classroom/ClassroomPanel";
import { dropIdOf } from "../sync/e2ee/classroom/classroom";
import { parseClassHash } from "../sync/e2ee/classroom/link";
import { listAssignments, removeAssignment } from "../sync/e2ee/classroom/store";
import { useAppStore } from "../store/useStore";

const RELAY = "https://relay.example";

/** Drop boxes in memory: `a.<d>` may list, read and create; `o.<o>` owns d = HMAC(o). */
function memoryDropRelay() {
  const boxes = new Map<string, Map<string, Uint8Array>>();
  const bodies: string[] = [];
  const fetch = async (input: Request | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const h = new Headers(init.headers);
    const m = /^Bearer ([ao])\.(\S+)$/.exec(h.get("Authorization") ?? "");
    if (!m) return new Response("", { status: 401 });
    const append = m[1] === "a";
    const id = append ? (m[2] as string) : await dropIdOf(m[2] as string);
    const box = boxes.get(id) ?? new Map<string, Uint8Array>();
    boxes.set(id, box);
    const name = decodeURIComponent(url.pathname.replace("/v1/vault/o/", ""));
    const method = init.method ?? "GET";
    if (!name) return new Response(JSON.stringify({ names: [...box.keys()] }), { status: 200 });
    const now = box.get(name);
    if (method === "GET") return now ? new Response(now as BodyInit, { status: 200, headers: { ETag: `"${now.length}"` } }) : new Response("", { status: 404 });
    if (method === "DELETE") return append ? new Response("", { status: 403 }) : (box.delete(name), new Response(null, { status: 204 }));
    if (append && h.get("If-None-Match") !== "*") return new Response("", { status: 403 });
    if (h.get("If-None-Match") === "*" && now) return new Response("", { status: 412 });
    const data = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    bodies.push(new TextDecoder().decode(data));
    box.set(name, data);
    return new Response(null, { status: 201, headers: { ETag: `"${data.length}"` } });
  };
  return { fetch, bodies };
}

afterEach(async () => {
  cleanup();
  for (const a of await listAssignments()) await removeAssignment(a);
});

describe("ClassroomPanel", () => {
  it("assignment → link → join → hand in → comment → the comment lands in the student's note", async () => {
    const relay = memoryDropRelay();
    const deps = { fetch: relay.fetch };
    useAppStore.getState().openTab({ name: "חיבור.md", content: "# חיבור\n\nכתבו כאן." });

    // Teacher: a new assignment from the open note.
    const first = render(<ClassroomPanel onClose={() => undefined} relay={RELAY} deps={deps} />);
    expect((screen.getByTestId("class-title") as HTMLInputElement).value).toBe("חיבור");
    fireEvent.click(screen.getByTestId("class-create"));
    const linkField = (await screen.findByTestId("class-link")) as HTMLInputElement;
    await waitFor(() => expect(linkField.value).toMatch(/#class=[A-Za-z0-9_-]+$/));
    const link = await parseClassHash(new URL(linkField.value).hash);
    expect(link).toMatchObject({ title: "חיבור", template: "# חיבור\n\nכתבו כאן.", relay: RELAY });
    first.unmount();

    // Student (the same device here): join, get a copy in a new tab; nothing is sent.
    render(<ClassroomPanel onClose={() => undefined} relay={RELAY} deps={deps} joining={link} />);
    expect((screen.getByTestId("class-join-go") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("class-name"), { target: { value: "נועה" } });
    fireEvent.click(screen.getByTestId("class-join-go"));
    await screen.findByTestId("class-student-assignment");
    expect(useAppStore.getState().doc).toMatchObject({ name: "חיבור.md", content: "# חיבור\n\nכתבו כאן." });
    expect(relay.bodies).toHaveLength(0);

    // The student writes and hands in.
    useAppStore.getState().setContent("# חיבור\n\nהתשובה של נועה");
    fireEvent.click(screen.getByTestId("class-hand-in"));
    await waitFor(() => expect(screen.getByTestId("class-student-assignment").textContent).toMatch(/version 1/));
    expect(relay.bodies.join("")).not.toContain("נועה");

    // The teacher checks, reads and comments.
    fireEvent.click(screen.getByTestId("class-check"));
    const subs = await screen.findByTestId("class-submissions");
    expect(subs.textContent).toContain("נועה");
    fireEvent.change(subs.querySelector("textarea")!, { target: { value: "מצוין, הרחיבי בפסקה השנייה" } });
    fireEvent.click(screen.getByText("Send comment (sealed)"));
    await screen.findByText(/only this student can open it/);
    expect(relay.bodies.join("")).not.toContain("מצוין");

    // The student gets the comment back into the open note, once.
    fireEvent.click(screen.getByTestId("class-get-comments"));
    await screen.findByText("1 new comments added to the open note");
    const note = useAppStore.getState().doc.content;
    expect(note).toContain("התשובה של נועה");
    expect(note).toContain("> [!note] Teacher's comment");
    expect(note).toContain("> מצוין, הרחיבי בפסקה השנייה");
    fireEvent.click(screen.getByTestId("class-get-comments"));
    await screen.findByText("0 new comments added to the open note");
    expect(useAppStore.getState().doc.content).toBe(note);
  });

  it("refuses a link for another relay, and says when the build has no relay", async () => {
    const link = { title: "x", template: "y", teacherKey: "B".repeat(87), relay: "https://elsewhere.example", drop: "d".repeat(43) };
    render(<ClassroomPanel onClose={() => undefined} relay={RELAY} joining={link} />);
    expect(screen.getByRole("alert").textContent).toContain("https://elsewhere.example");
    expect(screen.queryByTestId("class-join-go")).toBeNull();
    cleanup();
    render(<ClassroomPanel onClose={() => undefined} relay={null} />);
    expect(screen.queryByTestId("class-create")).toBeNull();
    expect(screen.getByTestId("classroom").textContent).toContain("VITE_SYNC_RELAY_URL");
  });
});
