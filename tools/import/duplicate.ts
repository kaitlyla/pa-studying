// Proof that a skipped Word file is an exact duplicate of an imported one (30 §30.2, helpfiles/dupes).
import { unzipSync } from "fflate";
import { extract, type Atoms } from "../verify/extract.ts";

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of every `word/media/*` part, sorted. */
async function mediaHashes(bytes: Uint8Array): Promise<string[]> {
  const entries = unzipSync(bytes, { filter: (f) => f.name.startsWith("word/media/") });
  return (await Promise.all(Object.values(entries).map(sha256))).sort();
}

/**
 * Throws unless the two packages have identical ordered paragraph texts (the §30.13 atoms, story by
 * story) and identical media sets by SHA-256.
 */
export async function proveDuplicate(dupPath: string, dup: Uint8Array, keptPath: string, kept: Uint8Array): Promise<void> {
  const [a, b] = await Promise.all([extract(dup), extract(kept)]);
  const texts = (atoms: Atoms): string => JSON.stringify(atoms.stories.map((s) => s.paragraphs.map((p) => p.text)));
  if (texts(a) !== texts(b)) throw new Error(`${dupPath} is not a duplicate of ${keptPath}: their paragraph texts differ`);
  const [ma, mb] = await Promise.all([mediaHashes(dup), mediaHashes(kept)]);
  if (JSON.stringify(ma) !== JSON.stringify(mb)) throw new Error(`${dupPath} is not a duplicate of ${keptPath}: their pictures differ`);
}
