import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeTitleGenerator } from "./title";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
});

/** A stand-in for the Claude CLI that records how it was called and prints a canned answer. */
async function fakeClaude(answer: string) {
  const directory = await mkdtemp(join(tmpdir(), "claudenest-title-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const record = join(directory, "call.json");
  const bin = join(directory, "claude");
  await writeFile(
    bin,
    `#!${process.execPath}
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks).toString();
  require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input }));
  process.stdout.write(${JSON.stringify(answer)});
});
`,
  );
  await chmod(bin, 0o755);
  return {
    bin,
    call: async () =>
      JSON.parse(await readFile(record, "utf8")) as { args: string[]; input: string },
  };
}

const PNG = "data:image/png;base64,aW1hZ2U=";

describe("claudeTitleGenerator", () => {
  it("sends a text-only request through the plain JSON format", async () => {
    const claude = await fakeClaude('{"structured_output":{"title":"  Fix   login  "}}');
    const title = await claudeTitleGenerator({ claudeBin: claude.bin })("Fix the login", "sonnet");
    expect(title).toBe("Fix login");
    const { args, input } = await claude.call();
    expect(args).toEqual(expect.arrayContaining(["--output-format", "json", "--model", "sonnet"]));
    expect(args).not.toContain("--input-format");
    expect(input).toBe("<request>\nFix the login\n</request>");
  });

  it("sends the first images with the request as streaming input", async () => {
    const claude = await fakeClaude(
      [
        '{"type":"system","subtype":"init"}',
        "not json",
        '{"type":"result","is_error":false,"structured_output":{"title":"Скриншот ошибки"}}',
      ].join("\n"),
    );
    const images = [PNG, "data:image/jpeg;base64,YQ==\n", PNG, PNG];
    const title = await claudeTitleGenerator({ claudeBin: claude.bin })("Why?", undefined, images);
    expect(title).toBe("Скриншот ошибки");
    const { args, input } = await claude.call();
    expect(args).toEqual(
      expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json"]),
    );
    expect(args).toContain("--verbose");
    const message = JSON.parse(input) as {
      type: string;
      message: { role: string; content: Array<Record<string, unknown>> };
    };
    expect(message).toMatchObject({ type: "user", message: { role: "user" } });
    expect(message.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "YQ==" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      { type: "text", text: "<request>\nWhy?\n</request>" },
    ]);
  });

  it("falls back to the plain format when no image is usable", async () => {
    const claude = await fakeClaude('{"structured_output":{"title":"Notes"}}');
    const title = await claudeTitleGenerator({ claudeBin: claude.bin })("Notes", undefined, [
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "https://example.invalid/a.png",
    ]);
    expect(title).toBe("Notes");
    expect((await claude.call()).args).not.toContain("--input-format");
  });

  it("rejects a streaming answer without a result", async () => {
    const claude = await fakeClaude('{"type":"system","subtype":"init"}\n');
    await expect(
      claudeTitleGenerator({ claudeBin: claude.bin })("Why?", undefined, [PNG]),
    ).rejects.toThrow("Invalid Claude title response");
  });
});
