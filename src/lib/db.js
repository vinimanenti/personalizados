import { supabase } from "./supabase";

export const isConnected = () => !!supabase;

// ─── Models ───

export async function fetchModels() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("models")
    .select("*")
    .order("id");
  if (error) throw error;
  return data.map(dbToModel);
}

export async function updateModel(id, updates) {
  if (!supabase) return;
  const row = modelToDb(updates);
  const { error } = await supabase.from("models").update(row).eq("id", id);
  if (error) throw error;
}

// ─── Storage (SVGs & Thumbnails) ───

export async function uploadSvg(modelId, svgText) {
  if (!supabase) return null;
  const path = `svg/${modelId}.svg`;
  const blob = new Blob([svgText], { type: "image/svg+xml" });
  const { error } = await supabase.storage
    .from("stickers")
    .upload(path, blob, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("stickers").getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadThumb(modelId, dataUrl) {
  if (!supabase) return null;
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const ext = blob.type.split("/")[1] || "png";
  const path = `thumbs/${modelId}.${ext}`;
  const { error } = await supabase.storage
    .from("stickers")
    .upload(path, blob, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("stickers").getPublicUrl(path);
  return data.publicUrl;
}

export async function downloadSvg(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to download SVG");
  return res.text();
}

// ─── Orders ───

export async function createOrder({ orderCode, store, modelId, names, fontOverrides, sheetsCount }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("orders")
    .insert({
      order_code: orderCode,
      store,
      model_id: modelId,
      names,
      font_overrides: fontOverrides || {},
      sheets_count: sheetsCount || 0,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function fetchOrders(limit = 50) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(o => ({
    id: o.id,
    orderCode: o.order_code,
    store: o.store,
    modelId: o.model_id,
    names: o.names,
    fontOverrides: o.font_overrides,
    sheetsCount: o.sheets_count,
    createdAt: o.created_at,
  }));
}

// ─── Print Queue ───

export async function fetchPrintQueue() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("print_queue")
    .select("*")
    .eq("status", "pending")
    .order("position");
  if (error) throw error;
  return data.map(q => ({
    id: q.id,
    orderId: q.order_id,
    modelId: q.model_id,
    svg: q.svg_data,
    label: q.label,
    store: q.store,
    orderCode: q.order_code,
    names: q.names,
    status: q.status,
    position: q.position,
    timestamp: new Date(q.created_at).getTime(),
  }));
}

export async function addToPrintQueue(items, orderId) {
  if (!supabase) return;
  const { data: existing } = await supabase
    .from("print_queue")
    .select("position")
    .order("position", { ascending: false })
    .limit(1);
  let pos = existing?.length ? existing[0].position + 1 : 0;

  const rows = items.map((item, i) => ({
    order_id: orderId || null,
    model_id: item.model,
    svg_data: item.svg,
    label: item.label,
    store: item.store,
    order_code: item.orderCode,
    names: item.names,
    position: pos + i,
  }));
  const { error } = await supabase.from("print_queue").insert(rows);
  if (error) throw error;
}

export async function removeFromPrintQueue(id) {
  if (!supabase) return;
  const { error } = await supabase.from("print_queue").delete().eq("id", id);
  if (error) throw error;
}

export async function clearPrintQueue() {
  if (!supabase) return;
  const { error } = await supabase
    .from("print_queue")
    .delete()
    .eq("status", "pending");
  if (error) throw error;
}

export async function markPrinted(ids) {
  if (!supabase) return;
  const { error } = await supabase
    .from("print_queue")
    .update({ status: "printed", printed_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}

// ─── Mappers ───

function dbToModel(row) {
  return {
    id: row.id,
    thumbUrl: row.thumb_url,
    svgUrl: row.svg_url,
    svgData: null, // loaded on demand from Storage
    fields: row.fields || [],
    maxWidth: Number(row.max_width) || 3600,
    fontFamily: row.font_family || "DK Coal Brush",
    fontSize: Number(row.font_size) || 715.51,
    fontSource: row.font_source || "default",
    glyphMap: row.glyph_map || {},
    defaultAdv: row.default_adv || 504,
    textCenters: row.text_centers || {},
  };
}

function modelToDb(m) {
  const row = {};
  if (m.thumbUrl !== undefined) row.thumb_url = m.thumbUrl;
  if (m.svgUrl !== undefined) row.svg_url = m.svgUrl;
  if (m.fields !== undefined) row.fields = m.fields;
  if (m.maxWidth !== undefined) row.max_width = m.maxWidth;
  if (m.fontFamily !== undefined) row.font_family = m.fontFamily;
  if (m.fontSize !== undefined) row.font_size = m.fontSize;
  if (m.fontSource !== undefined) row.font_source = m.fontSource;
  if (m.glyphMap !== undefined) row.glyph_map = m.glyphMap;
  if (m.defaultAdv !== undefined) row.default_adv = m.defaultAdv;
  if (m.textCenters !== undefined) row.text_centers = m.textCenters;
  return row;
}
