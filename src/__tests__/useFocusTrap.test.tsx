/**
 * The one focus trap every modal dialog uses (plan 10.1.1): focus in on open,
 * Tab / Shift+Tab cycle, focus brought back from the page behind, Escape on
 * the top dialog only, focus returned on close.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { focusableIn, useFocusTrap } from "../ui/useFocusTrap";

afterEach(() => cleanup());

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));

function Dialog({ onEscape, children, testId = "dlg" }: { onEscape?: () => void; children?: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape });
  return (
    <div ref={ref} role="dialog" aria-modal="true" data-testid={testId}>
      {children ?? (
        <>
          <button>one</button>
          <input aria-label="two" />
          <button disabled>off</button>
          <button style={{ display: "none" }}>hidden</button>
          <button>three</button>
        </>
      )}
    </div>
  );
}

function Host({ initiallyOpen = true, onEscape }: { initiallyOpen?: boolean; onEscape?: () => void }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      <button>behind</button>
      {open && (
        <Dialog
          onEscape={() => {
            onEscape?.();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey });
const active = () => (document.activeElement as HTMLElement | null)?.textContent || (document.activeElement as HTMLElement | null)?.getAttribute("aria-label");

describe("useFocusTrap", () => {
  it("focuses the first focusable element; skips disabled and hidden ones", async () => {
    const { getByTestId } = render(<Dialog />);
    await tick();
    expect(active()).toBe("one");
    expect(focusableIn(getByTestId("dlg")).map((e) => e.textContent || e.getAttribute("aria-label"))).toEqual(["one", "two", "three"]);
  });

  it("an [autofocus] / [data-autofocus] element wins; focus the dialog moved itself is kept", async () => {
    render(
      <Dialog>
        <button>a</button>
        <button data-autofocus>b</button>
      </Dialog>,
    );
    await tick();
    expect(active()).toBe("b");
    cleanup();
    function Self() {
      const ref = useRef<HTMLDivElement>(null);
      const input = useRef<HTMLInputElement | null>(null);
      useFocusTrap(ref);
      return (
        <div ref={ref}>
          <button>first</button>
          <input aria-label="search" ref={(el) => { input.current = el; el?.focus(); }} />
        </div>
      );
    }
    render(<Self />);
    await tick();
    expect(active()).toBe("search");
  });

  it("Tab wraps from the last to the first, Shift+Tab from the first to the last", async () => {
    render(<Dialog />);
    await tick();
    tab(true);
    expect(active()).toBe("three");
    tab();
    expect(active()).toBe("one");
  });

  it("focus that lands behind the dialog comes back into it", async () => {
    const { getByText } = render(<Host />);
    await tick();
    act(() => getByText("behind").focus());
    expect(active()).toBe("one");
  });

  it("a dialog with nothing focusable holds focus on itself", async () => {
    const { getByTestId } = render(
      <Dialog>
        <p>just text</p>
      </Dialog>,
    );
    await tick();
    expect(document.activeElement).toBe(getByTestId("dlg"));
    tab();
    expect(document.activeElement).toBe(getByTestId("dlg"));
  });

  it("Escape closes it and focus returns to what had it before", async () => {
    const onEscape = vi.fn();
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          {open && <Dialog onEscape={() => { onEscape(); setOpen(false); }} />}
        </>
      );
    }
    const { getByText, queryByTestId } = render(<Toggle />);
    act(() => getByText("opener").focus());
    fireEvent.click(getByText("opener"));
    await tick();
    expect(active()).toBe("one");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(queryByTestId("dlg")).toBeNull();
    await tick();
    expect(active()).toBe("opener");
  });

  it("a dialog that focuses its own field before the trap starts still gives focus back to its opener (W4.2)", async () => {
    // The settings screen focuses its search box in an effect that runs before
    // the trap's: the trap must not take that box for "what had focus before".
    function SelfFocusing({ onClose }: { onClose: () => void }) {
      const ref = useRef<HTMLDivElement>(null);
      const field = useRef<HTMLInputElement>(null);
      useEffect(() => field.current?.focus(), []);
      useFocusTrap(ref, { onEscape: onClose });
      return (
        <div ref={ref} role="dialog" aria-modal="true" data-testid="self">
          <input ref={field} aria-label="search" />
          <button>close</button>
        </div>
      );
    }
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          {open && <SelfFocusing onClose={() => setOpen(false)} />}
        </>
      );
    }
    const { getByText, queryByTestId } = render(<Toggle />);
    act(() => getByText("opener").focus());
    fireEvent.click(getByText("opener"));
    await tick();
    expect(active()).toBe("search");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(queryByTestId("self")).toBeNull();
    await tick();
    expect(active()).toBe("opener");
  });

  it("Escape that a widget inside already handled (preventDefault) is left alone", async () => {
    const onEscape = vi.fn();
    render(
      <Dialog onEscape={onEscape}>
        <input aria-label="field" onKeyDown={(e) => e.key === "Escape" && e.preventDefault()} />
      </Dialog>,
    );
    await tick();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("stacked dialogs: only the top one traps and takes Escape", async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Dialog onEscape={outer} testId="outer">
          <button>outer-btn</button>
        </Dialog>
        <Dialog onEscape={inner} testId="inner">
          <button>inner-a</button>
          <button>inner-b</button>
        </Dialog>
      </>,
    );
    await tick();
    expect(active()).toBe("inner-a");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    tab(true);
    expect(active()).toBe("inner-b");
  });

  it("inactive: no trap, no Escape", async () => {
    const onEscape = vi.fn();
    function Closed() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, { active: false, onEscape });
      return (
        <div ref={ref}>
          <button>x</button>
        </div>
      );
    }
    render(<Closed />);
    await tick();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onEscape).not.toHaveBeenCalled();
  });
});
