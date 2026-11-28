import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AcpClient } from "./acp";

it("accepts the complete load reply after a truncated history notification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-acp-replay-"));
  const agyBin = join(dir, "agy");
  const client = new AcpClient({ agyBin, nativeDir: dir }, process.env);
  try {
    await writeFile(
      agyBin,
      `#!${process.execPath}
const readline = require("node:readline");
readline.createInterface({input:process.stdin}).on("line", (line) => {
  const {id,method} = JSON.parse(line);
  if (method === "session/load") {
    process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"update":{"content":{"text":"truncated');
  }
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",result:{method},id}) + "\\n");
});
`,
      { mode: 0o700 },
    );
    await client.start();
    await expect(client.request("session/load", {}, 1000)).resolves.toEqual({
      method: "session/load",
    });
    await expect(client.request("session/prompt", {}, 1000)).resolves.toEqual({
      method: "session/prompt",
    });
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
