// Leitura das artes enviadas no navegador: tamanho natural, prévia, PDF vetorial (SVG/PDF) e a
// máscara de Branco/Verniz pelo contorno (transparência da arte renderizada).
import * as pdfjsLib from "pdfjs-dist";
import { jsPDF } from "jspdf";
import "svg2pdf.js";
import { artKind, svgSizeMM, alphaToStencil } from "./art-upload.mjs";

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;
}

const PT = 72 / 25.4;
const MASK_PX = 2400; // lado maior da máscara (≈ 600 dpi numa arte de 10 cm)
const PNG_DPI = 300;  // medida inicial de PNG/JPG; o operador ajusta

const loadImage = url => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error("imagem inválida")); i.src = url; });
const toDataUrl = (bytes, type) => new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(new Blob([bytes], { type })); });

// Renderiza a arte com transparência num canvas com lado maior = `long`.
async function rasterize(art, long) {
  const scale = long / Math.max(art.w, art.h);
  const W = Math.max(1, Math.round(art.w * scale)), H = Math.max(1, Math.round(art.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (art.kind === "pdf" || art.kind === "svg") {
    const pdf = await pdfjsLib.getDocument({ data: art.pdfBytes.slice() }).promise;
    const page = await pdf.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    // intent "print": não espera requestAnimationFrame (que para com a aba em segundo plano).
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: W / vp0.width }), background: "rgba(0,0,0,0)", intent: "print" }).promise;
  } else {
    ctx.drawImage(await loadImage(art.preview), 0, 0, W, H);
  }
  return canvas;
}

async function svgToPdf(svgText, wMM, hMM) {
  const el = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
  if (el.querySelector("parsererror") || el.nodeName.toLowerCase() !== "svg") throw new Error("SVG inválido");
  const w = wMM * PT, h = hMM * PT;
  const doc = new jsPDF({ unit: "pt", format: [w, h], orientation: w > h ? "landscape" : "portrait" });
  await doc.svg(el, { x: 0, y: 0, width: w, height: h });
  return new Uint8Array(doc.output("arraybuffer"));
}

// Arquivo (bytes) → arte pronta para a folha e o PDF:
// { kind, name, w, h (mm naturais), bytes, pdfBytes (svg/pdf), preview (data URL), stencil, hasText }
export async function prepareArt({ name, type, bytes }) {
  const kind = artKind(name, type);
  if (!kind) throw new Error("Formato não suportado — use PNG, JPG, SVG ou PDF");
  const art = { kind, name, bytes };
  if (kind === "png" || kind === "jpg") {
    art.preview = await toDataUrl(bytes, kind === "png" ? "image/png" : "image/jpeg");
    const img = await loadImage(art.preview);
    art.w = (img.naturalWidth / PNG_DPI) * 25.4;
    art.h = (img.naturalHeight / PNG_DPI) * 25.4;
    art.px = [img.naturalWidth, img.naturalHeight];
  } else if (kind === "svg") {
    const text = new TextDecoder().decode(bytes);
    Object.assign(art, svgSizeMM(text));
    art.hasText = /<text\b/i.test(text);
    art.pdfBytes = await svgToPdf(text, art.w, art.h);
    art.preview = await toDataUrl(bytes, "image/svg+xml");
  } else {
    art.pdfBytes = bytes;
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
    art.w = vp.width / PT; art.h = vp.height / PT;
    art.pages = pdf.numPages;
    art.preview = (await rasterize(art, 900)).toDataURL("image/png");
  }
  // JPG não tem transparência: o Branco/Verniz é sempre o retângulo.
  if (kind !== "jpg") {
    const c = await rasterize(art, MASK_PX);
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    art.stencil = { w: c.width, h: c.height, bits: alphaToStencil(data, c.width, c.height) };
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) opaque++;
    art.coverage = opaque / (c.width * c.height); // ~1 = fundo sem transparência (contorno vira retângulo)
  }
  return art;
}
