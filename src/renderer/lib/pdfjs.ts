import * as pdfjsLib from "pdfjs-dist";
// Bundle the worker locally — no CDN, offline-first (critical rule #7).
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

let workerInitialized = false;

export function initPdfWorker(): void {
  if (workerInitialized) return;
  pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();
  workerInitialized = true;
}

export { pdfjsLib };
export type PDFDocumentProxy = pdfjsLib.PDFDocumentProxy;
export type PDFPageProxy = pdfjsLib.PDFPageProxy;
