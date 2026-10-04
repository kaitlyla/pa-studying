// An in-app link: a real `<a href="#/…">` whose plain click goes through navigate() (and its guard).
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { navigate } from "./route.ts";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
  children?: ReactNode;
}

export function Link({ to, onClick, children, ...rest }: LinkProps): ReactNode {
  const href = to.startsWith("#") ? to : `#${to}`;
  const click = (e: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void navigate(href);
  };
  return (
    <a href={href} onClick={click} {...rest}>
      {children}
    </a>
  );
}
