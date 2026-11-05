import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarList } from "./SidebarList";

const list = (count: number, resetKey = 0) => (
  <SidebarList resetKey={resetKey}>
    {Array.from({ length: count }, (_, index) => (
      <a href={`#task-${index}`} key={index}>
        Task {index}
      </a>
    ))}
  </SidebarList>
);

describe("SidebarList", () => {
  it("keeps new rows behind the button after the last partial page was revealed", () => {
    const view = render(list(7));
    expect(screen.getAllByRole("link")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Показать ещё 2" }));
    expect(screen.getAllByRole("link")).toHaveLength(7);

    view.rerender(list(27));
    expect(screen.getAllByRole("link")).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Показать ещё 5" }));
    expect(screen.getAllByRole("link")).toHaveLength(12);

    view.rerender(list(27, 1));
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });

  it("adds the disclosure only once a list grows past five rows", () => {
    const view = render(list(5));
    expect(screen.queryByRole("button")).toBeNull();

    view.rerender(list(6));
    expect(screen.getAllByRole("link")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Показать ещё 1" }));
    expect(screen.getAllByRole("link")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Показать меньше" }));
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });
});
