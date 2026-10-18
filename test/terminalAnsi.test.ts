import { describe, expect, test } from "bun:test";
import { renderGridToAnsiAndPlain, type CMUXRenderGrid } from "../src/server/terminalAnsi.js";

describe("renderGridToAnsiAndPlain", () => {
  test("correctly reconstructs ANSI colors and plain text from render_grid", () => {
    const mockGrid: CMUXRenderGrid = {
      rows: 2,
      columns: 40,
      terminal_foreground: "#FFFFFF",
      terminal_background: "#000000",
      styles: [
        { id: 0, foreground: "#FFFFFF", bold: false },
        { id: 1, foreground: "#38BDF8", bold: true },
        { id: 2, foreground: "#34D399", underline: true },
      ],
      row_spans: [
        { row: 0, column: 0, style_id: 1, text: "➜ " },
        { row: 0, column: 2, style_id: 0, text: "git status" },
        { row: 1, column: 0, style_id: 2, text: "On branch main" },
      ],
    };

    const result = renderGridToAnsiAndPlain(mockGrid);
    expect(result.rows).toBe(2);
    expect(result.plainText).toBe("➜ git status\nOn branch main");
    expect(result.ansi).toContain("\x1b[0;1;38;2;56;189;248m➜ ");
    expect(result.ansi).toContain("git status");
    expect(result.ansi).toContain("\x1b[0;4;38;2;52;211;153mOn branch main");
  });

  test("handles gaps between spans by inserting spaces", () => {
    const mockGrid: CMUXRenderGrid = {
      rows: 1,
      columns: 20,
      styles: [{ id: 0, foreground: "#FFFFFF" }],
      row_spans: [
        { row: 0, column: 5, style_id: 0, text: "hello" },
        { row: 0, column: 15, style_id: 0, text: "world" },
      ],
    };

    const result = renderGridToAnsiAndPlain(mockGrid);
    expect(result.plainText).toBe("     hello     world");
  });

  test("integrates scrollback rows prior to viewport rows", () => {
    const mockGrid: CMUXRenderGrid = {
      rows: 1,
      scrollback_rows: 1,
      styles: [{ id: 0, foreground: "#FFFFFF" }],
      scrollback_spans: [{ row: 0, column: 0, style_id: 0, text: "old scrollback line" }],
      row_spans: [{ row: 0, column: 0, style_id: 0, text: "current viewport line" }],
    };

    const result = renderGridToAnsiAndPlain(mockGrid);
    expect(result.plainText).toBe("old scrollback line\ncurrent viewport line");
  });
});
