import test from "node:test";
import assert from "node:assert/strict";
import { removeBackground, buildPalette, labelPixels, smoothLabels, stackLayers, layerMask, buildSvg, otsuThreshold, monoLabels } from "../src/lib/art-vectorize.mjs";

// Imagem de teste: `paint(x, y)` devolve [r, g, b] ou [r, g, b, a].
const image = (w, h, paint) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a = 255] = paint(x, y);
    d.set([r, g, b, a], (y * w + x) * 4);
  }
  return d;
};
const WHITE = [255, 255, 255], RED = [220, 20, 20];

test("removeBackground apaga o fundo da borda e preserva o branco interno", () => {
  // Quadrado vermelho com um furo branco no centro, sobre fundo branco.
  const d = image(20, 20, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 && !(x >= 9 && x < 11 && y >= 9 && y < 11) ? RED : WHITE));
  const out = removeBackground(d, 20, 20);
  assert.equal(out[3], 0);
  assert.equal(out[(5 * 20 + 5) * 4 + 3], 255);
  assert.equal(out[(10 * 20 + 10) * 4 + 3], 255);
});

test("buildPalette encontra as cores reais e limpa o branco sujo", () => {
  const d = image(40, 40, x => (x < 20 ? [250, 252, 249] : RED));
  const pal = buildPalette(d, 4);
  assert.equal(pal.length, 2);
  assert.ok(pal.some(c => c.join() === "255,255,255"));
  assert.ok(pal.some(c => Math.abs(c[0] - 220) < 2 && Math.abs(c[1] - 20) < 2));
});

test("buildPalette ignora pixels transparentes e aceita imagem vazia", () => {
  assert.deepEqual(buildPalette(image(4, 4, () => [10, 10, 10, 0]), 4), []);
});

test("labelPixels marca transparente como 255", () => {
  const labels = labelPixels(image(2, 1, x => (x ? [0, 0, 0, 0] : RED)), 2, 1, [RED]);
  assert.deepEqual([...labels], [0, 255]);
});

test("smoothLabels remove pixel isolado", () => {
  const w = 5, h = 5, labels = new Uint8Array(w * h);
  labels[12] = 1;
  assert.equal(smoothLabels(labels, w, h)[12], 0);
});

test("stackLayers empilha da maior área para a menor sem deixar frestas", () => {
  const labels = new Uint8Array([0, 0, 0, 1, 255]);
  const layers = stackLayers(labels, [RED, WHITE, [0, 0, 255]]);
  assert.equal(layers.length, 2); // a cor sem pixels sai
  assert.equal(layers[0].color, "#dc1414");
  assert.deepEqual([...layers[0].include].sort(), [0, 1]);
  assert.deepEqual([...layers[1].include], [1]);
  const mask = layerMask(labels, layers[0].include);
  assert.equal(mask[0], 0);      // pinta
  assert.equal(mask[4 * 4], 255); // transparente fica de fora
});

test("buildSvg grava a medida em mm e corrige a escala do Potrace", () => {
  const svg = buildSvg([{ color: "#000000", d: "M0 0" }, { color: "#ffffff", d: "" }], 2000, 1000, 100, 50);
  assert.match(svg, /width="100mm" height="50mm" viewBox="0 0 2000 1000"/);
  assert.match(svg, /translate\(0 1000\) scale\(0\.1 -0\.1\)/);
  assert.equal(svg.match(/<path/g).length, 1);
});

test("otsuThreshold separa escuro de claro e monoLabels marca só o escuro", () => {
  const d = image(10, 1, x => (x < 3 ? [20, 20, 20] : x < 4 ? [0, 0, 0, 0] : [240, 240, 240]));
  const t = otsuThreshold(d);
  assert.ok(t > 20 && t < 240);
  assert.deepEqual([...monoLabels(d, 10, 1, t)], [0, 0, 0, 255, 255, 255, 255, 255, 255, 255]);
});

test("otsuThreshold aceita imagem toda transparente", () => {
  assert.equal(otsuThreshold(image(2, 2, () => [0, 0, 0, 0])), 128);
});

test("pathToPdf converte comandos relativos, repetição implícita e fechamento", async () => {
  const { pathToPdf } = await import("../src/lib/art-vectorize.mjs");
  assert.equal(pathToPdf("M10 20 l5 0 0 5 z m1 1 c1 1 2 2 3 3 1 1 1 1 2 2z"),
    ["10 20 m", "15 20 l", "15 25 l", "h", "11 21 m", "12 22 13 23 14 24 c", "15 25 15 25 16 26 c", "h"].join("\n"));
});

