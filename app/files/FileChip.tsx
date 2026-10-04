// File chips and file lists (40 §40.8 places that list documents). Every chip opens the File page with
// `?from=` set to the route it was opened from (40 §40.3).
import type { ReactNode } from "react";
import type { DocList, DocRef } from "../../lib/derive/published.ts";
import { Txt } from "../render/Text.tsx";
import { Link } from "../shell/Link.tsx";
import { PendingDocs, RemovedDocs } from "../shell/mounts.tsx";
import { fileHash, stripQuery, useRoute } from "../shell/route.ts";

const KIND_LABEL: Record<string, string> = { pdf: "PDF", word: "DOC", image: "IMG", slides: "PPT" };

export function FileChip({ file }: { file: DocRef }): ReactNode {
  const route = useRoute();
  return (
    <Link to={fileHash(file.id, stripQuery(route.path))} className="fchip">
      <span className={`ftype ${file.kind}`}>{KIND_LABEL[file.kind] ?? file.kind.toUpperCase()}</span>
      <span>
        <b>
          <Txt text={file.name} />
        </b>
      </span>
    </Link>
  );
}

/** The visible files as chips, then the owner-only removed and pending lists. */
export function FileChips({ list }: { list: DocList }): ReactNode {
  return (
    <>
      {list.files.length > 0 && (
        <div className="fchips">
          {list.files.map((f) => (
            <FileChip key={f.id} file={f} />
          ))}
        </div>
      )}
      <PendingDocs items={list.pending} />
      <RemovedDocs items={list.removed} />
    </>
  );
}
