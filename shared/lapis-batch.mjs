export const MAX_BATCH_ORDERS = 500;
export const MAX_BATCH_FILE_BYTES = 24_000_000;

export const hasNames = result => Boolean(result?.names?.some(entry => entry.name.trim()));
export const canExtract = source => source?.status === 'collected' && Boolean(source.text?.trim()) && source.text.length <= 12000;

export function orderBucket(source, result, extractionError) {
  // Manual corrections and imported names must never be retried automatically.
  if (hasNames(result)) return 'names';
  if (extractionError || source.status === 'error' || (!result && source.status === 'collected' && !canExtract(source))) return 'errors';
  if (source.status === 'not_found' || result) return 'missing';
  return 'waiting';
}

export function planBatch(draft, codes, { retry = false } = {}) {
  const unique = [...new Set(codes)];
  if (!unique.length) throw new Error('Informe pelo menos um pedido.');
  if (new Set([...draft.collected.map(order => order.id), ...unique]).size > MAX_BATCH_ORDERS) {
    throw new Error('O limite é de 500 pedidos por revisão. Exporte ou limpe o lote atual antes de continuar.');
  }
  const known = new Map(draft.collected.map(order => [order.id, order]));
  const pending = unique.filter(id => !hasNames(draft.results[id]));
  return {
    codes: pending,
    collect: pending.filter(id => retry || !canExtract(known.get(id))),
    sources: pending.map(id => known.get(id) || { id, status: 'error', text: '', error: 'Coleta ainda não concluída. Retome o lote para buscar este pedido.' }),
  };
}

export function mergeCollected(draft, orders) {
  const map = new Map(draft.collected.map(order => [order.id, order]));
  const results = Object.assign(Object.create(null), draft.results);
  const selected = Object.assign(Object.create(null), draft.selected);
  const reviewed = Object.assign(Object.create(null), draft.reviewed);
  const extractionErrors = Object.assign(Object.create(null), draft.extractionErrors);
  for (const order of orders) {
    map.set(order.id, order);
    delete results[order.id]; delete reviewed[order.id]; delete extractionErrors[order.id];
    selected[order.id] = canExtract(order);
  }
  return { ...draft, collected: [...map.values()], results, selected, reviewed, extractionErrors };
}

// Conversations already exist in collected. Do not store a second copy per result
// or keep the pasted import text after it has been parsed.
export function compactDraft(draft) {
  return { ...draft, raw: '', reviewed: {}, results: Object.fromEntries(
    Object.entries(draft.results).map(([id, { text, ...result }]) => [id, result])
  ) };
}
