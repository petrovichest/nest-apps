import { access, lstat, mkdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonAtomic } from "../../claude-server/src/io";
import { sandboxFilterFile } from "./sandbox-filter";
import { BROWSER_TOOL_NAMES } from "@codexnest/protocol";

export type ToolPolicy = {
  mode: "readOnly" | "isolatedWrite" | "sharedWrite";
  directory: string;
  writePaths: string[];
  network: boolean;
  /** Added by the trusted host, never accepted from a delegated task's access arguments. */
  protectedPaths?: string[];
  nodeBin?: string;
  ownerHome?: string;
  /** Host-resolved Git common directories for linked worktrees, mounted read-only. */
  gitReadOnlyPaths?: string[];
};
const safeId = (id: string) => /^[A-Za-z0-9_-]{1,200}$/.test(id);
const browserTools = new Set<string>(BROWSER_TOOL_NAMES.map((name) => `browser_${name}`));
export const MANAGED_FILESYSTEM_TOOLS = [
  "read",
  "glob",
  "grep",
  "list",
  "ls",
  "write",
  "edit",
  "apply_patch",
  "patch",
  "multiedit",
] as const;
const inside = (root: string, path: string) => {
  const name = relative(root, path);
  return (
    name === "" ||
    (name !== ".." &&
      !name.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(name))
  );
};
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function writeToolPolicy(stateDir: string, id: string, policy: ToolPolicy) {
  if (!safeId(id)) throw new Error("Invalid managed session identity");
  await access("/usr/bin/bwrap", constants.X_OK);
  const path = join(stateDir, "tool-scopes");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stored = await normalizedPolicy({
    ...policy,
    protectedPaths: [...(policy.protectedPaths ?? []), stateDir],
  });
  await writeJsonAtomic(join(path, `${id}.json`), stored);
}

export async function readToolPolicy(stateDir: string, id: string): Promise<ToolPolicy | null> {
  if (!safeId(id)) throw new Error("Invalid managed session identity");
  try {
    const value = JSON.parse(
      await readFile(join(stateDir, "tool-scopes", `${id}.json`), "utf8"),
    ) as ToolPolicy;
    if (
      !["readOnly", "isolatedWrite", "sharedWrite"].includes(value.mode) ||
      !isAbsolute(value.directory) ||
      !Array.isArray(value.writePaths) ||
      !value.writePaths.every((path) => typeof path === "string") ||
      typeof value.network !== "boolean" ||
      (value.protectedPaths !== undefined &&
        (!Array.isArray(value.protectedPaths) ||
          !value.protectedPaths.every((path) => typeof path === "string" && isAbsolute(path))))
    )
      throw new Error("Invalid managed tool policy");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function canonicalToolPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalToolPath(parent), path.slice(parent.length));
  }
}

async function normalizedPolicy(
  policy: ToolPolicy,
): Promise<ToolPolicy & { protectedPaths: string[]; nodeBin: string; ownerHome: string }> {
  const ownerHome = await canonicalToolPath(resolve(policy.ownerHome || homedir()));
  const defaults = [
    ".config",
    ".local/share",
    ".local/state",
    ".cache",
    ".ssh",
    ".gnupg",
    ".codex",
    ".claude",
    ".gemini",
    ".opencode",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".netrc",
    ".npmrc",
    ".git-credentials",
  ].map((path) => join(ownerHome, path));
  const protectedPaths = await Promise.all(
    [...new Set([...defaults, "/run", "/proc", "/sys", ...(policy.protectedPaths ?? [])])].map(
      (path) => canonicalToolPath(resolve(path)),
    ),
  );
  const directory = await realpath(policy.directory);
  if (protectedPaths.some((path) => inside(directory, path) || inside(path, directory)))
    throw new Error(
      "Managed project scope overlaps protected owner configuration or runtime state",
    );
  const nodeBin = await realpath(
    policy.nodeBin || process.env.OPENNEST_NODE_BIN || process.execPath,
  );
  if (basename(nodeBin) !== "node" || basename(dirname(nodeBin)) !== "bin")
    throw new Error("Managed shell requires an explicitly configured public Node runtime");
  const nodeRoot = dirname(dirname(nodeBin));
  if (protectedPaths.some((path) => inside(nodeRoot, path)))
    throw new Error("Public Node runtime overlaps protected owner state");
  for (const path of policy.gitReadOnlyPaths ?? []) {
    const canonical = await realpath(path);
    if (
      !basename(canonical).endsWith(".git") ||
      !(await stat(canonical)).isDirectory() ||
      protectedPaths.some(
        (protectedPath) => inside(protectedPath, canonical) || inside(canonical, protectedPath),
      )
    )
      throw new Error("Git metadata path overlaps protected owner state");
  }
  return { ...policy, directory, protectedPaths, nodeBin, ownerHome };
}

