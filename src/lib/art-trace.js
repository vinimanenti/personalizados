// Traça PNG/JPG/WEBP em SVG no navegador, usando o motor Potrace compilado em WebAssembly.
// Copiado do pacote esm-potrace-wasm 0.5.1 (GPL-2.0): a licença está ao lado do arquivo.
import { potrace, init } from "./vendor/esm-potrace-wasm.js";
import { jpegInfo, removeBackground, buildPalette, labelPixels, smoothLabels, stackLayers, layerMask, buildSvg, otsuThreshold, monoLabels } from "./art-vectorize.mjs";

const MIN_LONG = 2000, MAX_LONG = 3000; // imagens pequenas são ampliadas para o contorno sair mais liso
const nextFrame = () => new Promise(ok => setTimeout(ok));
let ready;

// file (Blob) + { colors, removeBg, widthMM (opcional), dpi, monoColor, threshold } → { svg, colors, wMM, hMM, px, threshold }
// colors = 1: traça só as partes escuras, na cor monoColor; threshold vazio = limite automático.
export async function traceImage(file, { colors = 4, removeBg = false, widthMM = 0, dpi = 300, monoColor = "#000000", threshold = null } = {}) {
  ready ||= init();
  await ready;
  const bmp = await createImageBitmap(file);
  const srcW = bmp.width, srcLong = Math.max(bmp.width, bmp.height);
  const k = Math.min(MAX_LONG, Math.max(MIN_LONG, srcLong)) / srcLong;
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  let data = ctx.getImageData(0, 0, w, h).data;
  if (removeBg) data = removeBackground(data, w, h);
  let labels, layers, limit = null;
  if (colors === 1) {
    limit = threshold ?? otsuThreshold(data);
    labels = smoothLabels(monoLabels(data, w, h, limit), w, h);
    if (!labels.includes(0)) throw new Error("nada ficou mais escuro que o limite; aumente o limite");
    layers = [{ color: monoColor, include: new Set([0]) }];
  } else {
    const palette = buildPalette(data, colors);
    if (!palette.length) throw new Error("a imagem está vazia");
    labels = smoothLabels(labelPixels(data, w, h, palette), w, h);
    layers = stackLayers(labels, palette);
  }
  const turdsize = Math.round((w * h) / 400000) + 2; // ignora manchas menores que isso
  for (const layer of layers) {
    await nextFrame(); // deixa a tela atualizar entre as camadas
    const paths = await potrace(new ImageData(layerMask(labels, layer.include), w, h), { turdsize, turnpolicy: 4, alphamax: 1, opticurve: 1, opttolerance: 0.2, pathonly: true, extractcolors: false });
    layer.d = [].concat(paths).join(" ");
  }
  const wMM = widthMM > 0 ? widthMM : (srcW / dpi) * 25.4;
  const hMM = (wMM * h) / w;
  return { svg: buildSvg(layers, w, h, wMM, hMM), colors: layers.map(l => l.color), layers: layers.map(({ color, d }) => ({ color, d })), wMM, hMM, px: [w, h], threshold: limit };
}

const deflate = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());

// Imagem original para ir por baixo da máscara (modo "só máscara"), no formato do PDF.
// JPG entra como está (sem recompressão); PNG/WEBP viram RGB comprimido, com o alfa como SMask.
export async function pdfImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpg = jpegInfo(bytes);
  if (jpg && [1, 3, 4].includes(jpg.components)) {
    const colorSpace = { 1: "DeviceGray", 3: "DeviceRGB", 4: "DeviceCMYK" }[jpg.components];
    // JPG CMYK (Photoshop/Adobe) vem com os canais invertidos.
    return { w: jpg.w, h: jpg.h, filter: "DCTDecode", colorSpace, decode: jpg.components === 4 ? [1, 0, 1, 0, 1, 0, 1, 0] : null, data: bytes };
  }
  const bmp = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const { width: w, height: h } = bmp;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3), alpha = new Uint8Array(w * h);
  let transparent = false;
  for (let p = 0; p < w * h; p++) {
    rgb[p * 3] = rgba[p * 4]; rgb[p * 3 + 1] = rgba[p * 4 + 1]; rgb[p * 3 + 2] = rgba[p * 4 + 2];
    alpha[p] = rgba[p * 4 + 3];
    if (alpha[p] < 255) transparent = true;
  }
  return { w, h, filter: "FlateDecode", colorSpace: "DeviceRGB", data: await deflate(rgb), smask: transparent ? await deflate(alpha) : null };
}
