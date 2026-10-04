// The abbreviation vocabulary (30 §30.11) from converted table nodes.
import { describe, expect, it } from "vitest";
import { validateFile } from "../../lib/content/index.ts";
import { readVocab } from "./vocab.ts";

const text = (t: string) => ({ type: "text", text: t });
const para = (...inl: unknown[]) => ({ type: "paragraph", content: inl });
const cell = (...paras: unknown[]) => ({ type: "table_cell", content: paras.length ? paras : [para()] });
const row = (...cells: string[]) => ({ type: "table_row", content: cells.map((c) => cell(para(...(c ? [text(c)] : [])))) });
const table = (...rows: unknown[]) => ({ type: "table", content: rows });
const HEAD = row("Abbreviation", "Meaning", "Notes");

describe("readVocab", () => {
  it("pairs every abbreviation with every meaning, split on \" / \", text as written", () => {
    const { vocab, tables, skipped } = readVocab([
      table(HEAD, row("MI", "myocardial infarction", ""), row("≥ / ≤", "greater / less than or equal to", "x"), row("→", "leads to / produces / causes", "chains")),
    ]);
    expect(tables).toBe(1);
    expect(skipped).toBe(0);
    expect(vocab).toEqual({ v: 1, entries: [
      { abbr: ["MI"], meanings: ["myocardial infarction"] },
      { abbr: ["≥", "≤"], meanings: ["greater", "less than or equal to"] },
      { abbr: ["→"], meanings: ["leads to", "produces", "causes"] },
    ] });
    expect(() => validateFile("content/vocab/abbreviations.json", vocab)).not.toThrow();
  });

  it("reads only tables headed Abbreviation, Meaning, Notes, including nested ones, in document order", () => {
    const other = table(row("Contents", "", ""), row("SKIP", "not vocab", ""));
    const nested = table(HEAD, row("Rx", "prescription", ""));
    const outer = table(row("a", "b"), { type: "table_row", content: [cell(nested)] });
    const { vocab, tables } = readVocab([{ type: "paragraph" }, other, outer, table(HEAD, row("dx", "diagnosis", ""))]);
    expect(tables).toBe(2);
    expect(vocab.entries).toEqual([{ abbr: ["Rx"], meanings: ["prescription"] }, { abbr: ["dx"], meanings: ["diagnosis"] }]);
  });

  it("skips and counts rows with an empty abbreviation or meaning cell", () => {
    const { vocab, skipped } = readVocab([table(HEAD, row("", "orphan meaning", ""), row("HTN", " ", ""), row("q / ", "every", ""), { type: "table_row", content: [cell()] })]);
    expect(skipped).toBe(3);
    expect(vocab.entries).toEqual([{ abbr: ["q"], meanings: ["every"] }]);
  });

  it("reads a cell's paragraphs and hard breaks as line breaks, which trimming keeps inside a piece", () => {
    const multi = { type: "table_row", content: [cell(para(text("BP")), para(text("bp"))), cell(para(text("blood"), { type: "hard_break" }, text("pressure"))), cell()] };
    expect(readVocab([table(HEAD, multi)]).vocab.entries).toEqual([{ abbr: ["BP\nbp"], meanings: ["blood\npressure"] }]);
  });

  it("does not treat a header with extra columns as a vocabulary table", () => {
    expect(readVocab([table(row("Abbreviation", "Meaning", "Notes", "Extra"), row("a", "b", "", ""))]).tables).toBe(0);
  });
});
