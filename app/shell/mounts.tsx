// Where the owner's parts (OB9: 50, 10 §10.7 app side) mount in the reading site.
export { EditControls, EditRegion, openVersions, useIsEditing } from "../edit/EditRegion.tsx";
export { UnsavedDialog } from "../edit/dialogs.tsx";
export { OwnerAvatar, SignInDialog, SignInLink, completeSignInReturn, startAuth } from "../auth/index.ts";

export { AddDocument, DocActions, PendingDocPage, PendingDocs, RemovedDocs, ReplaceFailedNote, UploadProblem } from "../edit/DocActions.tsx";
export type { DocPlace as AddPlace } from "../edit/docs.ts";

export { VersionsPage } from "../edit/VersionsPage.tsx";
