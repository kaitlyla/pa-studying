// Plan 99 §99.1 `lib/content/content.test.ts`: splice, members, commit trailers, serialization.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitMessage, parseTrailers } from "./commit.ts";
import { parseFile, serializeFile } from "./files.ts";
import { readContent, writeContent } from "./fs.ts";
import { memberTarget } from "./ids.ts";
import { spliceRows, systemRowOrder, updateStructure } from "./splice.ts";
import type { StructureFile } from "./types.ts";

const r = (n: number): string => `r_${String(n).padStart(10, "0")}`;
const b = (n: number): string => `b_${String(n).padStart(10, "0")}`;

interface Row { id: string; text: string }
const row = (id: string, text: string): Row => ({ id, text });
const ids = (rows: Row[]): string[] => rows.map((x) => x.id);

describe("splice (50 §50.4)", () => {
  const [A, B, C, D, X] = [r(1), r(2), r(3), r(4), r(5)];
  const full = [row(A, "a"), row(B, "b"), row(C, "c"), row(D, "d")];

  it("replaces edited rows and inserts a new row before the edited row following it", () => {
    const edited = [row(B, "b'"), row(X, "x"), row(C, "c")];
    const out = spliceRows(full, [B, C], edited, (x) => x.id);
    expect(out.rows).toEqual([row(A, "a"), row(B, "b'"), row(X, "x"), row(C, "c"), row(D, "d")]);
    expect(out.added).toEqual([X]);
    expect(out.deleted).toEqual([]);
  });

  it("deletes a shown row missing from the edited partial", () => {
    const out = spliceRows(full, [B, C, D], [row(B, "b'"), row(C, "c")], (x) => x.id);
    expect(out.rows).toEqual([row(A, "a"), row(B, "b'"), row(C, "c")]);
    expect(out.deleted).toEqual([D]);
    expect(out.added).toEqual([]);
  });

  it("inserts a new row with no edited row above it before the first edited row following it", () => {
    const out = spliceRows(full, [B, C], [row(X, "x"), row(B, "b"), row(C, "c")], (x) => x.id);
    expect(ids(out.rows)).toEqual([A, X, B, C, D]);
  });

  it("keeps new rows where the deleted partial was when every shown row is deleted", () => {
    const out = spliceRows(full, [B, C], [row(X, "x")], (x) => x.id);
    expect(ids(out.rows)).toEqual([A, X, D]);
    expect(out.deleted).toEqual([B, C]);
  });

  // Orchestrator ruling 2026-10-04 03:16Z: on a topic page the rows of earlier topics are hidden
  // between the shown rows, so a new row goes before the shown row that follows it.
  describe("on a topic page (rows of earlier topics hidden)", () => {
    const [H, A, A2, F, F2, G, Y] = [r(10), r(11), r(12), r(13), r(14), r(15), r(16)];
    const table = [row(H, "h"), row(A, "a"), row(A2, "a2"), row(F, "f"), row(F2, "f2"), row(G, "g")];

    it("puts a row added above the topic's first row after the hidden rows, directly before it", () => {
      const out = spliceRows(table, [H, F, F2], [row(H, "h"), row(X, "x"), row(F, "f"), row(F2, "f2")], (x) => x.id);
      expect(ids(out.rows)).toEqual([H, A, A2, X, F, F2, G]);
      expect(out.added).toEqual([X]);
    });

    it("puts a row added at the end of a topic directly after its last row, before the next topic", () => {
      const out = spliceRows(table, [H, A, A2], [row(H, "h"), row(A, "a"), row(A2, "a2"), row(X, "x")], (x) => x.id);
      expect(ids(out.rows)).toEqual([H, A, A2, X, F, F2, G]);
    });

    it("keeps several adjacent new rows together and in order", () => {
      const out = spliceRows(table, [H, F, F2], [row(H, "h"), row(X, "x"), row(Y, "y"), row(F, "f"), row(F2, "f2")], (x) => x.id);
      expect(ids(out.rows)).toEqual([H, A, A2, X, Y, F, F2, G]);
      expect(out.added).toEqual([X, Y]);
    });

    it("files the new row under the topic it now continues (40 §40.2) and that topic's section", () => {
      const s: StructureFile = {
        v: 1, sections: [{ id: "s1", title: "S1" }, { id: "s2", title: "S2" }], members: { [A]: "s2", [F]: "s1" }, listed: {},
        drugTables: [], pharmSections: [], pharmFiles: [],
      };
      const out = spliceRows(table, [H, F, F2], [row(H, "h"), row(X, "x"), row(F, "f"), row(F2, "f2")], (x) => x.id);
      const block = {
        id: b(1),
        doc: { content: [{ type: "table", attrs: { grid: [50, 50] }, content: out.rows.map((x) => ({ attrs: { id: x.id } })) }] },
      };
      const order = systemRowOrder([block], s, b(1));
      // X now sits after A2, so the nearest topic above it is A (section s2), not the first section.
      expect(updateStructure(s, { order, added: out.added, table: b(1) }).members[X]).toBe("s2");
    });

    // Orchestrator ruling 2026-10-04 04:44Z: saved from F's topic page, a row added above F is
    // recorded as a member of F's topic, so it stays with F instead of continuing A.
    describe("recording rows added above the page's topic (ruling 04:44Z)", () => {
      const s: StructureFile = {
        v: 1, sections: [{ id: "s1", title: "S1" }, { id: "s2", title: "S2" }], members: { [A]: "s2", [F]: "s1", [G]: "s2" }, listed: {},
        drugTables: [], pharmSections: [], pharmFiles: [],
      };

      it("memberTarget reads a row id as a recorded topic and anything else as a section", () => {
        expect(memberTarget(F)).toEqual({ topic: F });
        expect(memberTarget("s1")).toEqual({ section: "s1" });
        expect(memberTarget(b(1))).toEqual({ section: b(1) });
      });

      it("records a row added directly above the topic's first row under that topic", () => {
        const out = updateStructure(s, { order: [H, A, A2, X, F, F2, G], added: [X], table: b(1), topic: F });
        expect(out.members[X]).toBe(F);
      });

      it("keeps the membership when a later save adds another row above it", () => {
        const first = updateStructure(s, { order: [H, A, A2, X, F, F2, G], added: [X], table: b(1), topic: F });
        const second = updateStructure(first, { order: [H, A, A2, Y, X, F, F2, G], added: [Y], table: b(1), topic: F });
        expect(second.members[X]).toBe(F);
        expect(second.members[Y]).toBe(F);
        // A re-save with no new rows leaves both recorded.
        expect(updateStructure(second, { order: [H, A, A2, Y, X, F, F2, G], table: b(1), topic: F }).members).toEqual(second.members);
      });

      it("records only the run directly above the topic: other new rows follow the positional rule", () => {
        const out = updateStructure(s, { order: [H, A, A2, F, F2, X, G], added: [X], table: b(1), topic: F });
        expect(out.members[X]).toBe("s1");
      });

      it("drops a recorded membership when its topic row is deleted", () => {
        const out = updateStructure({ ...s, members: { ...s.members, [X]: F } }, { order: [H, A, A2, X, F2, G], deleted: [F], table: b(1), topic: F2 });
        expect(out.members).not.toHaveProperty(X);
        expect(out.members).not.toHaveProperty(F);
      });

      it("records the row in a system without sections too", () => {
        const flat = { ...s, sections: [], members: {} };
        expect(updateStructure(flat, { order: [H, A, A2, X, F, F2, G], added: [X], table: b(1), topic: F }).members).toEqual({ [X]: F });
      });

      it("refuses a topic missing from the row order", () => {
        expect(() => updateStructure(s, { order: [H, X], added: [X], table: b(1), topic: F })).toThrow(/Topic .* not in the system's row order/);
      });
    });
  });

  it("refuses an edited table holding a row that was not shown, or a row twice", () => {
    expect(() => spliceRows(full, [B], [row(B, "b"), row(D, "d")], (x) => x.id)).toThrow(/not part of the edited table/);
    expect(() => spliceRows(full, [B], [row(B, "b"), row(B, "b")], (x) => x.id)).toThrow(/twice/);
    expect(() => spliceRows(full, [X], [], (x) => x.id)).toThrow(/not in the table/);
  });
});

describe("structure.json members (ruling 2B)", () => {
  const [A, B, C, X, Y] = [r(1), r(2), r(3), r(5), r(6)];
  const P = b(1);
  /** The edited (non-drug) table. */
  const T = b(5);
  const structure: StructureFile = {
    v: 1,
    sections: [{ id: "s1", title: "S1" }, { id: "s2", title: "S2" }],
    members: { [A]: "s1", [B]: "s2", [P]: "s1" },
    listed: { [P]: "Murmurs" },
    drugTables: [{ block: b(9), pharmSection: "antianginals", conditionRows: [B, C] }],
    pharmSections: [{ id: "antianginals", title: "Antianginals", tables: [b(9)], overview: null, lo: null, also: [] }],
    pharmFiles: [],
  };

  it("gives a new row after B the section of B's topic", () => {
    const out = updateStructure(structure, { order: [A, B, X, C], added: [X], table: T });
    expect(out.members[X]).toBe("s2");
  });

  it("gives a plain drug row added to a drug table no section, but a declared condition row one", () => {
    const plain = updateStructure(structure, { order: [B, X, C], added: [X], table: b(9) });
    expect(plain.members).not.toHaveProperty(X);
    const conditions = { ...structure, drugTables: [{ block: b(9), pharmSection: "antianginals", conditionRows: [B, C, X] }] };
    expect(updateStructure(conditions, { order: [B, X, C], added: [X], table: b(9) }).members[X]).toBe("s2");
  });

  it("gives a new first row of the system the first section", () => {
    const out = updateStructure(structure, { order: [Y, A, B], added: [Y], table: T });
    expect(out.members[Y]).toBe("s1");
  });

  it("skips continuation rows (no members key) to find the topic above", () => {
    const out = updateStructure(structure, { order: [A, C, X], added: [X], table: T });
    expect(out.members[X]).toBe("s1");
  });

  it("removes deleted ids from members, listed and conditionRows, and leaves the input untouched", () => {
    const out = updateStructure(structure, { order: [A, C], deleted: [B, P], table: T });
    expect(out.members).toEqual({ [A]: "s1" });
    expect(out.listed).toEqual({});
    expect(out.drugTables[0]?.conditionRows).toEqual([C]);
    expect(structure.members[B]).toBe("s2");
    expect(structure.drugTables[0]?.conditionRows).toEqual([B, C]);
  });

  it("adds no members entry in a system without sections", () => {
    const flat = { ...structure, sections: [], members: {} };
    expect(updateStructure(flat, { order: [A, X], added: [X], table: T }).members).toEqual({});
  });

  it("refuses a new row missing from the row order", () => {
    expect(() => updateStructure(structure, { order: [A], added: [X], table: T })).toThrow(/not in the system's row order/);
  });

  it("resolves across the system's non-drug multi-column tables, but within a drug table only", () => {
    const table = (id: string, rows: string[], cols = 2) => ({
      id,
      doc: { content: [{ type: "table", attrs: { grid: Array(cols).fill(50) }, content: rows.map((x) => ({ attrs: { id: x } })) }] },
    });
    const prose = { id: b(2), doc: { content: [{ type: "paragraph" }] } };
    const blocks = [table(b(5), [A]), prose, table(b(6), [r(7)], 1), table(b(9), [B, C]), table(b(8), [X])];
    expect(systemRowOrder(blocks, structure, b(8))).toEqual([A, X]);
    expect(systemRowOrder(blocks, structure, b(9))).toEqual([B, C]);
  });

  it("resolves the rows of a one-column drug table (40 §40.2: drug tables resolve whatever their column count)", () => {
    const oneCol = { id: b(7), doc: { content: [{ type: "table", attrs: { grid: [100] }, content: [{ attrs: { id: A } }, { attrs: { id: B } }] }] } };
    const s = { ...structure, drugTables: [{ block: b(7), pharmSection: "antianginals", conditionRows: [B] }] };
    expect(systemRowOrder([oneCol], s, b(7))).toEqual([A, B]);
    // The same table as a non-drug table behaves as a prose block and resolves no rows.
    expect(systemRowOrder([oneCol], { ...structure, drugTables: [] }, b(7))).toEqual([]);
  });

  it("resolves no rows for a multi-column table the structure lists by name (it behaves as a prose block)", () => {
    const wide = { id: b(4), doc: { content: [{ type: "table", attrs: { grid: [30, 30, 40] }, content: [{ attrs: { id: A } }, { attrs: { id: B } }] }] } };
    expect(systemRowOrder([wide], structure, b(4))).toEqual([A, B]);
    expect(systemRowOrder([wide], { ...structure, listed: { [b(4)]: "Comparison" } }, b(4))).toEqual([]);
  });
});

describe("commit trailers (50 §50.4)", () => {
  it("writes Kind, Page, Changed and Device for an edit", () => {
    const msg = commitMessage("Edit: Coronary artery disease", {
      kind: "edit", page: `topic:fm:${r(1)}`, changed: [r(1), r(5)], device: "7K3M0Q9XZA",
    });
    expect(msg).toBe(
      "Edit: Coronary artery disease\n\n" +
      "Pa-Studying-Kind: edit\n" +
      `Pa-Studying-Page: topic:fm:${r(1)}\n` +
      `Pa-Studying-Changed: ${r(1)},${r(5)}\n` +
      "Pa-Studying-Device: 7K3M0Q9XZA",
    );
    expect(parseTrailers(msg)).toEqual({ kind: "edit", page: `topic:fm:${r(1)}`, changed: [r(1), r(5)], device: "7K3M0Q9XZA" });
  });

  it("writes Restored-From for a restore and File for a doc-replace", () => {
    const d = `d_${"0".repeat(9)}1`;
    const restore = commitMessage("Restore: Cardiology", { kind: "restore", page: "system:fm:cardiovascular", changed: [b(1)], restoredFrom: "2026-10-04T02:31:00Z" });
    expect(restore).toContain("\nPa-Studying-Restored-From: 2026-10-04T02:31:00Z");
    const replace = commitMessage("Replace: ACLS", { kind: "doc-replace", changed: [d], file: "ACLS 2025.pdf" });
    expect(parseTrailers(replace)).toEqual({ kind: "doc-replace", changed: [d], file: "ACLS 2025.pdf" });
  });

  it("writes only Kind for the import", () => {
    expect(commitMessage("Import her source files", { kind: "import" })).toBe("Import her source files\n\nPa-Studying-Kind: import");
  });

  it("refuses incomplete or malformed trailers", () => {
    expect(() => commitMessage("Edit: x", { kind: "edit", changed: [r(1)], device: "7K3M0Q9XZA" })).toThrow(/Pa-Studying-Page/);
    expect(() => commitMessage("Edit: x", { kind: "edit", page: "p", changed: [r(1)] })).toThrow(/Pa-Studying-Device/);
    expect(() => commitMessage("Edit: x", { kind: "edit", page: "p", device: "7K3M0Q9XZA" })).toThrow(/Pa-Studying-Changed/);
    expect(() => commitMessage("R", { kind: "restore", page: "p", changed: [r(1)] })).toThrow(/Restored-From/);
    expect(() => commitMessage("R", { kind: "restore", page: "p", changed: [r(1)], restoredFrom: "yesterday" })).toThrow(/ISO/);
    expect(() => commitMessage("R", { kind: "doc-replace", changed: [`d_${"0".repeat(10)}`] })).toThrow(/Pa-Studying-File/);
    expect(() => commitMessage("E", { kind: "edit", page: "p", changed: ["row-1"], device: "7K3M0Q9XZA" })).toThrow(/not an id/);
    expect(() => commitMessage("E", { kind: "edit", page: "p", changed: [r(1)], device: "short" })).toThrow(/Crockford/);
    expect(() => commitMessage("E", { kind: "edit", page: "a\nPa-Studying-Kind: import", changed: [r(1)], device: "7K3M0Q9XZA" })).toThrow(/single line/);
    expect(() => commitMessage("two\nlines", { kind: "import" })).toThrow(/single line/);
    expect(() => commitMessage("x", { kind: "push" as never })).toThrow(/Unknown commit kind/);
  });

  it("requires every doc-* commit to list its document's d_ id in Changed", () => {
    const d = `d_${"0".repeat(10)}`;
    for (const kind of ["doc-add", "doc-rename", "doc-remove", "doc-restore", "doc-marker"] as const) {
      expect(() => commitMessage("Doc", { kind, changed: [b(1)] })).toThrow(/needs the document's d_ id/);
      expect(commitMessage("Doc", { kind, changed: [d] })).toContain(`\nPa-Studying-Changed: ${d}`);
    }
    expect(() => commitMessage("Doc", { kind: "doc-replace", changed: [b(1)], file: "x.pdf" })).toThrow(/needs the document's d_ id/);
  });

  it("reads no trailers from a message without a Pa-Studying Kind", () => {
    expect(parseTrailers("Initial commit")).toBeNull();
    expect(parseTrailers("x\n\nPa-Studying-Kind: other")).toBeNull();
  });
});

describe("serialization (20: stable formatting)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pa-content-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const path = `content/guides/fm/cardiovascular/blocks/${b(1)}.json`;
  const block = {
    v: 1, id: b(1), kind: "prose", meta: {},
    doc: { type: "doc", content: [{ type: "paragraph", attrs: { indLeft: 18, marker: { text: "•", font: null, marks: [{ type: "bold" }], tabPt: 18 } },
      content: [{ type: "text", marks: [{ type: "bold" }, { type: "color", attrs: { hex: "1F3864" } }], text: "Stable angina → nitrates, café" }] }] },
  };

  it("rewrites a file read from disk without changes as identical bytes", async () => {
    expect(await writeContent(root, path, block)).toBe(true);
    const disk = join(root, ...path.split("/"));
    const before = await readFile(disk);
    const read = await readContent(root, path);
    expect(await writeContent(root, path, read)).toBe(false);
    const after = await readFile(disk);
    expect(after.equals(before)).toBe(true);
    // Re-serializing the parsed record gives the same bytes even when the file is rewritten.
    await writeFile(disk, serializeFile(path, read), "utf8");
    expect((await readFile(disk)).equals(before)).toBe(true);
  });

  it("stores UTF-8 without BOM, 1-space indent, LF and a trailing newline", async () => {
    await writeContent(root, path, block);
    const bytes = await readFile(join(root, ...path.split("/")));
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(text).toContain("→");
    expect(text).not.toContain("\r");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.split("\n")[1]).toBe(' "v": 1,');
  });

  it("refuses to read a file that is not in canonical form", () => {
    const text = serializeFile(path, block);
    expect(() => parseFile(path, String.fromCharCode(0xfeff) + text)).toThrow(/canonical/);
    expect(() => parseFile(path, text.replace(/\n/g, "\r\n"))).toThrow(/canonical/);
    expect(() => parseFile(path, JSON.stringify(JSON.parse(text), null, 2) + "\n")).toThrow(/canonical/);
    expect(() => parseFile(path, "{")).toThrow(/not JSON/);
    expect(parseFile(path, text)).toEqual(JSON.parse(text));
  });

  describe("a table's ownWidths, stored only when true", () => {
    const tablePath = `content/guides/fm/cardiovascular/blocks/${b(2)}.json`;
    const tableBlock = (extra: Record<string, unknown>) => ({
      v: 1, id: b(2), kind: "table", meta: {},
      doc: { type: "doc", content: [{
        type: "table",
        attrs: { grid: [30, 570], ...extra, borders: { top: null, right: null, bottom: null, left: null, insideH: null, insideV: null }, cellMarginPt: { top: 0, right: 5.4, bottom: 0, left: 5.4 } },
        content: [{ type: "table_row", attrs: { id: r(1) }, content: [{ type: "table_cell", content: [{ type: "paragraph" }] }, { type: "table_cell", content: [{ type: "paragraph" }] }] }],
      }] },
    });
    const attrsIn = (text: string): Record<string, unknown> =>
      (parseFile<{ doc: { content: { attrs: Record<string, unknown> }[] } }>(tablePath, text).doc.content[0] as { attrs: Record<string, unknown> }).attrs;

    it("reads a table saved before the attribute existed, and writes it back unchanged", () => {
      const text = serializeFile(tablePath, tableBlock({}));
      expect(text).not.toContain("ownWidths");
      expect(attrsIn(text).ownWidths).toBeUndefined();
      expect(serializeFile(tablePath, parseFile(tablePath, text))).toBe(text);
    });

    it("stores true after the grid and reads it back", () => {
      const text = serializeFile(tablePath, tableBlock({ ownWidths: true }));
      expect(text).toMatch(/\],\n +"ownWidths": true,\n +"indentPt": 0,/);
      expect(attrsIn(text).ownWidths).toBe(true);
      expect(serializeFile(tablePath, parseFile(tablePath, text))).toBe(text);
    });

    it("drops false on write, and refuses a stored false as not canonical", () => {
      expect(serializeFile(tablePath, tableBlock({ ownWidths: false }))).toBe(serializeFile(tablePath, tableBlock({})));
      const stored = serializeFile(tablePath, tableBlock({ ownWidths: true })).replace(`"ownWidths": true`, `"ownWidths": false`);
      expect(() => parseFile(tablePath, stored)).toThrow(/does not round-trip/);
    });
  });
});
