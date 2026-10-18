/**
 * Terminal ANSI Reconstruction Engine
 * Converts cmux's 24-bit RGB render_grid into canonical ANSI escape sequences
 * compatible with xterm.js, retaining bold, italic, underline, and truecolor.
 */

export interface RenderGridStyle {
  id: number;
  foreground?: string;
  background?: string;
  foreground_source?: string;
  background_source?: string;
  bold?: boolean;
  faint?: boolean;
  italic?: boolean;
  underline?: boolean;
  blink?: boolean;
  inverse?: boolean;
  invisible?: boolean;
}

export interface RenderGridSpan {
  row: number;
  column: number;
  style_id: number;
  text: string;
  cell_width?: number;
}

export interface CMUXRenderGrid {
  format?: string;
  rows?: number;
  columns?: number;
  scrollback_rows?: number;
  cursor?: {
    row: number;
    column: number;
    visible?: boolean;
    style?: string;
    blinking?: boolean;
  };
  styles?: RenderGridStyle[];
  row_spans?: RenderGridSpan[];
  scrollback_spans?: RenderGridSpan[];
  terminal_foreground?: string;
  terminal_background?: string;
}

export interface RenderGridResult {
  ansi: string;
  plainText: string;
  columns: number;
  rows: number;
  cursor?: {
    row: number;
    column: number;
    visible?: boolean;
  };
}

function hexToRgb(
  hex: string | undefined,
  defaultRgb: [number, number, number]
): [number, number, number] {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#") || hex.length < 7) {
    return defaultRgb;
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return defaultRgb;
  return [r, g, b];
}

function styleToAnsi(
  style: RenderGridStyle | undefined,
  defaultFg: [number, number, number],
  defaultBg: [number, number, number]
): string {
  if (!style) return "\x1b[0m";

  let fgHex = style.foreground;
  let bgHex = style.background;
  if (style.inverse) {
    const tmp = fgHex;
    fgHex = bgHex;
    bgHex = tmp;
  }

  const fg = hexToRgb(fgHex, defaultFg);
  const bg = hexToRgb(bgHex, defaultBg);

  const codes: string[] = ["0"];
  if (style.bold) codes.push("1");
  if (style.faint) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");

  codes.push(`38;2;${fg[0]};${fg[1]};${fg[2]}`);

  if (style.inverse || (style.background_source && style.background_source !== "default")) {
    codes.push(`48;2;${bg[0]};${bg[1]};${bg[2]}`);
  }

  return `\x1b[${codes.join(";")}m`;
}

function renderSpansToRows(
  spans: RenderGridSpan[],
  rowCount: number,
  stylesById: Map<number, RenderGridStyle>,
  defaultFg: [number, number, number],
  defaultBg: [number, number, number]
): { ansiRows: string[]; plainRows: string[] } {
  const spansByRow = new Map<number, RenderGridSpan[]>();
  for (const span of spans) {
    let list = spansByRow.get(span.row);
    if (!list) {
      list = [];
      spansByRow.set(span.row, list);
    }
    list.push(span);
  }

  const ansiRows: string[] = [];
  const plainRows: string[] = [];

  for (let r = 0; r < rowCount; r++) {
    const rowSpans = (spansByRow.get(r) || []).sort((a, b) => a.column - b.column);
    let ansiLine = "";
    let plainLine = "";
    let occupiedCol = 0;

    for (const span of rowSpans) {
      if (occupiedCol < span.column) {
        const gap = span.column - occupiedCol;
        ansiLine += "\x1b[0m" + " ".repeat(gap);
        plainLine += " ".repeat(gap);
        occupiedCol = span.column;
      }
      const style = stylesById.get(span.style_id);
      ansiLine += styleToAnsi(style, defaultFg, defaultBg);
      ansiLine += span.text;
      plainLine += span.text;
      occupiedCol = span.column + (span.cell_width ?? span.text.length);
    }
    ansiLine += "\x1b[0m";
    ansiRows.push(ansiLine);
    plainRows.push(plainLine);
  }

  return { ansiRows, plainRows };
}

/**
 * Converts a cmux render_grid object into canonical colored ANSI string + plain text string.
 */
export function renderGridToAnsiAndPlain(
  grid: CMUXRenderGrid,
  maxScrollbackLines = 150
): RenderGridResult {
  const defaultFg = hexToRgb(grid.terminal_foreground, [255, 255, 255]);
  const defaultBg = hexToRgb(grid.terminal_background, [0, 0, 0]);

  const stylesById = new Map<number, RenderGridStyle>();
  if (Array.isArray(grid.styles)) {
    for (const st of grid.styles) {
      stylesById.set(st.id, st);
    }
  }

  const viewportRowCount = grid.rows || 40;
  const viewportResult = renderSpansToRows(
    grid.row_spans || [],
    viewportRowCount,
    stylesById,
    defaultFg,
    defaultBg
  );

  let finalAnsiRows = viewportResult.ansiRows;
  let finalPlainRows = viewportResult.plainRows;

  // Add scrollback if present
  const scrollbackRowCount = grid.scrollback_rows || 0;
  if (scrollbackRowCount > 0 && Array.isArray(grid.scrollback_spans) && grid.scrollback_spans.length > 0) {
    const scrollbackResult = renderSpansToRows(
      grid.scrollback_spans,
      scrollbackRowCount,
      stylesById,
      defaultFg,
      defaultBg
    );
    const retainedScrollbackAnsi = scrollbackResult.ansiRows.slice(-maxScrollbackLines);
    const retainedScrollbackPlain = scrollbackResult.plainRows.slice(-maxScrollbackLines);

    finalAnsiRows = [...retainedScrollbackAnsi, ...finalAnsiRows];
    finalPlainRows = [...retainedScrollbackPlain, ...finalPlainRows];
  }

  // Trim trailing empty lines at the very end if too many
  while (finalPlainRows.length > 0 && finalPlainRows[finalPlainRows.length - 1].trim() === "") {
    finalPlainRows.pop();
    finalAnsiRows.pop();
  }

  return {
    ansi: finalAnsiRows.join("\r\n"),
    plainText: finalPlainRows.join("\n"),
    columns: grid.columns || 80,
    rows: viewportRowCount,
    cursor: grid.cursor,
  };
}
