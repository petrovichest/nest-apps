import { replacePasteRanges, type PastedText } from "@codexnest/protocol";

const WORKER_TOOLS =
  /\n\nИнструмент работников Nest: '[^\r\n]*[/\\]capabilities[/\\]worker-(?:codex|claude|gemini|open)-([\da-fA-F-]{36})\.json' COMMAND JSON\nИспользуй memory_read /u;
const ARCHITECT_HEADER = "Ты встроенный Архитектор работников Nest.";
const ARCHITECT_GREETING =
  "Поприветствуй пользователя и спроси, какого работника он хочет создать для этого проекта.";
const TASK_HEADER = "Задача:";
const GREETING = "Поприветствуй пользователя и спроси, с чего начать.";

/** Worker launches also use this format in saved native transcripts without a client ID. */
export function workerMessagePresentation(
  message: PastedText & { id: string; text: string },
): (PastedText & { text: string; prefix: string | null }) | null {
  const { id, text } = message;
  const architect = text.startsWith(ARCHITECT_HEADER);
  if (!architect && !text.startsWith("Ты работаешь как «")) return null;
  const tools = WORKER_TOOLS.exec(text);
  if (!tools || (id.startsWith("kanban:") && id !== `kanban:${tools[1]}:start`)) return null;

  const end = text.indexOf("\n\n", tools.index + tools[0].length);
  if (end < 0) return null;
  const prompt = text.slice(end + 2);
  if (prompt === GREETING || (architect && prompt === ARCHITECT_GREETING))
    return { text: "", prefix: null };
  if (prompt !== TASK_HEADER && !prompt.startsWith(`${TASK_HEADER}\n`)) return null;

  const headerEnd = end + 2 + TASK_HEADER.length;
  return {
    text: text.slice(headerEnd + 1),
    prefix: `${text.slice(0, headerEnd)}\n`,
    inlinePastes: message.inlinePastes
      ? replacePasteRanges(message.inlinePastes, 0, headerEnd + 1, 0)
      : undefined,
    pasteBlocks: message.pasteBlocks,
  };
}
