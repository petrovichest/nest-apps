import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActionLabel } from "./ActionLabel";

describe("ActionLabel", () => {
  it("keeps both labels in layout and glints only the busy one while pending", () => {
    const view = render(<ActionLabel idle="Сохранить" busy="Сохраняем…" pending={false} />);
    expect(screen.getByText("Сохранить")).not.toHaveClass("action-label-hidden");
    expect(screen.getByText("Сохраняем…")).toHaveClass("action-label-hidden");
    expect(view.container.querySelector(".working-text")).toBeNull();

    view.rerender(<ActionLabel idle="Сохранить" busy="Сохраняем…" pending />);
    expect(screen.getByText("Сохранить")).toHaveClass("action-label-hidden");
    expect(screen.getByText("Сохраняем…")).toHaveClass("working-text", "working-text-strong");
    expect(screen.getByText("Сохраняем…")).not.toHaveClass("action-label-hidden");
  });
});
