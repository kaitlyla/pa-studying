// Web Worker entry: the index lives here so loading and querying stay off the page's thread (60 §60.4).
import { serveEngine } from "./engine.ts";

serveEngine(self as unknown as Parameters<typeof serveEngine>[0]);
