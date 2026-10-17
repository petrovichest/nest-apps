/**
 * Claude Code records a typed "/name args" (a skill or a custom command) as
 * `<command-message>name</command-message>`, `<command-name>/name</command-name>` and
 * `<command-args>args</command-args>`. This gives back the text as it was typed;
 * any other text, even one that mentions these tags, is returned unchanged.
 */
export function typedCommand(text: string): string {
  if (!text.includes("<command-name>")) return text;
  let name = "";
  let args = "";
  const rest = text.replace(
    /<command-(message|name|args)>([\s\S]*?)<\/command-\1>/g,
    (_tag, kind: string, body: string) => {
      if (kind === "name") name = body.trim();
      else if (kind === "args") args = body.trim();
      return "";
    },
  );
  if (!name.startsWith("/") || rest.trim()) return text;
  return args ? `${name} ${args}` : name;
}

/** Claude records successful /compact output as unflagged user input, not a chat message. */
export function isCompactConfirmation(text: string): boolean {
  return /^\s*<local-command-stdout>\s*Compacted\s*<\/local-command-stdout>\s*$/.test(text);
}
