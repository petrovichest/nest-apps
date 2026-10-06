import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";

import { SetupScreen } from "./SetupScreen";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SetupScreen", () => {
  it("uses the textual CodexNest identity without a generic brand mark", () => {
    const { container } = render(<SetupScreen onConnected={() => undefined} />);

    expect(screen.getByText("CodexNest", { selector: ".setup-identity" })).toBeInTheDocument();
    expect(container.querySelector(".brand-mark")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Адрес сервера")).toHaveValue("http://");
    expect(screen.getByLabelText("Адрес сервера")).toHaveAttribute(
      "placeholder",
      "http://192.168.1.42:4310",
    );
  });

  it("keeps manual Codex server setup in Android", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    render(<SetupScreen onConnected={vi.fn()} />);

    expect(screen.getByLabelText("Адрес сервера")).toHaveValue("http://");
    expect(screen.getByLabelText("Адрес сервера")).toHaveAttribute(
      "placeholder",
      "http://192.168.1.42:4310",
    );
  });

  it("shows the permanent LAN interception warning for HTTP", () => {
    render(<SetupScreen onConnected={() => undefined} />);
    expect(screen.getByText(/HTTP не шифрует token/)).toBeInTheDocument();
  });

  it("checks health and bearer authentication before saving", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ threadCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const connected = vi.fn();
    render(<SetupScreen onConnected={connected} />);
    fireEvent.change(screen.getByLabelText("Адрес сервера"), {
      target: { value: "https://pi.local:4310" },
    });
    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    await waitFor(() =>
      expect(connected).toHaveBeenCalledWith({ baseUrl: "https://pi.local:4310", token: "secret" }),
    );
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
    expect(secondHeaders.get("Authorization")).toBe("Bearer secret");
  });

  it("announces connection failures and retains the inputs for retry", async () => {
    let fail!: (error: Error) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const connected = vi.fn();
    render(<SetupScreen onConnected={connected} />);
    fireEvent.change(screen.getByLabelText("Адрес сервера"), {
      target: { value: "https://pi.local:4310" },
    });
    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "test-token" } });
    expect(screen.queryByText(/HTTP не шифрует token/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    expect(screen.getByRole("button", { name: "Проверяем…" })).toBeDisabled();
    fail(new Error("Test connection failure"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to connect to the server");
    expect(screen.getByRole("button", { name: "Подключиться" })).toBeEnabled();
    expect(screen.getByLabelText("Адрес сервера")).toHaveValue("https://pi.local:4310");
    expect(screen.getByLabelText("Bearer token")).toHaveValue("test-token");
    expect(localStorage.getItem("codexnest.token")).toBeNull();
    expect(connected).not.toHaveBeenCalled();
  });
});
