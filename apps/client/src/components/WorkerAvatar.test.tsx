import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkerAvatar } from "./WorkerAvatar";

function portrait(id: string, projectKey?: string) {
  const template = document.createElement("template");
  template.innerHTML = renderToStaticMarkup(<WorkerAvatar id={id} projectKey={projectKey} />);
  return template.content.querySelector("svg")!;
}

it("distinguishes eyes at 44px for two UUIDs with the same shell, visor and project panel", () => {
  const first = portrait("6ae21e3d-30c0-4029-a33f-15ee03055b83", "project-a");
  const second = portrait("b5d9192c-7773-4158-afe9-9d17adf081c2", "project-a");

  expect(first.getAttribute("width")).toBe("44");
  expect(first.children[2]?.outerHTML).toBe(second.children[2]?.outerHTML);
  expect(first.children[4]?.outerHTML).toBe(second.children[4]?.outerHTML);
  expect(first.querySelector("rect")?.outerHTML).toBe(second.querySelector("rect")?.outerHTML);
  expect(first.querySelector("g path")!.getAttribute("d")).not.toBe(
    second.querySelector("g path")!.getAttribute("d"),
  );
});

it("keeps the portrait unique when two UUIDs select the same parts and palette", () => {
  function layers(id: string) {
    const drawing = [...portrait(id).children].map((layer) => layer.outerHTML);
    const panel = drawing.findIndex((layer) => layer.startsWith("<rect"));
    return { parts: drawing.slice(0, panel + 1), serial: drawing.slice(panel + 1) };
  }

  const first = layers("843d721f-ae11-4d09-b3e3-b61d08fc0004");
  const second = layers("843d721f-ae11-4d09-b3e3-b61d08fc00d2");
  expect(first.parts).toEqual(second.parts);
  expect(first.serial).not.toEqual(second.serial);
});

it.each([
  ["project-b", "path:nth-child(1)", "d"],
  ["canonical-mineral", "path:nth-child(2)", "d"],
  ["project-a", "rect", "fill"],
])(
  "shares the selected detail for %s while keeping portraits distinct",
  (projectKey, selector, attribute) => {
    const first = portrait("843d721f-ae11-4d09-b3e3-b61d08fcc616", projectKey);
    const second = portrait("843d721f-ae11-4d09-b3e3-b61d08fcc617", projectKey);
    const detail = first.querySelector(selector)!.getAttribute(attribute);
    expect(detail).toBeTruthy();
    expect(second.querySelector(selector)!.getAttribute(attribute)).toBe(detail);
    expect(first.innerHTML).not.toEqual(second.innerHTML);
  },
);
