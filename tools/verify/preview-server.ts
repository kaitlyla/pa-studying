// The process `startPreview` runs: Vite's preview server for the built site in its working directory, on a
// free port the system picks. It sends that port over IPC once listening; closing the IPC channel closes the
// server, and the process then exits once everything the server started has ended — on Windows Vite runs
// `net use` at startup in this directory, and that child would hold the directory open if killed with Vite.
import type { AddressInfo } from "node:net";
import { preview } from "vite";

const server = await preview({ preview: { port: 0 } });
process.once("disconnect", () => void server.close());
process.send?.({ port: (server.httpServer.address() as AddressInfo).port });
