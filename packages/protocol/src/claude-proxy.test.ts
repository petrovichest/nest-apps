import { describe, expect, it } from "vitest";
import {
  ClaudeProxyParseError,
  parseClaudeProxy,
  parseClaudeProxyCandidates,
} from "./claude-proxy.js";

describe("Claude proxy provider formats", () => {
  it.each([
    "proxy.example:8080:user:secret",
    "user:secret:proxy.example:8080",
    "user:secret@proxy.example:8080",
    "proxy.example:8080@user:secret",
    "http://user:secret@proxy.example:8080",
    "proxy.example;8080;user;secret",
    "proxy.example 8080 user secret",
    "user|secret|proxy.example|8080",
    "proxy.example\n8080\nuser\nsecret",
  ])("recognizes %s", (value) => {
    expect(parseClaudeProxy(value)).toMatchObject({
      protocol: "http",
      host: "proxy.example",
      port: 8080,
      username: "user",
      password: "secret",
    });
  });
  it.each(["socks5", "socks5h", "socks"])("uses remote DNS for %s", (scheme) => {
    expect(parseClaudeProxy(`${scheme}://user:secret@proxy.example:1080`, "https")).toMatchObject({
      protocol: "socks5",
      url: "socks5h://user:secret@proxy.example:1080",
    });
  });
  it("respects explicit schemes and defaults", () => {
    expect(parseClaudeProxy("https://proxy.example")).toMatchObject({
      protocol: "https",
      port: 443,
    });
    expect(parseClaudeProxy("socks5://proxy.example")).toMatchObject({
      protocol: "socks5",
      port: 1080,
    });
    expect(parseClaudeProxy("proxy.example:8443", "https").protocol).toBe("https");
  });
  it("supports IPv6 and encoded credentials", () => {
    expect(parseClaudeProxy("https://user:p%40ss%3Aword@[2001:db8::1]:8443")).toMatchObject({
      host: "2001:db8::1",
      username: "user",
      password: "p@ss:word",
      port: 8443,
    });
    expect(parseClaudeProxy("[2001:db8::1]:1080:user:secret", "socks5").host).toBe("2001:db8::1");
  });
  it("retains provider passwords containing colons or at signs", () => {
    expect(parseClaudeProxy("proxy.example:8080:user:secret:more").password).toBe("secret:more");
    expect(parseClaudeProxy("http://user:secret@more@proxy.example:8080").password).toBe(
      "secret@more",
    );
  });
  it("offers ambiguous numeric credentials without guessing", () => {
    const value = "proxy.example:8080:user:1234";
    expect(parseClaudeProxyCandidates(value)).toHaveLength(2);
    try {
      parseClaudeProxy(value);
      throw new Error("Expected ambiguity");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeProxyParseError);
      expect((error as ClaudeProxyParseError).candidates).toHaveLength(2);
      expect((error as Error).message).not.toContain(value);
    }
  });
  it.each([
    "",
    "proxy.example:0",
    "proxy.example:65536",
    "http://user:secret@proxy.example:8080/path",
    "proxy.example?secret:8080",
    "proxy.example\\secret:8080",
    "ftp://user:secret@proxy.example:8080",
    "proxy.example:8080\0secret",
  ])("rejects invalid input without echoing credentials", (value) => {
    expect(() => parseClaudeProxy(value)).toThrow(ClaudeProxyParseError);
    try {
      parseClaudeProxy(value);
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
