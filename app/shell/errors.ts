/** Thrown by a page whose data exists but holds no such id: the page "isn't on the site" (10 §10.4). */
export class PageNotFound extends Error {
  constructor(what: string) {
    super(`Not on the site: ${what}`);
    this.name = "PageNotFound";
  }
}
