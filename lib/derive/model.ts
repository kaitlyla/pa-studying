// The loaded content tree the derivations read (tools/build fills it through lib/content).
import type {
  AsIsFile, BlockFile, CardsFile, ChecksFile, ConceptsFile, DeckFile, EvidenceFile, FileText, FlagsFile, GapFile,
  GeneralFile, GuideFile, OtherFile, PharmFile, RefTabsFile, SiteFile, SlideMeta, StructureFile, SystemFile, TrimsFile,
  UsesFile, VocabFile, WordDocFile,
} from "../content/types.ts";

export interface SystemData {
  file: SystemFile;
  structure: StructureFile;
  blocks: BlockFile[];
  /** Topic id → the block she added below that topic (`below/<topic>.json`). */
  below: Map<string, BlockFile>;
}

export interface GuideData {
  file: GuideFile;
  preamble: BlockFile[];
  /** EOR guides only. */
  general: GeneralFile | null;
  systems: SystemData[];
}

/** A document: a Word page (blocks absent once removed) or an as-is file (text from `text.json`). */
export type DocData =
  | { kind: "word"; file: WordDocFile; blocks: BlockFile[] }
  | { kind: "file"; file: AsIsFile; text: FileText | null };

export interface PharmData {
  file: PharmFile;
  blocks: BlockFile[];
}

export interface GapData {
  block: GapFile;
  evidence: EvidenceFile | null;
}

export interface DeckData {
  file: DeckFile;
  slides: BlockFile<SlideMeta>[];
}

export interface Content {
  site: SiteFile;
  vocab: VocabFile;
  /** EOR guides in picker order, then PANCE. */
  guides: GuideData[];
  cards: CardsFile;
  trims: TrimsFile;
  uses: UsesFile;
  pharm: PharmData[];
  docs: Map<string, DocData>;
  gaps: Map<string, GapData>;
  /** guide id → its deck */
  decks: Map<string, DeckData>;
  reftabs: RefTabsFile;
  other: OtherFile;
  flags: FlagsFile;
  concepts: ConceptsFile;
  checks: ChecksFile;
}
