// The page for an unknown route or id (10 §10.4).
import type { ReactNode } from "react";
import { Link } from "./Link.tsx";

export function NotOnSite(): ReactNode {
  return (
    <div className="notfound">
      <h1>This page isn't on the site</h1>
      <p>
        <Link to="#/eor">Go to the EOR guides</Link>
      </p>
    </div>
  );
}
