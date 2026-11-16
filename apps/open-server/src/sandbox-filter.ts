import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { endianness } from "node:os";
import { isAbsolute, join } from "node:path";

// Linux UAPI: linux/filter.h, linux/seccomp.h, linux/audit.h,
// asm/unistd_64.h and asm-generic/unistd.h. sock_filter is eight bytes:
// uint16 code; uint8 jt, jf; uint32 k (native endian).
const LD_WORD_ABSOLUTE = 0x20;
const JUMP_EQUAL = 0x15;
const JUMP_BITS_SET = 0x45;
const RETURN = 0x06;
const ALLOW = 0x7fff0000;
const DENY = 0x00050001; // SECCOMP_RET_ERRNO | EPERM
const KILL_PROCESS = 0x80000000;
type Instruction = [code: number, trueSkip: number, falseSkip: number, value: number];

function nativeFilter(network: boolean): Buffer {
  if (
    process.platform !== "linux" ||
    endianness() !== "LE" ||
    !["x64", "arm64"].includes(process.arch)
  )
    throw new Error(
      "Managed shell isolation requires Linux x64 or arm64 with little-endian seccomp.",
    );
  const x64 = process.arch === "x64";
  const auditArchitecture = x64 ? 0xc000003e : 0xc00000b7;
  const socket = x64 ? 41 : 198;
  const socketpair = x64 ? 53 : 199;
  const instructions: Instruction[] = [
    [LD_WORD_ABSOLUTE, 0, 0, 4], // seccomp_data.arch
    [JUMP_EQUAL, 1, 0, auditArchitecture],
    [RETURN, 0, 0, KILL_PROCESS], // Refuse compat ABIs with different syscall numbering.
    [LD_WORD_ABSOLUTE, 0, 0, 0], // seccomp_data.nr
    [JUMP_BITS_SET, 0, 1, 0x40000000], // x32 shares the x86_64 audit architecture.
    [RETURN, 0, 0, DENY],
  ];
  // io_uring can create sockets in the kernel without a socket() syscall. Block
  // ring setup/operation rather than leaving an alternate route around this policy.
  for (const syscall of [425, 426, 427])
    instructions.push([JUMP_EQUAL, 0, 1, syscall], [RETURN, 0, 0, DENY]);
  if (!network) {
    for (const syscall of [socket, socketpair])
      instructions.push([JUMP_EQUAL, 0, 1, syscall], [RETURN, 0, 0, DENY]);
  } else {
    // A socketpair(AF_UNIX, SOCK_DGRAM) can be disconnected and retargeted to a
    // host socket. It must obey the same AF_UNIX restriction as socket().
    instructions.push(
      [JUMP_EQUAL, 1, 0, socket],
      [JUMP_EQUAL, 0, 3, socketpair],
      [LD_WORD_ABSOLUTE, 0, 0, 16], // Low word of seccomp_data.args[0]: domain.
      [JUMP_EQUAL, 0, 1, 1], // AF_UNIX
      [RETURN, 0, 0, DENY],
    );
  }
  instructions.push([RETURN, 0, 0, ALLOW]);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, value], index) => {
    const offset = index * 8;
    bytes.writeUInt16LE(code, offset);
    bytes.writeUInt8(jt, offset + 2);
    bytes.writeUInt8(jf, offset + 3);
    bytes.writeUInt32LE(value, offset + 4);
  });
  return bytes;
}

/** Private, atomic classic-BPF program for bubblewrap's --seccomp FD argument. */
export async function sandboxFilterFile(directory: string, network: boolean): Promise<string> {
  const bytes = nativeFilter(network);
  if (!isAbsolute(directory) || typeof network !== "boolean")
    throw new Error("Invalid managed sandbox filter configuration.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.mode & 0o077 || metadata.uid !== process.getuid?.())
    throw new Error("Managed sandbox filters require a private owned directory.");
  const path = join(directory, `seccomp-${process.arch}-${network ? "network" : "offline"}.bpf`);
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.mode & 0o077 || existing.uid !== process.getuid?.())
      throw new Error("Managed sandbox filter must be a private regular file.");
    if ((await readFile(path)).equals(bytes)) return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.seccomp-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return path;
}
