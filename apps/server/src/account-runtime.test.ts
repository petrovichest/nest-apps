import { mkdtemp, readFile, rm } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DetachedAccountRuntimeLauncher,
  writePrivateJson,
  type AccountRuntimeDescriptor,
} from "./account-runtime";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const recordedPid = 123456789;
const directories: string[] = [];
let actual: typeof FsPromises;
beforeEach(async () => {
  actual = await vi.importActual("node:fs/promises");
  vi.mocked(readFile).mockImplementation(actual.readFile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function descriptor(): Promise<AccountRuntimeDescriptor> {
  const directory = await mkdtemp(join(tmpdir(), "account-runtime-exit-"));
  directories.push(directory);
  const value: AccountRuntimeDescriptor = {
    version: 1,
    id: "fixture",
    accountId: "fixture",
    fingerprint: "fixture",
    home: directory,
    historyHome: directory,
    native: false,
    codexBin: "codex",
    proxy: null,
    socketPath: join(directory, "worker.sock"),
    directory,
  };
  await writePrivateJson(join(directory, "runtime.json"), {
    id: value.id,
    fingerprint: value.fingerprint,
    pid: recordedPid,
    state: "ready",
    cliVersion: "fixture",
  });
  return value;
}

describe("DetachedAccountRuntimeLauncher after API reconnect", () => {
  it.each(["ENOENT", "ESRCH"])(
    "accepts an already exited worker (%s) without signalling another PID",
    async (code) => {
      const value = await descriptor();
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("Must not signal an unverified process");
      });
      vi.mocked(readFile).mockImplementation(((path: string, options: any) => {
        if (String(path).startsWith(`/proc/${recordedPid}/`)) {
          return Promise.reject(Object.assign(new Error("process exited"), { code }));
        }
        return actual.readFile(path, options);
      }) as typeof readFile);
      await expect(new DetachedAccountRuntimeLauncher().stop(value)).resolves.toBeUndefined();
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it("keeps permission errors visible instead of treating ownership as verified", async () => {
    const value = await descriptor();
    const kill = vi.spyOn(process, "kill");
    vi.mocked(readFile).mockImplementation(((path: string, options: any) => {
      if (String(path).startsWith(`/proc/${recordedPid}/`)) {
        return Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
      }
      return actual.readFile(path, options);
    }) as typeof readFile);
    await expect(new DetachedAccountRuntimeLauncher().stop(value)).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("accepts exit between ownership verification and SIGTERM", async () => {
    const value = await descriptor();
    vi.mocked(readFile).mockImplementation(((path: string, options: any) => {
      if (String(path) === `/proc/${recordedPid}/cmdline`) {
        return Promise.resolve(
          `node\0worker.js\0--descriptor\0${join(value.directory, "descriptor.json")}\0`,
        );
      }
      if (String(path) === `/proc/${recordedPid}/stat`) {
        return Promise.resolve(`${recordedPid} (worker) S 1 ${recordedPid} 0`);
      }
      return actual.readFile(path, options);
    }) as typeof readFile);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    });
    await expect(new DetachedAccountRuntimeLauncher().stop(value)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-recordedPid, "SIGTERM");
  });
});
