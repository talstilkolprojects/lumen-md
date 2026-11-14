/**
 * Plan W1.30 — the screen of allowed image hosts, and revoking "Always allow".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  __resetRemoteImagesForTests,
  allowRemoteImageHosts,
  allowedRemoteImageHosts,
  forgetAllRemoteImageHosts,
  forgetRemoteImageHost,
  loadRemoteImagesOnce,
  remoteImageAllowed,
  ALLOWED_HOSTS_KEY,
} from "../lib/remoteImages";
import { ImageHostsList, ImageHostsPanel } from "../ui/ImageHostsPanel";

beforeEach(() => {
  localStorage.clear();
  __resetRemoteImagesForTests();
});

describe("revoking", () => {
  it("revoking a host blocks its images again, also ones loaded once this session", () => {
    allowRemoteImageHosts(["cdn.example.com", "img.example.org"]);
    loadRemoteImagesOnce(["https://cdn.example.com/once.png", "https://other.example.net/x.png"]);
    expect(remoteImageAllowed("https://cdn.example.com/a.png")).toBe(true);
    forgetRemoteImageHost("CDN.example.com");
    expect(remoteImageAllowed("https://cdn.example.com/a.png")).toBe(false);
    expect(remoteImageAllowed("https://cdn.example.com/once.png")).toBe(false);
    // Other hosts keep their state.
    expect(remoteImageAllowed("https://img.example.org/b.png")).toBe(true);
    expect(remoteImageAllowed("https://other.example.net/x.png")).toBe(true);
    expect(JSON.parse(localStorage.getItem(ALLOWED_HOSTS_KEY)!)).toEqual(["img.example.org"]);
  });

  it("revoke all clears every host and this session's one-off loads", () => {
    allowRemoteImageHosts(["a.example.com", "b.example.com"]);
    loadRemoteImagesOnce(["https://c.example.com/x.png"]);
    forgetAllRemoteImageHosts();
    expect(allowedRemoteImageHosts()).toEqual([]);
    expect(remoteImageAllowed("https://a.example.com/x.png")).toBe(false);
    expect(remoteImageAllowed("https://c.example.com/x.png")).toBe(false);
    expect(JSON.parse(localStorage.getItem(ALLOWED_HOSTS_KEY)!)).toEqual([]);
  });
});

describe("the screen", () => {
  it("lists the allowed hosts, revokes one, then all", () => {
    allowRemoteImageHosts(["b.example.com", "a.example.com"]);
    render(<ImageHostsList />);
    expect(screen.getByTestId("image-hosts").textContent).toContain("a.example.com");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent?.replace(/Revoke$/, ""))).toEqual(["a.example.com", "b.example.com"]);
    fireEvent.click(screen.getByRole("button", { name: "Stop always allowing a.example.com" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Revoke all" }));
    expect(screen.getByTestId("image-hosts-empty")).toBeTruthy();
  });

  it("follows a host allowed elsewhere while open", () => {
    render(<ImageHostsList />);
    expect(screen.getByTestId("image-hosts-empty")).toBeTruthy();
    act(() => allowRemoteImageHosts(["new.example.com"]));
    expect(screen.getByTestId("image-hosts").textContent).toContain("new.example.com");
  });

  it("the dialog closes on Escape", () => {
    let closed = false;
    render(<ImageHostsPanel open onClose={() => (closed = true)} />);
    expect(screen.getByRole("dialog", { name: "Allowed image hosts" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(true);
  });
});
