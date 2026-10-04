// `content/site.json` as the import writes it (20 §20.3).
import type { SiteFile } from "../../lib/content/index.ts";

export const SITE: SiteFile = {
  v: 1,
  name: "PA Studying",
  owner: { login: "kaitlyla", id: 337482200, commitName: "kaitlyla", commitEmail: "337482200+kaitlyla@users.noreply.github.com" },
  repo: "kaitlyla/pa-studying",
  tabs: ["eor", "pance", "labs", "imaging", "ekg", "anatomy", "other"],
  eors: ["em", "fm", "im", "ob", "peds", "psy", "surg"],
  pance: "pance",
  guideNames: { em: "Emergency Medicine", fm: "Family Medicine", im: "Internal Medicine", ob: "OBGYN", peds: "Pediatrics", psy: "Psychiatry", surg: "Surgery", pance: "PANCE / EOC" },
};

export type Log = (line: string) => void;
