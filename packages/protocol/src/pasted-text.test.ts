import { describe, expect, it } from "vitest";
import {
  isInlinePaste,
  replacePasteRanges,
  trimPastedMessage,
  validPastedText,
  serializePastedMessage,
  copyPastedMessage,
  sessionTitleSource,
} from "./pasted-text.js";

describe("pasted text", () => {
  it("classifies each event by Unicode characters and line breaks", () => {
    expect(isInlinePaste("я".repeat(50))).toBe(true);
    expect(isInlinePaste("я".repeat(51))).toBe(false);
    expect(isInlinePaste("🚀".repeat(50))).toBe(true);
    expect(isInlinePaste("🚀".repeat(51))).toBe(false);
    for (const newline of ["\n", "\r", "\r\n", "\u2028", "\u2029"])
      expect(isInlinePaste(`a${newline}b`)).toBe(false);
  });
  it("splits a paste around typed characters and preserves separate event identities", () => {
    const ranges = [
      { id: "one", start: 0, end: 5 },
      { id: "two", start: 5, end: 10 },
    ];
    expect(replacePasteRanges(ranges, 2, 2, 1)).toEqual([
      { id: "one", start: 0, end: 2 },
      { id: "one", start: 3, end: 6 },
      { id: "two", start: 6, end: 11 },
    ]);
    expect(replacePasteRanges(ranges, 2, 8, 0)).toEqual([
      { id: "one", start: 0, end: 2 },
      { id: "two", start: 2, end: 4 },
    ]);
  });
  it("normalizes UTF-16 ranges only at the sending boundary", () => {
    expect(
      trimPastedMessage("  🚀abc  ", { inlinePastes: [{ id: "a", start: 2, end: 7 }] }),
    ).toEqual({ input: "🚀abc", inlinePastes: [{ id: "a", start: 0, end: 5 }] });
  });
  it("validates bounds, order, overlaps and blocks without rejecting split IDs", () => {
    expect(
      validPastedText(
        {
          inlinePastes: [
            { id: "a", start: 0, end: 1 },
            { id: "a", start: 2, end: 3 },
          ],
        },
        "abc",
      ),
    ).toBe(true);
    for (const inlinePastes of [
      [{ id: "a", start: -1, end: 2 }],
      [{ id: "a", start: 0, end: 4 }],
      [
        { id: "a", start: 0, end: 2 },
        { id: "b", start: 1, end: 3 },
      ],
    ])
      expect(validPastedText({ inlinePastes }, "abc")).toBe(false);
    expect(
      validPastedText(
        {
          pasteBlocks: [
            { id: "a", text: "one" },
            { id: "a", text: "two" },
          ],
        },
        "",
      ),
    ).toBe(false);
  });
  it("sends the entire context while copy omits presentation labels", () => {
    const pastes = {
      inlinePastes: [{ id: "a", start: 6, end: 9 }],
      pasteBlocks: [{ id: "b", text: "# Original\n```\n42\n```" }],
    };
    const result = serializePastedMessage("Check abc now", pastes);
    expect(result).toContain("Check <pasted_text>abc</pasted_text> now");
    expect(result).toContain("````\n# Original\n```\n42\n```\n````");
    expect(copyPastedMessage("Check abc now", pastes)).toBe(
      "# Original\n```\n42\n```\n\nCheck abc now",
    );
    expect(serializePastedMessage("old message", {})).toBe("old message");
  });
  it("names a session from the typed text first, then attached files and pasted blocks", () => {
    const pastes = {
      inlinePastes: [{ id: "a", start: 6, end: 9 }],
      pasteBlocks: [
        { id: "b", text: "first\nblock" },
        { id: "c", text: "second block" },
      ],
    };
    expect(
      sessionTitleSource("  Check abc now ", pastes, [{ name: "a.pdf" }, { name: "b.csv" }]),
    ).toBe(
      "Check abc now\n\nAttached files: a.pdf, b.csv\n\nPasted text 1:\nfirst\nblock\n\nPasted text 2:\nsecond block",
    );
    expect(sessionTitleSource("Only typed", {})).toBe("Only typed");
    expect(sessionTitleSource("", { pasteBlocks: [{ id: "b", text: "only paste" }] })).toBe(
      "Pasted text 1:\nonly paste",
    );
    expect(sessionTitleSource("  ", {})).toBe("");
  });
});
