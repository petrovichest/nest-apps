import { describe, expect, it } from "vitest";
import { typedCommand } from "./command-prompt.js";

const record = (name: string, args?: string) =>
  `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` +
  (args === undefined ? "" : `\n<command-args>${args}</command-args>`);

describe("typedCommand", () => {
  it("gives back a skill typed with a topic and keeps the lines of the topic", () => {
    const topic = "даже еще лучше придумал.\n1. Будем исследовать токены.\n2. Смотрим кошельки.";
    expect(typedCommand(record("grilling", topic))).toBe(`/grilling ${topic}`);
  });

  it.each([
    ["no args tag", record("grilling"), "/grilling"],
    ["an empty args tag", record("grilling", ""), "/grilling"],
    [
      "the tags in the order local commands use",
      "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>",
      "/context",
    ],
    [
      "a namespaced name",
      record("anthropic-skills:docx", "make a letter"),
      "/anthropic-skills:docx make a letter",
    ],
    [
      "indentation around the tags",
      "  <command-message>x</command-message>\n  <command-name>/x</command-name>\n  <command-args>a b</command-args>  ",
      "/x a b",
    ],
  ])("reads %s", (_name, text, expected) => {
    expect(typedCommand(text)).toBe(expected);
  });

  it.each([
    ["ordinary text", "Hello /grilling"],
    ["an empty message", ""],
    [
      "text that only mentions the tags",
      "Why does <command-name>/grilling</command-name> show up here?",
    ],
    [
      "a record followed by other text",
      `${record("grilling", "a")}\n<local-command-stdout>ok</local-command-stdout>`,
    ],
    ["a name without a slash", "<command-name>grilling</command-name>"],
  ])("leaves %s unchanged", (_name, text) => {
    expect(typedCommand(text)).toBe(text);
  });

  it("leaves the hidden attachment block in place for the caller to read", () => {
    const args =
      'topic\n\n<claudenest_attachments>[{"name":"a.txt","path":"/x/a.txt"}]</claudenest_attachments>';
    expect(typedCommand(record("grilling", args))).toBe(`/grilling ${args}`);
  });
});
