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

// Subscribe to live model changes (e.g. admin toggling operational flag on
// another computer). Calls onUpdate(dbToModel(row)) whenever any row in the
// `models` table is INSERTed or UPDATEd. Returns the channel so caller can
// unsubscribe on unmount.
//
// Requires Realtime enabled for the table on Supabase:
//   alter publication supabase_realtime add table models;
export function subscribeModels(onUpdate) {
  if (!supabase) return null;
  const channel = supabase
    .channel("models-live-" + Math.random().toString(36).slice(2))
    .on("postgres_changes", { event: "*", schema: "public", table: "models" }, (payload) => {
      console.log("[realtime models] event:", payload.eventType, payload.new?.id);
      try {
        if (payload.eventType === "DELETE") return;
        if (payload.new) onUpdate(dbToModel(payload.new));
      } catch (e) { console.error("realtime models handler:", e); }
    })
    .subscribe((status, err) => {
      console.log("[realtime models] subscription status:", status, err ? `ERROR: ${err.message}` : "");
    });
  return channel;
}

export function unsubscribe(channel) {
  if (supabase && channel) supabase.removeChannel(channel);
}

// Subscribe to live order changes. Callback receives { type, order, id }:
//   type: "insert" | "update" | "delete"
//   order: full order object (insert/update) | null (delete)
//   id: order id (all events)
// Requires:
//   alter publication supabase_realtime add table orders;
//   alter table orders replica identity full;
export function subscribeOrders(onChange) {
  if (!supabase) return null;
  const orderFromRow = (row) => ({
    id: row.id,
    orderCode: row.order_code,
    store: row.store,
    modelId: row.model_id,
    names: row.names,
    fontOverrides: row.font_overrides,
    sheetsCount: row.sheets_count,
    createdAt: row.created_at,
    userId: row.user_id,
  });
  const channel = supabase
    .channel("orders-live-" + Math.random().toString(36).slice(2))
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, (payload) => {
      console.log("[realtime orders] event:", payload.eventType, payload.new?.id || payload.old?.id);
      try {
        if (payload.eventType === "INSERT" && payload.new) {
          onChange({ type: "insert", order: orderFromRow(payload.new), id: payload.new.id });
        } else if (payload.eventType === "UPDATE" && payload.new) {
          onChange({ type: "update", order: orderFromRow(payload.new), id: payload.new.id });
        } else if (payload.eventType === "DELETE" && payload.old) {
          onChange({ type: "delete", order: null, id: payload.old.id });
        }
      } catch (e) { console.error("realtime orders handler:", e); }
    })
    .subscribe((status, err) => {
      console.log("[realtime orders] subscription status:", status, err ? `ERROR: ${err.message}` : "");
    });
  return channel;
}

export async function updateModel(id, updates) {
  if (!supabase) return;
  const row = modelToDb(updates);
  row.id = id;
  const { error } = await supabase.from("models").upsert(row, { onConflict: "id" });
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
  // Cache-bust: Supabase Storage always serves the same public URL per path,
  // so CDN/browser caches can serve a stale SVG after re-upload. Append a
  // timestamp so the user always gets the latest uploaded version.
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(url + sep + "t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to download SVG");
  return res.text();
}

export async function uploadFont(modelId, arrayBuffer, fileName) {
  if (!supabase) return null;
  const ext = fileName.split(".").pop().toLowerCase();
  const path = `fonts/${modelId}.${ext}`;
  const blob = new Blob([arrayBuffer], { type: "font/" + ext });
  const { error } = await supabase.storage
    .from("stickers")
    .upload(path, blob, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("stickers").getPublicUrl(path);
  return data.publicUrl;
}

// ─── Orders ───

export async function createOrder({ orderCode, store, modelId, names, fontOverrides, sheetsCount, userId }) {
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
      user_id: userId || null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function fetchOrders(limit = 50, _opts = {}) {
  if (!supabase) return [];
  // Orders are a SHARED pool — all users (admin or not) see the same list so
  // the pedidos panel is consistent regardless of who uploaded the PDF. The
  // `_opts` argument is accepted for back-compat with existing callers that
  // still pass { userId, isAdmin } but it's intentionally ignored here.
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
    userId: o.user_id,
  }));
}

export async function updateOrder(id, updates) {
  if (!supabase) return;
  const row = {};
  if (updates.fontOverrides !== undefined) row.font_overrides = updates.fontOverrides;
  if (updates.sheetsCount !== undefined) row.sheets_count = updates.sheetsCount;
  if (updates.store !== undefined) row.store = updates.store;
  if (updates.orderCode !== undefined) row.order_code = updates.orderCode;
  const { error } = await supabase.from("orders").update(row).eq("id", id);
  if (error) throw error;
}

export async function deleteOrder(id) {
  if (!supabase) return;
  const { error } = await supabase.from("orders").delete().eq("id", id);
  if (error) throw error;
}

export async function deleteAllOrders() {
  if (!supabase) return;
  const { error } = await supabase.from("orders").delete().not("id", "is", null);
  if (error) throw error;
}

// ─── Print Queue ───

