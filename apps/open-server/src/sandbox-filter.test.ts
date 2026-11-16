import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxFilterFile } from "./sandbox-filter";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "open-seccomp-"));
  roots.push(root);
  const protectedDirectory = join(root, "private");
  await mkdir(protectedDirectory, { mode: 0o700 });
  await writeFile(join(root, "protected.txt"), "unchanged");
  return { root, protectedDirectory };
}
async function listener(root: string, unix: boolean) {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.end();
  });
  servers.push(server);
  const address = unix ? join(root, "host-control.sock") : { port: 0, host: "127.0.0.1" };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  const selected = server.address();
  const options =
    typeof selected === "string" ? { path: selected } : { port: selected!.port, host: "127.0.0.1" };
  return { options, connections: () => connections };
}
async function sandbox(root: string, code: string, filter?: string) {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--ro-bind",
    "/",
    "/",
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    root,
    root,
    "--chdir",
    root,
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    root,
  ];
  const fd = filter ? openSync(filter, "r") : null;
  if (fd !== null) args.push("--seccomp", "3");
  args.push("--", process.execPath, "-e", code);
  try {
    const child = spawn("/usr/bin/bwrap", args, {
      stdio: ["ignore", "pipe", "pipe", ...(fd === null ? [] : [fd])],
    });
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Isolated seccomp probe timed out"));
      }, 10_000);
      child.stdout!.on("data", (data) => {
        stdout += data;
        if (stdout.length > 64 * 1024) child.kill("SIGKILL");
      });
      child.stderr!.on("data", (data) => {
        stderr += data;
        if (stderr.length > 64 * 1024) child.kill("SIGKILL");
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`Isolated seccomp probe failed (${code}): ${stderr.slice(0, 2000)}`));
      });
    });
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
function connect(options: object) {
  return `const socket=require('node:net').createConnection(${JSON.stringify(options)}); socket.once('connect',()=>{console.log('connected');socket.end();}); socket.once('error',error=>{console.log(error.code);process.exitCode=error.code==='EPERM'?0:1;}); setTimeout(()=>process.exit(2),3000).unref();`;
}

describe("native bubblewrap seccomp socket boundary", () => {
  it("writes stable private atomic filter files and refuses symlink destinations", async () => {
    const { protectedDirectory } = await fixture();
    const path = await sandboxFilterFile(protectedDirectory, true);
    expect(await sandboxFilterFile(protectedDirectory, true)).toBe(path);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path)).length % 8).toBe(0);
    expect(await readdir(protectedDirectory)).toEqual([path.slice(protectedDirectory.length + 1)]);
    await unlink(path);
    await symlink(join(protectedDirectory, "other"), path);
    await expect(sandboxFilterFile(protectedDirectory, true)).rejects.toThrow(
      "private regular file",
    );
  });

  it("proves the read-only filesystem alone permits reaching a fixture host Unix socket", async () => {
    const { root } = await fixture();
    const host = await listener(root, true);
    expect((await sandbox(root, connect(host.options))).stdout.trim()).toBe("connected");
    expect(host.connections()).toBe(1);
    expect(await readFile(join(root, "protected.txt"), "utf8")).toBe("unchanged");
  });

  it("denies actual host Unix socket connections even when network is enabled", async () => {
    const { root, protectedDirectory } = await fixture();
    const host = await listener(root, true);
    const filter = await sandboxFilterFile(protectedDirectory, true);
    expect((await sandbox(root, connect(host.options), filter)).stdout.trim()).toBe("EPERM");
    expect(host.connections()).toBe(0);
  });

  it("denies actual TCP sockets with network disabled", async () => {
    const { root, protectedDirectory } = await fixture();
    const host = await listener(root, false);
    const filter = await sandboxFilterFile(protectedDirectory, false);
    expect((await sandbox(root, connect(host.options), filter)).stdout.trim()).toBe("EPERM");
    expect(host.connections()).toBe(0);
  });

  it("allows a loopback TCP fixture with network enabled", async () => {
    const { root, protectedDirectory } = await fixture();
    const host = await listener(root, false);
    const filter = await sandboxFilterFile(protectedDirectory, true);
    expect((await sandbox(root, connect(host.options), filter)).stdout.trim()).toBe("connected");
    expect(host.connections()).toBe(1);
  });

  it("guards syscall architecture and x32 aliases before evaluating socket permissions", async () => {
    const { protectedDirectory } = await fixture();
    const bytes = await readFile(await sandboxFilterFile(protectedDirectory, true));
    // Execute the emitted classic BPF over seccomp_data packets. Real kernel
    // application is independently exercised by the networking tests above.
    function evaluate(architecture: number, nr: number, domain: number) {
      const data = Buffer.alloc(64);
      data.writeUInt32LE(nr, 0);
      data.writeUInt32LE(architecture, 4);
      data.writeUInt32LE(domain, 16);
      let accumulator = 0;
      for (let pc = 0; pc < bytes.length / 8; pc++) {
        const offset = pc * 8,
          code = bytes.readUInt16LE(offset),
          jt = bytes[offset + 2]!,
          jf = bytes[offset + 3]!,
          value = bytes.readUInt32LE(offset + 4);
        if (code === 0x20) accumulator = data.readUInt32LE(value);
        else if (code === 0x15) pc += accumulator === value ? jt : jf;
        else if (code === 0x45) pc += (accumulator & value) !== 0 ? jt : jf;
        else if (code === 0x06) return value;
        else throw new Error("Unknown BPF instruction");
      }
      throw new Error("BPF packet did not return");
    }
    const architecture = process.arch === "x64" ? 0xc000003e : 0xc00000b7;
    const syscall = process.arch === "x64" ? 41 : 198;
    expect(evaluate(0x40000003, syscall, 2)).toBe(0x80000000);
    expect(evaluate(architecture, syscall | 0x40000000, 2)).toBe(0x00050001);
    expect(evaluate(architecture, syscall, 1)).toBe(0x00050001);
    expect(evaluate(architecture, syscall, 2)).toBe(0x7fff0000);
    expect(evaluate(architecture, 425, 2)).toBe(0x00050001);
    expect(evaluate(architecture, process.arch === "x64" ? 53 : 199, 1)).toBe(0x00050001);
  });

  it("fails closed on unsupported native architectures", async () => {
    const { protectedDirectory } = await fixture();
    const descriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
    try {
      Object.defineProperty(process, "arch", { ...descriptor, value: "riscv64" });
      await expect(sandboxFilterFile(protectedDirectory, false)).rejects.toThrow(
        "requires Linux x64 or arm64",
      );
    } finally {
      Object.defineProperty(process, "arch", descriptor);
    }
  });
});
