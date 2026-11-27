import type { ActivityItem } from "@codexnest/protocol";

const workerCommands = {
  worker_list: { label: "Список работников", icon: "team" },
  worker_delegate: { label: "Передача поручения", icon: "worker" },
  worker_ask: { label: "Вопрос работнику", icon: "worker" },
  worker_follow_up: { label: "Уточнение работнику", icon: "worker" },
  worker_results: { label: "Проверка результатов", icon: "check" },
  worker_finish: { label: "Отчёт о результате", icon: "check" },
} as const;

type CommandLabel = {
  label: string;
  icon: "team" | "worker" | "check" | "branch" | "read" | "search" | "terminal";
  file?: string;
};

function basename(path: string | undefined) {
  return path?.split("/").at(-1);
}

// Recognize literal arguments only. Substitution, redirection and compound shell
// expressions fall back to the generic label unless the provider supplied a kind.
function shellWords(input: string): string[] {
  const command = input.trim();
  const word = /(?:[^\s'"\\;&|<>()`$*?[\]{}#]+|'[^']*'|"(?:[^"\\`$]|\\[^\r\n])*"|\\[^\r\n]|\{\})+/y;
  const words: string[] = [];
  let offset = 0;
  while (offset < command.length) {
    word.lastIndex = offset;
    const match = word.exec(command);
    if (!match || (word.lastIndex < command.length && !/[ \t]/.test(command[word.lastIndex]!))) {
      return [];
    }
    words.push(
      match[0].replace(
        /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\(.)/g,
        (_match, single, double, escaped) =>
          single ?? double?.replace(/\\(["\\`$])/g, "$1") ?? escaped,
      ),
    );
    offset = word.lastIndex;
    while (offset < command.length && /[ \t]/.test(command[offset]!)) offset += 1;
  }
  return words;
}

export function commandLabel(item: Extract<ActivityItem, { type: "command" }>): CommandLabel {
  let args = shellWords(item.command);
  if (
    args.length === 3 &&
    /^(?:ba|z)?sh$/.test(basename(args[0]) ?? "") &&
    (args[1] === "-lc" || args[1] === "-c")
  ) {
    args = shellWords(args[2]!);
  }
  const command = basename(args[0]);
  const operation = args[3];
  if (
    command === "node" &&
    (args.length === 4 || args.length === 5) &&
    basename(args[1]) === "agent.mjs" &&
    /(?:^|\/)capabilities\/worker-(?:codex|claude|gemini|open)-[\da-f-]{36}\.json$/i.test(
      args[2]!,
    ) &&
    operation &&
    Object.hasOwn(workerCommands, operation)
  ) {
    return workerCommands[operation as keyof typeof workerCommands];
  }
  if (command === "git" && (args[1] === "status" || (args[1] === "-C" && args[3] === "status"))) {
    return { label: "Проверка состояния Git", icon: "branch" };
  }
  const readFile =
    args.length === 2 && /^(?:cat|head|tail|Read)$/.test(command ?? "") && !args[1]?.startsWith("-")
      ? basename(args[1])
      : command === "sed" &&
          args.length === 4 &&
          args[1] === "-n" &&
          /^\d+(?:,\d+)?p$/.test(args[2]!) &&
          !args[3]?.startsWith("-")
        ? basename(args[3])
        : undefined;
  if (readFile) return { label: "Чтение {{file}}", icon: "read", file: readFile };
  if (item.kind === "read") return { label: "Чтение файлов", icon: "read" };
  if (
    item.kind === "search" ||
    (/^(?:rg|grep)$/.test(command ?? "") &&
      args.length > 1 &&
      !args.some(
        (arg) =>
          ["--help", "--version", "-h", "-V", "--pre"].includes(arg) || arg.startsWith("--pre="),
      ))
  ) {
    return { label: "Поиск", icon: "search" };
  }
  return { label: "Команда", icon: "terminal" };
}
