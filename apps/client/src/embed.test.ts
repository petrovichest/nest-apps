import { afterEach, beforeEach, describe, expect, it } from "vitest";

import widgetSource from "../public/embed.js?raw";

type Embed = {
  open(options: { src: string; title?: string; theme?: string }): void;
  close(): void;
  isOpen(): boolean;
};

function load(): Embed {
  delete (window as unknown as { CodexNestEmbed?: Embed }).CodexNestEmbed;
  new Function(widgetSource)();
  return (window as unknown as { CodexNestEmbed: Embed }).CodexNestEmbed;
}

function shadow() {
  return document.querySelector("[data-codexnest-embed]")!.shadowRoot!;
}

function pointer(target: Element, type: string, x: number, y: number) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
}

function box() {
  const style = (shadow().querySelector(".window") as HTMLElement).style;
  return [style.left, style.top, style.width, style.height].map((value) => parseFloat(value));
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  Object.assign(window, { innerWidth: 1600, innerHeight: 1000 });
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("floating embed window", () => {
  it("opens the application in a framed window with a title", () => {
    const embed = load();
    embed.open({ src: "https://nest.example/", title: "Agent" });
    const frame = shadow().querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://nest.example/");
    expect(shadow().querySelector(".title")!.textContent).toBe("Agent");
    expect(embed.isOpen()).toBe(true);
    expect(box()).toEqual([576, 120, 1000, 760]);
  });

  it("moves by the title bar and resizes from an edge, keeping the placement", () => {
    load().open({ src: "https://nest.example/" });
    const bar = shadow().querySelector(".bar")!;
    pointer(bar, "pointerdown", 700, 130);
    pointer(bar, "pointermove", 600, 100);
    pointer(bar, "pointerup", 600, 100);
    expect(box()).toEqual([476, 90, 1000, 760]);

    const corner = shadow().querySelector(".edge.se")!;
    pointer(corner, "pointerdown", 1476, 850);
    pointer(corner, "pointermove", 1276, 750);
    pointer(corner, "pointerup", 1276, 750);
    expect(box()).toEqual([476, 90, 800, 660]);
    expect(JSON.parse(localStorage.getItem("codexnest.embed.window")!)).toMatchObject({
      x: 476,
      y: 90,
      width: 800,
      height: 660,
      maximized: false,
    });

    document.body.innerHTML = "";
    load().open({ src: "https://nest.example/" });
    expect(box()).toEqual([476, 90, 800, 660]);
  });

  it("enforces a minimum size and keeps the window on screen", () => {
    load().open({ src: "https://nest.example/" });
    const corner = shadow().querySelector(".edge.nw")!;
    pointer(corner, "pointerdown", 576, 120);
    pointer(corner, "pointermove", 1500, 900);
    pointer(corner, "pointerup", 1500, 900);
    const [, , width, height] = box();
    expect(width).toBe(360);
    expect(height).toBe(320);

    const bar = shadow().querySelector(".bar")!;
    pointer(bar, "pointerdown", 1300, 800);
    pointer(bar, "pointermove", 5000, 5000);
    pointer(bar, "pointerup", 5000, 5000);
    expect(box()).toEqual([1232, 672, 360, 320]);
  });

  it("maximizes, minimizes to a bubble and closes without unloading the frame", () => {
    const embed = load();
    embed.open({ src: "https://nest.example/" });
    (shadow().querySelector('[data-action="maximize"]') as HTMLElement).click();
    expect(box()).toEqual([0, 0, 1600, 1000]);
    (shadow().querySelector('[data-action="minimize"]') as HTMLElement).click();
    const bubble = shadow().querySelector(".bubble") as HTMLElement;
    expect(embed.isOpen()).toBe(false);
    expect(bubble.hidden).toBe(false);
    bubble.click();
    expect(embed.isOpen()).toBe(true);
    (shadow().querySelector('[data-action="close"]') as HTMLElement).click();
    expect(embed.isOpen()).toBe(false);
    expect(bubble.hidden).toBe(true);
    expect(shadow().querySelector("iframe")!.getAttribute("src")).toBe("https://nest.example/");
  });

  it("fills a narrow screen", () => {
    Object.assign(window, { innerWidth: 390, innerHeight: 800 });
    load().open({ src: "https://nest.example/" });
    expect(box()).toEqual([0, 0, 390, 800]);
    expect(shadow().querySelector(".window")!.classList.contains("narrow")).toBe(true);
  });

  it("escapes the title", () => {
    load().open({ src: "https://nest.example/", title: "<img src=x onerror=alert(1)>" });
    expect(shadow().querySelector(".title img")).toBeNull();
  });
});
