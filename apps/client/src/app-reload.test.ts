import type { AppUpdateStatus } from "@codexnest/protocol";
import { describe, expect, it, vi } from "vitest";
import { onBeforeAppReload, prepareAppReload, shouldReloadClient } from "./app-reload";

describe("application reload", () => {
  it("loads a changed server version even after a check clears the previous update result", () => {
    const status = {
      supported: true,
      currentVersion: "0.1.9-bbbbbbb",
      operation: "idle",
      result: "none",
    } as AppUpdateStatus;
    expect(shouldReloadClient(status, "0.1.9-aaaaaaa")).toBe(true);
    expect(shouldReloadClient(status, "0.1.9-bbbbbbb")).toBe(false);
    expect(shouldReloadClient({ ...status, operation: "building" }, "0.1.9-aaaaaaa")).toBe(false);
    expect(shouldReloadClient({ ...status, supported: false }, "0.1.9-aaaaaaa")).toBe(false);
    expect(shouldReloadClient(status, undefined)).toBe(false);
  });
  it("waits for every mounted draft owner and removes unmounted owners", async () => {
    let saved!: () => void;
    const save = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const dispose = onBeforeAppReload(() => save);
    const ready = vi.fn();
    const pending = prepareAppReload().then(ready);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    saved();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
    dispose();
    await prepareAppReload();
  });

  it("prevents a reload if saving input fails", async () => {
    const dispose = onBeforeAppReload(async () => {
      throw new Error("Storage unavailable");
    });
    await expect(prepareAppReload()).rejects.toThrow("Storage unavailable");
    dispose();
  });
});