async function publicSystemMounts(command: string[]) {
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32"]) {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) command.push("--symlink", await readlink(path), path);
      else command.push("--ro-bind", path, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Network trust/name resolution and the dynamic loader need these public files;
  // mounting all /etc would also expose unrelated application configuration.
  for (const path of [
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/ssl/certs",
    "/etc/pki",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/hosts",
    "/etc/localtime",
    "/etc/passwd",
    "/etc/group",
  ]) {
    try {
      await stat(path);
      command.push("--ro-bind", path, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Policies are enforced independently of the model's instructions. */
export async function enforceToolPolicy(
  policy: ToolPolicy,
  tool: string,
  args: Record<string, unknown>,
  filterDirectory = join(dirname(policy.directory), `.opennest-policy-${process.pid}`),
): Promise<void> {
  policy = await normalizedPolicy(policy);
  if (tool === "task")
    throw new Error("Managed Team uses OpenNest tasks; native subagents are disabled");
  if ((MANAGED_FILESYSTEM_TOOLS as readonly string[]).includes(tool))
    throw new Error(
      "Managed file operations must use sandboxed bash within the assigned access scope",
    );
  const readTools = new Set([
    "skill",
    "todoread",
    "todowrite",
    "question",
    "codexnest_submit_result",
    "codexnest_publish_artifact",
  ]);
  if (browserTools.has(tool)) {
    if (!policy.network) throw new Error("This managed task has no browser network access");
    // The application tool endpoint separately validates this session's actual
    // browser binding. A network grant never supplies or replaces that binding.
    return;
  }
  if (["webfetch", "websearch", "codesearch"].includes(tool)) {
    if (!policy.network) throw new Error("This managed task has no network access");
    return;
  }
  if (tool === "bash" || tool === "shell") {
    if (typeof args.command !== "string") throw new Error("Invalid shell command");
    const directory = await realpath(policy.directory);
    const workdir =
      typeof args.workdir === "string"
        ? await realpath(resolve(directory, args.workdir))
        : directory;
    if (!inside(directory, workdir))
      throw new Error("Managed shell working directory is outside its workspace");
    const originalCommand = args.command;
    const filter = await sandboxFilterFile(filterDirectory, policy.network);
    const command = [
      "/usr/bin/bwrap",
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
    ];
    await publicSystemMounts(command);
    command.push(
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/tmp/opennest-home",
      "--tmpfs",
      "/run",
      "--seccomp",
      "3",
    );
    if (!policy.network) command.push("--unshare-net");
    command.push("--ro-bind", directory, directory);
    for (const path of policy.gitReadOnlyPaths ?? []) {
      const canonical = await realpath(path);
      // A Git common directory may itself contain sibling Team workspaces. Bind
      // metadata entries selectively, not that entire directory and its siblings.
      for (const name of ["objects", "refs", "HEAD", "config", "packed-refs", "shallow", "info"]) {
        const entry = join(canonical, name);
        try {
          await stat(entry);
          command.push("--ro-bind", entry, entry);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const gitFile = await readFile(join(directory, ".git"), "utf8");
      const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(gitFile);
      if (!match) throw new Error("Cannot verify linked worktree metadata");
      const privateGitDir = await realpath(resolve(directory, match[1]!));
      if (!inside(join(canonical, "worktrees"), privateGitDir))
        throw new Error("Unsafe linked worktree metadata");
      command.push("--ro-bind", privateGitDir, privateGitDir);
    }
    const nodeRoot = dirname(dirname(policy.nodeBin!));
    if (!inside("/usr", nodeRoot)) command.push("--ro-bind", nodeRoot, nodeRoot);
    if (policy.mode !== "readOnly") {
      for (const path of policy.writePaths) {
        const target = await canonicalToolPath(resolve(directory, path));
        if (!inside(directory, target)) throw new Error("Unsafe managed write path");
        try {
          await stat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            throw new Error(
              "The managed write path no longer exists; choose an existing parent-directory scope",
              { cause: error },
            );
          throw error;
        }
        command.push("--bind", target, target);
      }
    }
    command.push(
      "--clearenv",
      "--setenv",
      "PATH",
      `${dirname(policy.nodeBin!)}:/usr/local/bin:/usr/bin:/bin`,
      "--setenv",
      "HOME",
      "/tmp/opennest-home",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "GIT_OPTIONAL_LOCKS",
      "0",
      "--chdir",
      workdir,
      "--",
      "/bin/sh",
      "-c",
      args.command,
    );
    args.command = `exec 3<${shellQuote(filter)}; exec ${command.map(shellQuote).join(" ")}`;
    args.opennestOriginalCommand = originalCommand;
    args.workdir = directory;
    return;
  }
  if (!readTools.has(tool))
    throw new Error("This tool has no verified managed-task isolation policy");
}
