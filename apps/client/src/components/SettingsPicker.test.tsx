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

describe("Session speed settings", () => {
  it.each(["fast", "priority", "ultrafast"])(
    "selects a supported %s tier and marks the model button",
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
      const speed = screen.getByRole("combobox", { name: "Скорость" });
      const selected = tier === "ultrafast" ? "ultrafast" : "fast";
      expect(speed).toHaveValue("");
      fireEvent.change(speed, { target: { value: selected } });
      expect(onChange).toHaveBeenLastCalledWith({ serviceTier: selected });
      expect(speed).toHaveValue(selected);
      expect(opener).toHaveTextContent(tier === "ultrafast" ? "Ultrafast" : "Fast");
      fireEvent.change(speed, { target: { value: "" } });
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
    expect(screen.getByRole("combobox", { name: "Скорость" })).toHaveValue("");
    expect(screen.queryByRole("option", { name: "Fast" })).not.toBeInTheDocument();
  });

  it("clears Ultrafast instead of substituting Fast when the next model lacks support", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initialSettings={{ collaborationMode: "default", serviceTier: "ultrafast" }}
        models={[
          {
            ...defaultModel,
            serviceTiers: [
              { id: "priority", displayName: "Fast" },
              { id: "ultrafast", displayName: "Ultrafast" },
            ],
          },
          {
            ...defaultModel,
            id: "astra",
            displayName: "Astra",
            isDefault: false,
            serviceTiers: [{ id: "priority", displayName: "Fast" }],
          },
        ]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    expect(screen.getByRole("combobox", { name: "Скорость" })).toHaveValue("ultrafast");
    fireEvent.click(screen.getByRole("radio", { name: "Astra" }));
    expect(onChange).toHaveBeenLastCalledWith({ model: "astra", serviceTier: null });
    expect(screen.getByRole("combobox", { name: "Скорость" })).toHaveValue("");
    expect(screen.queryByRole("option", { name: "Ultrafast" })).not.toBeInTheDocument();
  });

  it("disables Fast with missing support and during a response", () => {
    const onChange = vi.fn();
    const view = render(<Harness models={[defaultModel]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Модель и уровень рассуждений" }));
    const speed = screen.getByRole("combobox", { name: "Скорость" });
    expect(screen.queryByRole("option", { name: "Fast" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(
      <Harness
        models={[{ ...defaultModel, serviceTiers: [{ id: "fast", displayName: "Fast" }] }]}
        disabled
        onChange={onChange}
      />,
    );
    expect(speed).toBeDisabled();
    expect(screen.getByRole("button", { name: "Модель и уровень рассуждений" })).toBeDisabled();
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
