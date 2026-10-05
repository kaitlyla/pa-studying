// Rendering of stored rich text (plan 40 §40.6) and the content labels (40 §40.7).
export { RichDoc, assetUrl, localAssetOf, setLocalAssets, type LocalAsset, inlineText, withMarks, DIVIDER_RE, LEAD_LABEL_RE, type RichDocProps, type PMNode } from "./RichDoc.tsx";
export { Drawing, type Shape } from "./Drawing.tsx";
export {
  em,
  borderCss,
  cssBorderStyle,
  paragraphStyle,
  markerStyle,
  runStyle,
  underlineStyle,
  tableColumns,
  cellStyle,
  imageStyle,
  imageTransform,
  textboxStyle,
  anchoredOffset,
  ruleStyle,
  fontStack,
  TEXT_STACK,
} from "./styles.ts";
export { layoutTable, selectRows } from "./tableLayout.ts";
export { GapBlock, GapChip, UpdChip, UpdateNote, UpdateNotes, ReviewSlidesBadge, GAP_BASE_PT } from "./labels.tsx";
