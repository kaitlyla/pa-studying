// Entry: finish a sign-in return before the first route render (10 §10.7), start the owner check,
// then render the site.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TEXT_STACK } from "./render/styles.ts";
import { App } from "./shell/App.tsx";
import { completeSignInReturn, startAuth } from "./shell/mounts.tsx";
import "./styles.css";

async function boot(): Promise<void> {
  // The notes font stack comes from the one font list (lib/fonts.ts) rather than a copy in CSS.
  document.documentElement.style.setProperty("--text-stack", TEXT_STACK);
  await completeSignInReturn();
  startAuth();
  const root = document.getElementById("root");
  if (!root) throw new Error("index.html has no #root");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