test("buildLayeredPdf põe Branco e Verniz como spot, na ordem, com a silhueta", async () => {
  const { buildLayeredPdf, MASK_DEFAULTS } = await import("../src/lib/art-vectorize.mjs");
  const layers = [{ color: "#ff0000", d: "M0 0 l10 0 0 10 -10 0z" }, { color: "#0000ff", d: "M2 2 l2 0 0 2z" }];
  const pdf = new TextDecoder().decode(buildLayeredPdf(layers, [1, 1], 10, 10, { mask: MASK_DEFAULTS }));
  assert.match(pdf, /\/Separation \/TOYO#200024pc\* \/DeviceCMYK/);
  assert.match(pdf, /\/Separation \/TOYO#200044pc\* \/DeviceCMYK/);
  const body = pdf.slice(pdf.indexOf("stream"), pdf.indexOf("endstream"));
  const iRed = body.indexOf("1 0 0 rg"), iWhite = body.indexOf("/CS1 cs"), iVarnish = body.indexOf("/CS2 cs");
  assert.ok(iRed >= 0 && iRed < iWhite && iWhite < iVarnish);
  assert.equal(body.match(/\/GSOver gs/g).length, 2);
  // xref aponta para o início de cada objeto
  const xref = +pdf.match(/startxref\n(\d+)/)[1];
  const offs = pdf.slice(xref).match(/(\d{10}) 00000 n/g).map(s => +s.slice(0, 10));
  offs.forEach((o, k) => assert.ok(pdf.startsWith(`${k + 1} 0 obj`, o)));
});

test("buildLayeredPdf sem máscara não cria cores spot", async () => {
  const { buildLayeredPdf } = await import("../src/lib/art-vectorize.mjs");
  const pdf = new TextDecoder().decode(buildLayeredPdf([{ color: "#000000", d: "M0 0 l1 0 0 1z" }], [1, 1], 5, 5));
  assert.doesNotMatch(pdf, /Separation|CS1/);
});

test("buildLayeredPdf escala o traçado para ocupar a página toda", async () => {
  const { buildLayeredPdf } = await import("../src/lib/art-vectorize.mjs");
  const pdf = new TextDecoder().decode(buildLayeredPdf([{ color: "#000000", d: "M0 0 l1 0 0 1z" }], [2000, 1200], 84.667, 50.8));
  const [sx, , , sy] = pdf.match(/q\n(\S+) (\S+) (\S+) (\S+) 0 0 cm/).slice(1).map(Number);
  assert.ok(Math.abs(sx * 20000 - 84.667 * 72 / 25.4) < 0.01);
  assert.ok(Math.abs(sy * 12000 - 50.8 * 72 / 25.4) < 0.01);
});

test("buildLayeredPdf com imagem: imagem antes do Branco, sem cores vetorizadas, xref em bytes", async () => {
  const { buildLayeredPdf, MASK_DEFAULTS } = await import("../src/lib/art-vectorize.mjs");
  const { deflateSync } = await import("node:zlib");
  const data = deflateSync(Buffer.from([255, 0, 0, 0, 255, 0])), smask = deflateSync(Buffer.from([255, 0]));
  const layers = [{ color: "#ff0000", d: "M0 0 l10 0 0 10z" }];
  const bytes = buildLayeredPdf(layers, [1, 1], 10, 10, { mask: MASK_DEFAULTS, withColor: false, image: { w: 2, h: 1, filter: "FlateDecode", colorSpace: "DeviceRGB", data, smask } });
  const pdf = Buffer.from(bytes).toString("latin1");
  const body = pdf.slice(pdf.indexOf("stream"), pdf.indexOf("endstream"));
  assert.ok(body.indexOf("/Im1 Do") < body.indexOf("/CS1 cs"));
  assert.doesNotMatch(body, / rg\n/);
  assert.match(pdf, /\/SMask \d+ 0 R/);
  const xref = +pdf.match(/startxref\n(\d+)/)[1];
  pdf.slice(xref).match(/(\d{10}) 00000 n/g).map(s => +s.slice(0, 10)).forEach((o, k) => assert.ok(pdf.startsWith(`${k + 1} 0 obj`, o)));
});

test("jpegInfo lê largura, altura e canais", async () => {
  const { jpegInfo } = await import("../src/lib/art-vectorize.mjs");
  const sof = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0];
  assert.deepEqual(jpegInfo(new Uint8Array(sof)), { h: 32, w: 64, components: 3 });
  assert.equal(jpegInfo(new Uint8Array([0x89, 0x50])), null);
});
