import * as pdfjsLib from 'pdfjs-dist';
import { linesFromTextItems, parseShopeeLabel } from '../../shared/shopee-label.mjs';

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
}

const MAX_SIZE = 30000000;
const MAX_PAGES = 500;

// Reads every page of a Shopee label PDF. Returns { labels: [{ pedido, envio }], pages, missing }.
export async function readShopeeLabels(file) {
  if (file.size > MAX_SIZE) throw new Error(`${file.name}: o PDF deve ter até 30 MB.`);
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }
  catch { throw new Error(`${file.name}: não foi possível abrir o PDF.`); }
  try {
    if (pdf.numPages > MAX_PAGES) throw new Error(`${file.name}: o PDF deve ter até ${MAX_PAGES} páginas.`);
    const labels = [];
    let missing = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const label = parseShopeeLabel(linesFromTextItems((await page.getTextContent()).items).join('\n'));
      if (label) labels.push(label); else missing++;
    }
    return { labels, pages: pdf.numPages, missing };
  } finally { pdf.destroy(); }
}
