import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelOption,
  SessionSettings,
  UpdateThreadSettingsRequest,
} from "@codexnest/protocol";

import { SettingsPicker } from "./SettingsPicker";

const defaultModel: ModelOption = {
  id: "gpt",
  displayName: "GPT",
  description: "",
  isDefault: true,
  reasoningEfforts: [],
  serviceTiers: [],
  supportsPersonality: false,
};

describe("Fast session settings", () => {
  it.each(["fast", "priority"])(
    "toggles Fast with a %s catalogue and marks the model button",
    (tier) => {
      const onChange = vi.fn();
      render(
        <Harness
          models={[{ ...defaultModel, serviceTiers: [{ id: tier, displayName: "Fast" }] }]}
          onChange={onChange}
        />,
      );
      const opener = screen.getByRole("button", { name: "Модель и уровень рассуждений" });
      expect(opener).not.toHaveTextContent("Fast");
      fireEvent.click(opener);
      const fast = screen.getByRole("switch", { name: /^Fast mode/ });
      expect(fast).toHaveAttribute("aria-checked", "false");
      fireEvent.click(fast);
      expect(onChange).toHaveBeenLastCalledWith({ serviceTier: "fast" });
      expect(fast).toHaveAttribute("aria-checked", "true");
      expect(opener).toHaveTextContent("Fast");
      fireEvent.click(fast);
      expect(onChange).toHaveBeenLastCalledWith({ serviceTier: null });
      expect(opener).not.toHaveTextContent("Fast");
    },
  );

  it("clears Fast when selecting an unsupported model", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initialSettings={{ collaborationMode: "default", serviceTier: "priority" }}
        models={[
          { ...defaultModel, serviceTiers: [{ id: "priority", displayName: "Fast" }] },
          { ...defaultModel, id: "other", displayName: "Other", isDefault: false },
        ]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    expect(onChange).toHaveBeenLastCalledWith({ model: "other", serviceTier: null });
    expect(screen.getByRole("switch", { name: /^Fast mode/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /^Fast mode/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("disables Fast with missing support and during a response", () => {
    const onChange = vi.fn();
    const view = render(<Harness models={[defaultModel]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    const fast = screen.getByRole("switch", { name: /^Fast mode/ });
    expect(fast).toBeDisabled();
    fireEvent.click(fast);
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(
      <Harness
        models={[{ ...defaultModel, serviceTiers: [{ id: "fast", displayName: "Fast" }] }]}
        disabled
        onChange={onChange}
      />,
    );
    expect(fast).toBeDisabled();
    expect(screen.getByRole("button", { name: "Модель и уровень рассуждений" })).toBeDisabled();
    fireEvent.click(fast);
    expect(onChange).not.toHaveBeenCalled();
  });
});

function Harness({
  models,
  disabled = false,
  initialSettings = { collaborationMode: "default" },
  onChange,
}: {
  models: ModelOption[];
  disabled?: boolean;
  initialSettings?: SessionSettings;
  onChange(value: UpdateThreadSettingsRequest): void;
}) {
  const [value, setValue] = useState(initialSettings);
  return (
    <SettingsPicker
      models={models}
      value={value}
      disabled={disabled}
      goalMode={false}
      onChange={(patch) => {
        onChange(patch);
        setValue((current) => {
          const next = { ...current };
          for (const [key, entry] of Object.entries(patch)) {
            if (entry === null) delete next[key as keyof SessionSettings];
            else Object.assign(next, { [key]: entry });
          }
          return next;
        });
      }}
    />
  );
}