export async function fetchPrintQueue(opts = {}) {
  if (!supabase) return [];
  // Print queue is STRICTLY per-user — each operator sees only their own items
  // so simultaneous work doesn't mix. Admin is NOT privileged here (would break
  // parallel production). Legacy rows with NULL user_id stay hidden; they must
  // be cleaned up manually or re-generated under a real user.
  let q = supabase
    .from("print_queue")
    .select("*")
    .eq("status", "pending")
    .order("position");
  if (opts.userId) {
    q = q.eq("user_id", opts.userId);
  } else {
    // No logged user (shouldn't happen in normal flow) — return nothing rather
    // than leaking everyone else's queue.
    return [];
  }
  const { data, error } = await q;
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
    userId: q.user_id,
  }));
}

export async function addToPrintQueue(items, orderId, userId) {
  if (!supabase) return [];
  // Compute next position scoped to the user so each operator has their own numbering
  let posQuery = supabase
    .from("print_queue")
    .select("position")
    .order("position", { ascending: false })
    .limit(1);
  if (userId) posQuery = posQuery.eq("user_id", userId);
  const { data: existing } = await posQuery;
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
    user_id: userId || null,
  }));
  // Use .select() so the insert returns the inserted rows (with their generated
  // ids and timestamps) — the caller can update local state directly without a
  // second fetchPrintQueue() round-trip that would re-download every SVG already
  // in the queue.
  const { data, error } = await supabase.from("print_queue").insert(rows).select();
  if (error) throw error;
  return (data || []).map(q => ({
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
    userId: q.user_id,
  }));
}

export async function removeFromPrintQueue(id) {
  if (!supabase) return;
  const { error } = await supabase.from("print_queue").delete().eq("id", id);
  if (error) throw error;
}

export async function clearPrintQueue(opts = {}) {
  if (!supabase) return;
  // Strict per-user clear — "Limpar fila" only wipes the caller's items.
  // Without a userId we refuse to clear anything (safer than nuking the pool).
  if (!opts.userId) return;
  const { error } = await supabase
    .from("print_queue")
    .delete()
    .eq("status", "pending")
    .eq("user_id", opts.userId);
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

// ─── Users (stored in Storage as JSON) ───

export async function fetchUsersFromDb() {
  if (!supabase) return null;
  try {
    // Use public URL directly (more reliable across different computers/networks)
    const { data: urlData } = supabase.storage.from("stickers").getPublicUrl("config/users.json");
    const res = await fetch(urlData.publicUrl + "?t=" + Date.now()); // cache-bust
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function saveUsersToDb(users) {
  if (!supabase) return;
  const blob = new Blob([JSON.stringify(users)], { type: "application/json" });
  await supabase.storage.from("stickers").upload("config/users.json", blob, { upsert: true });
}

// ─── Mappers ───

function dbToModel(row) {
  const agm = row.all_glyph_maps || {};
  return {
    id: row.id,
    thumbUrl: row.thumb_url,
    svgUrl: row.svg_url,
    svgUrl2: agm.__svgUrl2 || null,
    svgData: null, // loaded on demand from Storage
    svgData2: null,
    fields: row.fields || [],
    fields2: agm.__fields2 || [],
    textCenters2: agm.__textCenters2 || {},
    fieldFntMap2: agm.__fieldFntMap2 || {},
    fieldSiblings2: agm.__fieldSiblings2 || {},
    fontFamily2: agm.__fontFamily2 || null,
    fontSize2: agm.__fontSize2 || null,
    maxWidth2: agm.__maxWidth2 || null,
    maxWidth: Number(row.max_width) || 3600,
    fontFamily: row.font_family || "DK Coal Brush",
    fontSize: Number(row.font_size) || 715.51,
    fontSource: row.font_source || "default",
    fontUrl: row.font_url || null,
    glyphMap: row.glyph_map || {},
    defaultAdv: row.default_adv || 504,
    textCenters: row.text_centers || {},
    fieldTypes: row.field_types || [],
    fieldPerType: row.field_per_type || {},
    allGlyphMaps: agm,
    displayName: agm.__displayName || null,
    operational: agm.__operational === true, // admin-controlled flag: model is ready for production
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
  if (m.fontUrl !== undefined) row.font_url = m.fontUrl;
  if (m.glyphMap !== undefined) row.glyph_map = m.glyphMap;
  if (m.defaultAdv !== undefined) row.default_adv = m.defaultAdv;
  if (m.textCenters !== undefined) row.text_centers = m.textCenters;
  if (m.fieldTypes !== undefined) row.field_types = m.fieldTypes;
  if (m.fieldPerType !== undefined) row.field_per_type = m.fieldPerType;
  // Piggyback variant 2 data, displayName, and operational flag on all_glyph_maps JSON
  const extraKeys = ["svgUrl2", "fields2", "textCenters2", "fieldFntMap2", "fieldSiblings2", "fontFamily2", "fontSize2", "maxWidth2"];
  const hasExtra = extraKeys.some(k => m[k] !== undefined) || m.displayName !== undefined || m.operational !== undefined || m.allGlyphMaps !== undefined;
  if (hasExtra) {
    const agm = m.allGlyphMaps ? { ...m.allGlyphMaps } : {};
    if (m.displayName !== undefined) agm.__displayName = m.displayName;
    if (m.operational !== undefined) agm.__operational = !!m.operational;
    for (const k of extraKeys) {
      if (m[k] !== undefined) agm["__" + k] = m[k];
    }
    row.all_glyph_maps = agm;
  }
  return row;
}
