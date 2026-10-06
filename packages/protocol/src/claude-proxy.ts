import type { ClaudeProxyProtocol } from "./claude-accounts.js";

export type ParsedClaudeProxy = {
  protocol: ClaudeProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Contains credentials. Never include this value in public account status or logs. */
  url: string;
};

export class ClaudeProxyParseError extends Error {
  constructor(
    message: string,
    public readonly candidates: ParsedClaudeProxy[] = [],
  ) {
    super(message);
    this.name = "ClaudeProxyParseError";
  }
}

const protocols: Record<string, ClaudeProxyProtocol> = {
  http: "http",
  https: "https",
  socks: "socks5",
  socks5: "socks5",
  socks5h: "socks5",
};

function endpoint(value: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^\s/?#@\\:]+):(\d{1,5})$/.exec(value.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  try {
    const url = new URL(`http://${match[1]}:${port}`);
    if (url.pathname !== "/" || url.search || url.hash || !url.hostname) return null;
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return null;
  }
}

function credentials(value: string, encoded: boolean): [string, string] | null {
  const colon = value.indexOf(":");
  if (colon < 1) return null;
  try {
    const parts: [string, string] = [value.slice(0, colon), value.slice(colon + 1)];
    return encoded ? [decodeURIComponent(parts[0]), decodeURIComponent(parts[1])] : parts;
  } catch {
    return null;
  }
}

function candidate(
  address: string,
  auth: [string, string] | null,
  protocol: ClaudeProxyProtocol,
): ParsedClaudeProxy | null {
  const parsed = endpoint(address);
  if (!parsed) return null;
  const host = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
  const url = new URL(`${protocol === "socks5" ? "socks5h" : protocol}://${host}:${parsed.port}`);
  if (auth) {
    url.username = auth[0];
    url.password = auth[1];
  }
  return {
    protocol,
    ...parsed,
    ...(auth ? { username: auth[0], password: auth[1] } : {}),
    url: url.href.replace(/\/$/, ""),
  };
}

/** Browser-safe parser shared by the settings form and server validation. */
export function parseClaudeProxyCandidates(
  value: string,
  protocol: ClaudeProxyProtocol = "http",
): ParsedClaudeProxy[] {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    // eslint-disable-next-line no-control-regex -- Reject embedded controls without reflecting credentials.
    /[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw new ClaudeProxyParseError("Некорректная строка прокси");
  if (!["http", "https", "socks5"].includes(protocol))
    throw new ClaudeProxyParseError("Выберите HTTP, HTTPS или SOCKS5");
  let text = value.trim();
  if (!text) return [];
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(text);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    const explicit = Object.hasOwn(protocols, name) ? protocols[name] : undefined;
    if (!explicit) throw new ClaudeProxyParseError("Поддерживаются HTTP, HTTPS и SOCKS5");
    protocol = explicit;
    text = text.slice(scheme[0].length).replace(/\/$/, "");
    const address = text.slice(text.lastIndexOf("@") + 1);
    if (/^(?:\[[^\]]+\]|[^\s/?#@\\:]+)$/.test(address))
      text += `:${protocol === "https" ? 443 : protocol === "socks5" ? 1080 : 80}`;
  }
  const result: ParsedClaudeProxy[] = [];
  const add = (address: string, auth: [string, string] | null = null) => {
    const parsed = candidate(address, auth, protocol);
    if (parsed && !result.some((item) => item.url === parsed.url)) result.push(parsed);
  };
  if (endpoint(text)) {
    add(text);
    return result;
  }
  const at = text.lastIndexOf("@");
  if (at > 0) {
    const left = text.slice(0, at),
      right = text.slice(at + 1);
    const auth = credentials(left, !!scheme);
    if (auth) add(right, auth);
    const reversed = credentials(right, !!scheme);
    if (reversed) add(left, reversed);
  }
  const first = at < 0 && !scheme ? /^(\[[^\]]+\]:\d{1,5}|[^:]+:\d{1,5}):(.+)$/.exec(text) : null;
  if (first) {
    const auth = credentials(first[2]!, !!scheme);
    if (auth) add(first[1]!, auth);
  }
  const last = at < 0 && !scheme ? /^(.+):(\[[^\]]+\]:\d{1,5}|[^:]+:\d{1,5})$/.exec(text) : null;
  if (last) {
    const auth = credentials(last[1]!, !!scheme);
    if (auth) add(last[2]!, auth);
  }
  if (!result.length && !scheme) {
    const fields = text.split(/[\s;|]+/).filter(Boolean);
    if (fields.length === 2) add(`${fields[0]}:${fields[1]}`);
    if (fields.length === 4) {
      add(`${fields[0]}:${fields[1]}`, [fields[2]!, fields[3]!]);
      add(`${fields[2]}:${fields[3]}`, [fields[0]!, fields[1]!]);
    }
  }
  return result;
}

export function parseClaudeProxy(
  value: string,
  protocol: ClaudeProxyProtocol = "http",
): ParsedClaudeProxy {
  const candidates = parseClaudeProxyCandidates(value, protocol);
  if (!candidates.length)
    throw new ClaudeProxyParseError("Не удалось распознать адрес и порт прокси");
  if (candidates.length > 1)
    throw new ClaudeProxyParseError("Выберите правильный разбор прокси", candidates);
  return candidates[0]!;
}
