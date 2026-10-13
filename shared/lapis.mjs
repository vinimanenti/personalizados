// Browser/Node/Deno shared data contract. No network or configuration access.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MISSING = new Set(['não encontrado', 'nao encontrado', 'not found', 'não detectado', 'nao detectado']);
const fold = value => value.normalize('NFC').toLocaleLowerCase('pt-BR');
const missingName = value => MISSING.has(fold(value.trim()));
function validId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Código de pedido inválido.');
  return id;
}
function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Nome inválido.');
  }
  return name.trim().normalize('NFC');
}
function validQuantity(quantity) {
  if (quantity === null || quantity === undefined) return null;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 150) throw new Error('Quantidade deve ser um inteiro entre 1 e 150.');
  return quantity;
}
function titleCase(name) {
  return name.toLocaleLowerCase('pt-BR').replace(/(^|[^\p{L}\p{M}])\p{L}/gu, s => s.toLocaleUpperCase('pt-BR'));
}
function containsName(evidence, name) {
  const escaped = fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])${escaped}($|[^\\p{L}\\p{M}\\p{N}])`, 'u').test(fold(evidence));
}

export function parseOrderCodes(text) {
  if (typeof text !== 'string') throw new Error('Informe os códigos dos pedidos.');
  return [...new Set(text.replace(/^\uFEFF/u, '').split(/[\s,;]+/u).filter(Boolean).map(validId))];
}

export function parseDuokeText(text) {
  if (typeof text !== 'string') throw new Error('Arquivo TXT inválido.');
  const input = text.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');
  const header = /^\s*(?:[=\-*#]+\s*)?(?:PEDIDO|ORDER|ID)(?:\s+(?:N[º°o.]?|C[ÓO]DIGO))?\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9_-]{0,79})(?:\s*[=\-*#]+)?\s*$/gim;
  const matches = [...input.matchAll(header)];
  if (!matches.length) throw new Error('Nenhum bloco PEDIDO: código encontrado no TXT.');
  const seen = new Set();
  return matches.map((match, index) => {
    const id = validId(match[1]);
    if (seen.has(id)) throw new Error('Pedido duplicado no TXT.');
    seen.add(id);
    const body = input.slice(match.index + match[0].length, matches[index + 1]?.index ?? input.length)
      .replace(/^\s*[=\-*]{3,}\s*$/gm, '').replace(/^\s*--- MENSAGENS DO CLIENTE ---\s*$/gim, '').trim();
    const isMissing = missingName(body) || /^(?:pedido\s+)?n[ãa]o encontrado[.!]?$/iu.test(body) ||
      /^\*{3}\s*N[ÃA]O ENCONTRADO\s*\*{3}(?:\s*\((?:Sem mensagens do cliente ou notas com nome|Pedido não localizado no sistema)\))?$/iu.test(body);
    const isError = /^(?:erro|error|falha|timeout)\s*[:\-]/iu.test(body);
    return { id, status: isMissing ? 'not_found' : isError || !body ? 'error' : 'collected', text: isMissing ? '' : body,
      ...(isError || !body ? { error: body || 'Conversa vazia; colete o pedido novamente.' } : {}) };
  });
}

export function normalizeExtraction(raw, orders) {
  const results = Array.isArray(raw) ? raw : raw?.orders;
  if (!Array.isArray(results) || !Array.isArray(orders)) throw new Error('Resposta de extração inválida.');
  const known = new Map();
  for (const order of orders) {
    validId(order.id);
    if (known.has(order.id)) throw new Error('Pedido duplicado.');
    known.set(order.id, order);
  }
  const found = new Map();
  for (const result of results) {
    if (!result || !known.has(result.id) || found.has(result.id)) throw new Error('ID inesperado ou duplicado na extração.');
    const source = known.get(result.id);
    if (source.status !== 'collected') {
      if (!Array.isArray(result.names) || result.names.length || result.status !== (source.status === 'not_found' ? 'not_found' : 'review')) {
        throw new Error('Extração retornou um pedido sem conversa coletada.');
      }
      found.set(result.id, result);
      continue;
    }
    if (!['found', 'not_found', 'review'].includes(result.status) || !Array.isArray(result.names) || result.names.length > 30) {
      throw new Error('Resultado de extração inválido.');
    }
    if (typeof result.reason !== 'string' || result.reason.length > 500) throw new Error('Motivo de extração inválido.');
    if ((result.status === 'not_found' && result.names.length) || (result.status === 'found' && !result.names.length)) {
      throw new Error('Estado de extração incompatível com os nomes.');
    }
    const uniqueNames = new Set();
    const names = result.names.map(item => {
      const name = validName(item?.name);
      if (missingName(name) || uniqueNames.has(fold(name))) throw new Error('Nome ausente ou duplicado na extração.');
      uniqueNames.add(fold(name));
      const evidence = item.evidence;
      if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000 ||
          !source.text.includes(evidence) || !containsName(evidence, name)) throw new Error('Nome sem evidência literal na conversa.');
      const quantity = validQuantity(item.quantity);
      if (quantity !== null && !new RegExp(`(^|[^0-9])${quantity}($|[^0-9])`).test(evidence)) {
        throw new Error('Quantidade sem evidência literal.');
      }
      return { name: titleCase(name), quantity, evidence };
    });
    let reason = result.reason.trim();
    let status = result.status;
    try { if (names.length) toLabelFields({ names, status: 'found' }); }
    catch (error) { status = 'review'; reason = reason ? `${reason} ${error.message}` : error.message; }
    found.set(result.id, { id: result.id, names, status, reason, text: source.text });
  }
  return orders.map(order => {
    if (order.status === 'not_found') return { id: order.id, names: [], status: 'not_found', reason: 'Pedido não encontrado no Duoke.', text: order.text };
    if (order.status === 'error') return { id: order.id, names: [], status: 'review', reason: order.error || 'Falha ao coletar conversa.', text: order.text };
    if (!found.has(order.id)) throw new Error('Pedido ausente na resposta de extração.');
    return found.get(order.id);
  });
}

export function toLabelFields(order) {
  if (!order || order.status === 'not_found' || !Array.isArray(order.names) || !order.names.length) throw new Error('Pedido sem nomes para imprimir.');
  if (order.names.length > 3) throw new Error('Uma cartela comporta no máximo três nomes.');
  const normalized = order.names.map(item => ({ name: validName(item.name), quantity: validQuantity(item.quantity) }));
  if (normalized.some(item => missingName(item.name))) throw new Error('Pedido sem nomes para imprimir.');
  const explicit = normalized.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const absent = normalized.filter(item => item.quantity === null).length;
  if (explicit > 150 || (absent && 150 - explicit < absent)) throw new Error('O total da cartela deve ser no máximo 150 etiquetas.');
  // When mixed, keep explicit counts and distribute the remaining labels evenly.
  const base = absent ? Math.floor((150 - explicit) / absent) : 0;
  let extra = absent ? (150 - explicit) % absent : 0;
  return normalized.map(item => ({ nome: item.name, qty: item.quantity ?? (base + (extra-- > 0 ? 1 : 0)),
    fs: 24, font: 'cookie', emoji: '', emojiPos: 'before' }));
}

function csvCell(value) {
  let cell = String(value ?? '');
  if (/^[\s\uFEFF]*[=+@-]/u.test(cell) || /^[\t\r\n]/u.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/u.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
export function exportNamesCsv(orders) {
  if (!Array.isArray(orders)) throw new Error('Pedidos inválidos.');
  const usedIds = new Set();
  const rows = [['ID', 'Nome']];
  for (const order of orders) {
    const names = Array.isArray(order.names) ? order.names : [];
    if (!names.length && order.status !== 'not_found') throw new Error('Revise os pedidos com erro antes de exportar.');
    const values = names.length ? names.map(item => validName(item.name)) : ['Não Encontrado'];
    values.forEach((name, index) => {
      const id = values.length > 1 ? `${order.id}_${index + 1}` : String(order.id);
      if (usedIds.has(id)) throw new Error('IDs de exportação duplicados.');
      usedIds.add(id);
      rows.push([id, name]);
    });
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function readCsv(text) {
  const clean = text.replace(/^\uFEFF/u, '');
  // Determine delimiter from the header, ignoring quoted content.
  let quoted = false, separator = ',';
  for (let i = 0; i < clean.length && clean[i] !== '\n' && clean[i] !== '\r'; i++) {
    if (clean[i] === '"') { if (quoted && clean[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted && clean[i] === ';') separator = ';';
  }
  const rows = []; let row = [], cell = '', inQuote = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ''; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(value => value.trim())) rows.push(row); row = []; };
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (inQuote) {
      if (char === '"') { if (clean[i + 1] === '"') { cell += '"'; i++; } else { inQuote = false; closed = true; } }
      else cell += char;
    } else if (char === '"') {
      if (cell || closed) throw new Error('Aspas inválidas no CSV.');
      inQuote = true;
    } else if (char === separator) pushCell();
    else if (char === '\r' || char === '\n') { pushRow(); if (char === '\r' && clean[i + 1] === '\n') i++; }
    else if (closed) { if (!/\s/u.test(char)) throw new Error('Conteúdo após aspas no CSV.'); }
    else cell += char;
  }
  if (inQuote) throw new Error('Campo com aspas não fechado no CSV.');
  if (cell || row.length || closed) pushRow();
  return rows;
}
const unprotectCsv = value => /^'[\s\uFEFF]*[=+@-]/u.test(value) || /^'[\t\r\n]/u.test(value) ? value.slice(1) : value;
export function parseNamesCsv(text) {
  if (typeof text !== 'string') throw new Error('Arquivo CSV inválido.');
  const rows = readCsv(text);
  if (!rows.length) return [];
  const headers = rows.shift().map(value => value.trim().toUpperCase().replace(/[\s_-]+/gu, ''));
  const idIndex = headers.indexOf('ID');
  const nameIndexes = headers.includes('NOME1') ? ['NOME1', 'NOME2', 'NOME3'].map(value => headers.indexOf(value)).filter(i => i >= 0) : [headers.indexOf('NOME')];
  if (idIndex < 0 || nameIndexes[0] < 0 || new Set(headers).size !== headers.length) throw new Error('CSV deve conter ID,Nome ou ID,Nome1,Nome2,Nome3.');
  const entries = rows.map(row => {
    if (row.length !== headers.length) throw new Error('Quantidade de colunas inválida no CSV.');
    return { id: validId(unprotectCsv(row[idIndex]).trim()), names: nameIndexes.map(i => unprotectCsv(row[i]).trim()).filter(Boolean) };
  });
  const seen = new Set();
  for (const entry of entries) { if (seen.has(entry.id)) throw new Error('ID duplicado no CSV.'); seen.add(entry.id); }
  const siblings = new Map();
  if (nameIndexes.length === 1 && headers.includes('NOME')) {
    for (const entry of entries) {
      const match = /^(.*)_([1-9][0-9]*)$/u.exec(entry.id);
      if (match) { const list = siblings.get(match[1]) || []; list.push(Number(match[2])); siblings.set(match[1], list); }
    }
  }
  const groups = new Map();
  for (const entry of entries) {
    const match = /^(.*)_([1-9][0-9]*)$/u.exec(entry.id);
    const numbers = match ? siblings.get(match[1]) : null;
    const isSibling = numbers && numbers.length > 1 && !seen.has(match[1]) && numbers.slice().sort((a,b) => a-b).every((n,i) => n === i + 1);
    const id = isSibling ? match[1] : entry.id;
    const order = groups.get(id) || { id, names: [], status: 'not_found', reason: '', text: '' };
    for (const name of entry.names) if (!missingName(name)) order.names.push({ name: validName(name), quantity: null, evidence: '', sequence: isSibling ? Number(match[2]) : 0 });
    if (order.names.length) order.status = 'found';
    groups.set(id, order);
  }
  return [...groups.values()].map(order => {
    order.names = order.names.sort((a, b) => a.sequence - b.sequence).map(({ sequence, ...name }) => name);
    if (order.names.length) { try { toLabelFields(order); } catch (error) { order.status = 'review'; order.reason = error.message; } }
    return order;
  });
}
