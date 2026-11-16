import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  enforceToolPolicy,
  MANAGED_FILESYSTEM_TOOLS,
  readToolPolicy,
  shellQuote,
  writeToolPolicy,
  type ToolPolicy,
} from "./tool-policy";

const execute = promisify(execFile);
const roots: string[] = [];
async function fixture(mode: ToolPolicy["mode"]): Promise<ToolPolicy> {
  const root = await mkdtemp(join(tmpdir(), "open-policy-"));
  roots.push(root);
  const directory = join(root, "project");
  const ownerHome = join(root, "owner");
  await mkdir(directory);
  await mkdir(join(ownerHome, ".config/opennest"), { recursive: true });
  await writeFile(join(ownerHome, ".config/opennest/server.env"), "fixture-owner-token");
  await writeFile(join(directory, "allowed.txt"), "original");
  await writeFile(join(directory, "protected.txt"), "protected");
  return {
    mode,
    directory,
    writePaths: ["allowed.txt"],
    network: false,
    ownerHome,
    nodeBin: process.execPath,
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("managed OpenCode tool isolation", () => {
  it("persists scoped policy privately and rejects unsafe native session identities", async () => {
    const policy = await fixture("readOnly");
    const stateDir = join(dirname(policy.directory), "state");
    await writeToolPolicy(stateDir, "ses_example", policy);
    expect(await readToolPolicy(stateDir, "ses_example")).toMatchObject(policy);
    expect((await readToolPolicy(stateDir, "ses_example"))?.protectedPaths).toContain(stateDir);
    expect(await readToolPolicy(stateDir, "ses_missing")).toBeNull();
    await expect(readToolPolicy(stateDir, "../escape")).rejects.toThrow("identity");
  });
  it("fails closed for write tools, native delegation and unverified plugin/MCP tools", async () => {
    const policy = await fixture("readOnly");
    for (const tool of ["write", "edit", "task", "mcp_remote_execute"])
      await expect(enforceToolPolicy(policy, tool, { filePath: "allowed.txt" })).rejects.toThrow();
    await expect(
      enforceToolPolicy(policy, "webfetch", { url: "https://example.com" }),
    ).rejects.toThrow("network");
  });
  it.each(["readOnly", "isolatedWrite", "sharedWrite"] as const)(
    "requires sandboxed bash for all native filesystem operations in %s tasks",
    async (mode) => {
      const policy = await fixture(mode);
      for (const tool of MANAGED_FILESYSTEM_TOOLS)
        await expect(
          enforceToolPolicy(policy, tool, {
            filePath: "allowed.txt",
            path: ".",
            pattern: "*",
            patchText: "*** Add File: allowed.txt\n+changed",
          }),
        ).rejects.toThrow("sandboxed bash");
    },
  );
  it("executes actual bubblewrap read-only shell without changing the host workspace", async () => {
    const policy = await fixture("readOnly");
    const args: Record<string, unknown> = { command: "printf changed > allowed.txt" };
    await enforceToolPolicy(policy, "bash", args);
    await expect(
      execute("/bin/sh", ["-c", String(args.command)], { timeout: 10_000 }),
    ).rejects.toBeDefined();
    expect(await readFile(join(policy.directory, "allowed.txt"), "utf8")).toBe("original");
  });
  it("allows shared writes only to explicitly bound existing paths", async () => {
    const policy = await fixture("sharedWrite");
    const args: Record<string, unknown> = {
      command: "printf changed > allowed.txt; printf wrong > protected.txt",
    };
    await enforceToolPolicy(policy, "bash", args);
    await expect(
      execute("/bin/sh", ["-c", String(args.command)], { timeout: 10_000 }),
    ).rejects.toBeDefined();
    expect(await readFile(join(policy.directory, "allowed.txt"), "utf8")).toBe("changed");
    expect(await readFile(join(policy.directory, "protected.txt"), "utf8")).toBe("protected");
  });
  it("does not let a command escape its quoted shell boundary", async () => {
    const policy = await fixture("readOnly");
    const args: Record<string, unknown> = {
      command: "printf '%s' \"single' double\\\" ; $(printf text)\"",
    };
    await enforceToolPolicy(policy, "bash", args);
    const result = await execute("/bin/sh", ["-c", String(args.command)], { timeout: 10_000 });
    expect(result.stdout).toBe("single' double\" ; text");
    await expect(
      enforceToolPolicy(policy, "bash", { command: "true", workdir: ".." }),
    ).rejects.toThrow("outside");
  });
  it("hides host owner credentials and runtime directories while keeping project and public Node working", async () => {
    const policy = await fixture("readOnly");
    policy.network = true;
    const credential = join(policy.ownerHome!, ".config/opennest/server.env");
    const runtime = join(dirname(policy.directory), "owner-runtime");
    await mkdir(runtime);
    await writeFile(join(runtime, "token"), "fixture-runtime-token");
    policy.protectedPaths = [runtime];
    const script = `const fs=require('node:fs'); for(const path of ${JSON.stringify([credential, join(runtime, "token")])}) { try {fs.readFileSync(path);process.exit(3);} catch(error) {if(!['ENOENT','EACCES','ENOTDIR'].includes(error.code))throw error;} } if(fs.readFileSync('allowed.txt','utf8')!=='original')process.exit(4); if(fs.existsSync('/run/user'))process.exit(5); if(process.env.HOME!== '/tmp/opennest-home')process.exit(6); console.log('isolated-project-ok');`;
    const args: Record<string, unknown> = { command: `node -e ${shellQuote(script)}` };
    await enforceToolPolicy(policy, "bash", args, join(dirname(policy.directory), "filters"));
    expect(
      (await execute("/bin/sh", ["-c", String(args.command)], { timeout: 10000 })).stdout.trim(),
    ).toBe("isolated-project-ok");
  });
  it("keeps file reads inside the actual shell namespace including symbolic links", async () => {
    const policy = await fixture("readOnly");
    await symlink(
      join(policy.ownerHome!, ".config/opennest/server.env"),
      join(policy.directory, "secret-link"),
    );
    const read: Record<string, unknown> = { command: "cat allowed.txt" };
    await enforceToolPolicy(policy, "bash", read);
    expect(
      (await execute("/bin/sh", ["-c", String(read.command)], { timeout: 10000 })).stdout,
    ).toBe("original");
    const escaped: Record<string, unknown> = { command: "cat secret-link" };
    await enforceToolPolicy(policy, "bash", escaped);
    await expect(
      execute("/bin/sh", ["-c", String(escaped.command)], { timeout: 10000 }),
    ).rejects.toBeDefined();
    await expect(
      enforceToolPolicy({ ...policy, directory: dirname(policy.directory) }, "grep", {
        pattern: "token",
      }),
    ).rejects.toThrow("protected owner");
  });
  it("supports file creation through an explicitly writable existing parent directory", async () => {
    const policy = await fixture("isolatedWrite");
    await mkdir(join(policy.directory, "output"));
    policy.writePaths = ["output"];
    const args: Record<string, unknown> = {
      command: "cat protected.txt; printf result > output/new.txt",
    };
    await enforceToolPolicy(policy, "bash", args);
    expect(
      (await execute("/bin/sh", ["-c", String(args.command)], { timeout: 10000 })).stdout,
    ).toBe("protected");
    expect(await readFile(join(policy.directory, "output/new.txt"), "utf8")).toBe("result");
    policy.writePaths = ["missing.txt"];
    await expect(enforceToolPolicy(policy, "bash", { command: "true" })).rejects.toThrow(
      "existing parent-directory scope",
    );
  });
  it("keeps normal project-local node_modules dependencies available", async () => {
    const policy = await fixture("readOnly");
    await mkdir(join(policy.directory, "node_modules/demo"), { recursive: true });
    await writeFile(
      join(policy.directory, "node_modules/demo/index.js"),
      "module.exports='project-dependency-ok'",
    );
    const args: Record<string, unknown> = { command: `node -e "console.log(require('demo'))"` };
    await enforceToolPolicy(policy, "bash", args, join(dirname(policy.directory), "filters"));
    expect(
      (await execute("/bin/sh", ["-c", String(args.command)], { timeout: 10000 })).stdout.trim(),
    ).toBe("project-dependency-ok");
  });
  it("exposes only required linked-worktree Git metadata, excluding sibling task files", async () => {
    const policy = await fixture("readOnly");
    const root = dirname(policy.directory),
      repository = join(root, "repository"),
      worktree = join(root, "linked");
    await mkdir(repository);
    await execute("git", ["init", "-q", repository]);
    await execute("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=50870093+petrovichest@users.noreply.github.com",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    await execute("git", ["-C", repository, "worktree", "add", "--detach", worktree, "HEAD"]);
    const gitCommon = join(repository, ".git");
    await mkdir(join(gitCommon, "codexnest-team-worktrees/sibling"), { recursive: true });
    const sibling = join(gitCommon, "codexnest-team-worktrees/sibling/private.txt");
    await writeFile(sibling, "sibling-task-output");
    policy.directory = worktree;
    policy.gitReadOnlyPaths = [gitCommon];
    const command = `git status --porcelain && node -e ${shellQuote(`if(require('node:fs').existsSync(${JSON.stringify(sibling)}))process.exit(3);console.log('linked-git-ok')`)}`;
    const args: Record<string, unknown> = { command };
    await enforceToolPolicy(policy, "bash", args, join(root, "filters"));
    expect(
      (await execute("/bin/sh", ["-c", String(args.command)], { timeout: 10000 })).stdout.trim(),
    ).toBe("linked-git-ok");
  });
  it("gates known browser tools on network access without allowing arbitrary browser-prefixed tools", async () => {
    const policy = await fixture("readOnly");
    await expect(enforceToolPolicy(policy, "browser_tabs_context", {})).rejects.toThrow(
      "browser network",
    );
    await expect(
      enforceToolPolicy({ ...policy, network: true }, "browser_tabs_context", {}),
    ).resolves.toBeUndefined();
    await expect(
      enforceToolPolicy({ ...policy, network: true }, "browser_arbitrary_mcp_execute", {}),
    ).rejects.toThrow("verified");
  });
});
