// pdfmake 0.3.11 ships no type declarations. These cover the calls lib/pdf, app/pdf and tools/pdf
// make; document definitions are typed by lib/pdf/types.ts.

declare module "pdfmake/build/pdfmake.js" {
  const pdfMake: {
    fonts: Record<string, Record<string, string>>;
    createPdf(def: object): { download(fileName?: string): Promise<void>; getBuffer(): Promise<Uint8Array> };
  };
  export default pdfMake;
}

declare module "pdfmake" {
  const pdfMake: {
    fonts: Record<string, Record<string, string>>;
    setUrlAccessPolicy(policy: (url: string) => boolean): void;
    setLocalAccessPolicy(policy: (path: string) => boolean): void;
    createPdf(def: object): { getBuffer(): Promise<Buffer> };
  };
  export default pdfMake;
}
