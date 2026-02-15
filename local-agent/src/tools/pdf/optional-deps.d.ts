declare module "pdf-parse" {
  interface PDFData {
    numpages: number;
    text: string;
    info: Record<string, any>;
  }
  function pdfParse(buffer: Buffer): Promise<PDFData>;
  export default pdfParse;
}

declare module "pdf-lib" {
  export class PDFDocument {
    static create(): Promise<PDFDocument>;
    static load(data: Uint8Array | Buffer): Promise<PDFDocument>;
    getPageCount(): number;
    getPageIndices(): number[];
    copyPages(src: PDFDocument, indices: number[]): Promise<any[]>;
    addPage(page?: any): any;
    save(): Promise<Uint8Array>;
  }
}
