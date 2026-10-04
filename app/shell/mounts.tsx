// Where the owner's parts (OB9: 50, 10 §10.7 app side) mount in the reading site. Each export becomes a
// re-export of OB9's component as its file lands; until then a visitor-equivalent stand-in renders.
import type { ReactNode } from "react";
import type { DocJson, PendingDoc, RemovedDoc } from "../../lib/derive/published.ts";

type C<P> = (props: P) => ReactNode;
const none = (): ReactNode => null;

export { EditControls, EditRegion } from "../edit/EditRegion.tsx";
export { UnsavedDialog } from "../edit/dialogs.tsx";
export { OwnerAvatar, SignInDialog, SignInLink, completeSignInReturn, startAuth } from "../auth/index.ts";

/** Rename / Replace / Remove on a document's page (owner only). */
export const DocActions: C<{ doc: DocJson }> = none;

/** The owner's view of a document still processing or failed (D1, E1). */
export const PendingDocPage: C<{ id: string }> = none;

export type AddPlace = { kind: "other"; section: string } | { kind: "ref"; tab: string };

export const AddDocument: C<{ place: AddPlace; title: string }> = none;

/** "Show removed documents (n)" (owner only). */
export const RemovedDocs: C<{ items: readonly RemovedDoc[] }> = none;

/** Processing / failed entries (owner only). */
export const PendingDocs: C<{ items: readonly PendingDoc[] }> = none;

export const VersionsPage: C<{ pageKey: string }> = none;
