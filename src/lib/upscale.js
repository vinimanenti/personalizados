// Ampliação com Real-ESRGAN (feito para imagens reais: limpa JPG, ruído e desfoque leve) no navegador,
// pelo ONNX Runtime Web: usa a placa de vídeo (WebGPU) e, se não houver, o processador (WebAssembly).
// Modelos: public/models (convertidos dos pesos oficiais do Real-ESRGAN, licença BSD-3, ao lado).
import * as ort from "onnxruntime-web/webgpu";
import { planTiles, windowToCHW, pasteCore } from "./upscale-tiles.mjs";

const ORT_VERSION = "1.22.0"; // igual ao package.json
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

export const MODELS = {
  foto: { file: "realesr-general-x4v3.onnx", label: "Foto (Real-ESRGAN)" },
  arte: { file: "realesr-animevideov3.onnx", label: "Arte / ilustração" },
};
const NATIVE = 4; // os dois modelos ampliam 4×; 2× e 3× são reduzidos depois
export const MAX_OUTPUT = 8000; // lado maior do resultado, em px
const nextFrame = () => new Promise(ok => setTimeout(ok));

const sessions = new Map();
let gpuBroken = false; // a placa de vídeo falhou uma vez: daqui para frente usa o processador
function getSession(model) {
  const key = `${model}-${gpuBroken ? "cpu" : "auto"}`;
  if (!sessions.has(key)) {
    const url = `${import.meta.env.BASE_URL}models/${MODELS[model].file}`;
    const p = (async () => {
      if (navigator.gpu && !gpuBroken) {
        try { return { session: await ort.InferenceSession.create(url, { executionProviders: ["webgpu"] }), device: "placa de vídeo" }; }
        catch { /* sem WebGPU utilizável: cai para o processador */ }
      }
      return { session: await ort.InferenceSession.create(url, { executionProviders: ["wasm"] }), device: "processador" };
    })();
    sessions.set(key, p);
    p.catch(() => sessions.delete(key));
  }
  return sessions.get(key);
}

const toBlob = canvas => new Promise((ok, fail) => canvas.toBlob(b => (b ? ok(b) : fail(new Error("não foi possível gerar o PNG"))), "image/png"));
const canvasOf = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

// file → { blob (PNG), w, h, srcW, srcH, ms, device }.
// strength 0..1: mistura com o aumento comum (menos que 1 suaviza halos e exageros da IA).
export async function upscaleImage(file, { model = "foto", scale = 4, strength = 1, onProgress, signal } = {}) {
  if (!MODELS[model]) throw new Error(`modelo ${model} não existe`);
  const bmp = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const srcW = bmp.width, srcH = bmp.height, w = srcW * scale, h = srcH * scale;
  if (Math.max(srcW, srcH) * NATIVE > MAX_OUTPUT) {
    bmp.close();
    throw new Error(`imagem grande demais para ampliar (${srcW} × ${srcH} px); o máximo é ${MAX_OUTPUT / NATIVE} px no lado maior`);
  }
  const src = canvasOf(srcW, srcH), sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = sctx.getImageData(0, 0, srcW, srcH).data;
  let transparent = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { transparent = true; break; }

  const t0 = performance.now();
  const bigW = srcW * NATIVE, bigH = srcH * NATIVE;
  const big = new ImageData(bigW, bigH);
  const tiles = planTiles(srcW, srcH);
  let { session, device } = await getSession(model);
  for (let k = 0; k < tiles.length; k++) {
    if (signal?.aborted) throw new DOMException("cancelado", "AbortError");
    const t = tiles[k];
    const input = new ort.Tensor("float32", windowToCHW(rgba, srcW, t), [1, 3, t.wh, t.ww]);
    let output;
    try {
      ({ output } = await session.run({ input }));
    } catch (e) {
      if (device !== "placa de vídeo") throw e;
      // Erro na placa de vídeo (driver, memória): recomeça este bloco no processador.
      console.warn("Ampliar: placa de vídeo falhou, usando o processador", e);
      gpuBroken = true;
      ({ session, device } = await getSession(model));
      ({ output } = await session.run({ input }));
    }
    pasteCore(big.data, bigW, output.data, t, NATIVE);
    input.dispose?.(); output.dispose?.();
    onProgress?.((k + 1) / tiles.length);
    await nextFrame(); // deixa a tela responder entre os blocos
  }

  // Tamanho final, intensidade e transparência.
  const bigC = canvasOf(bigW, bigH);
  bigC.getContext("2d").putImageData(big, 0, 0);
  const dst = canvasOf(w, h), dctx = dst.getContext("2d", { willReadFrequently: true });
  dctx.imageSmoothingQuality = "high";
  if (strength < 1) {
    dctx.drawImage(src, 0, 0, w, h); // aumento comum por baixo
    dctx.globalAlpha = Math.max(0, strength);
  }
  dctx.drawImage(bigC, 0, 0, w, h);
  dctx.globalAlpha = 1;
  if (transparent) {
    // A IA trabalha só com RGB: a transparência é ampliada à parte (suavizada) e recolocada.
    const a = canvasOf(w, h), actx = a.getContext("2d", { willReadFrequently: true });
    actx.imageSmoothingQuality = "high";
    actx.drawImage(src, 0, 0, w, h);
    const alpha = actx.getImageData(0, 0, w, h).data, img = dctx.getImageData(0, 0, w, h);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = alpha[i];
    dctx.putImageData(img, 0, 0);
  }
  const blob = await toBlob(dst);
  return { blob, w, h, srcW, srcH, ms: Math.round(performance.now() - t0), device };
}
