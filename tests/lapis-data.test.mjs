import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderCodes, parseDuokeText, parseNamesCsv, normalizeExtraction, exportNamesCsv, toLabelFields } from '../shared/lapis.mjs';

const source = { id: 'ID26011677W2HSBD', status: 'collected', text: 'Bom dia, o nome é Abimmael e abinaelle 75 cada' };
const extracted = { id: source.id, status: 'found', reason: '', names: [
  { name: 'Abimmael', quantity: 75, evidence: source.text },
  { name: 'abinaelle', quantity: 75, evidence: source.text },
] };
const order = names => ({ id: 'PED123', names: names.map(name => typeof name === 'string' ? { name, quantity: null, evidence: '' } : name), status: 'found', reason: '', text: '' });

test('order codes validate and deduplicate without changing IDs', () => {
  assert.deepEqual(parseOrderCodes('ABC123\nDEF456, ABC123;GHI789'), ['ABC123', 'DEF456', 'GHI789']);
  assert.throws(() => parseOrderCodes('ABC123 invalid!'));
  assert.deepEqual(parseOrderCodes(''), []);
});
test('legacy TXT preserves names, accents, order IDs and missing/error states', () => {
  const separator = '='.repeat(30);
  const fixture = `${separator}\nPEDIDO: ID2601179853K7H9\n${separator}\n--- MENSAGENS DO CLIENTE ---\nBenício Soares\nNota\n\n` +
    `${separator}\nPEDIDO: ${source.id}\n${separator}\n--- MENSAGENS DO CLIENTE ---\n${source.text}\n\n` +
    `${separator}\nPEDIDO: ABC123\n${separator}\n*** NÃO ENCONTRADO ***\n(Sem mensagens do cliente ou notas com nome)\n` +
    `${separator}\nPEDIDO: ABC456\n${separator}\nERRO: Tempo esgotado\n`;
  const parsed = parseDuokeText(fixture);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].text, 'Benício Soares\nNota');
  assert.equal(parsed[1].text, source.text);
  assert.equal(parsed[2].status, 'not_found');
  assert.equal(parsed[3].status, 'error');
  assert.throws(() => parseDuokeText('Conversa sem pedido'));
  assert.throws(() => parseDuokeText('PEDIDO: ABC123\nNome\nPEDIDO: ABC123\nNome'));
});
test('literal extraction keeps explicit 75/75 and Title Case', () => {
  const [result] = normalizeExtraction({ orders: [extracted] }, [source]);
  assert.deepEqual(result.names.map(item => item.name), ['Abimmael', 'Abinaelle']);
  assert.deepEqual(toLabelFields(result).map(item => item.qty), [75, 75]);
  assert.equal(result.id, source.id);
});
test('single, sibling, three-name and mixed explicit quantities share one page', () => {
  assert.deepEqual(toLabelFields(order(['Ana'])).map(x => x.qty), [150]);
  assert.deepEqual(toLabelFields(order(['Ana', 'Bia'])).map(x => x.qty), [75, 75]);
  assert.deepEqual(toLabelFields(order(['Ana', 'Bia', 'Cris'])).map(x => x.qty), [50, 50, 50]);
  assert.deepEqual(toLabelFields(order([{name:'Ana',quantity:100}, {name:'Bia',quantity:null}])).map(x => x.qty), [100, 50]);
  assert.deepEqual(toLabelFields(order([{name:'Ana',quantity:49}, {name:'Bia',quantity:null}, {name:'Cris',quantity:null}])).map(x => x.qty), [49, 51, 50]);
  assert.deepEqual(toLabelFields(order([{name:'Ana',quantity:20}])).map(x => x.qty), [20]);
});
test('invalid quantities, oversized totals and four names fail before printing', () => {
  for (const quantity of [0, -1, 1.5, 151, '75', NaN]) assert.throws(() => toLabelFields(order([{name:'Ana',quantity}])));
  assert.throws(() => toLabelFields(order([{name:'Ana',quantity:100}, {name:'Bia',quantity:75}])));
  assert.throws(() => toLabelFields(order(['Ana','Bia','Cris','Dora'])));
  assert.throws(() => toLabelFields(order(['Não Encontrado'])));
});
test('rejects invented IDs, duplicate/missing orders, names and nonliteral evidence', () => {
  assert.throws(() => normalizeExtraction([{...extracted,id:'UNKNOWN'}], [source]));
  assert.throws(() => normalizeExtraction([extracted,extracted], [source]));
  assert.throws(() => normalizeExtraction([], [source]));
  for (const item of [ {name:'Inventado',quantity:null,evidence:source.text}, {name:'Abimmael',quantity:null,evidence:'nome é Abimmael.'},
    {name:'Abimmael',quantity:null,evidence:''}, {name:'Abimmael',quantity:50,evidence:source.text}, {name:'Abimmael',quantity:0,evidence:source.text} ]) {
    assert.throws(() => normalizeExtraction([{...extracted,names:[item]}], [source]));
  }
  assert.throws(() => normalizeExtraction([{...extracted,names:[{name:'Ana',quantity:null,evidence:'Banana'}]}], [{...source,text:'Banana'}]));
});
test('preserves hyphens and accents from literal source', () => {
  const text = 'Nome para etiquetas: ANA-CLARA D’ÁVILA';
  const [result] = normalizeExtraction([{...extracted,names:[{name:'ana-clara d’ávila',quantity:null,evidence:text}]}], [{...source,text}]);
  assert.equal(result.names[0].name, 'Ana-Clara D’Ávila');
});
test('too many names or excessive aggregate stay available for review', () => {
  const text = 'Ana Bia Cris Dora 100 cada';
  const names = ['Ana','Bia','Cris','Dora'].map(name => ({name,quantity:100,evidence:text}));
  const [result] = normalizeExtraction([{...extracted,names}], [{...source,text}]);
  assert.equal(result.status, 'review'); assert.equal(result.names.length, 4);
  assert.throws(() => toLabelFields(result));
});
test('source missing and collection errors remain different, normalized output revalidates', () => {
  const orders = [source, {id:'MISSING',status:'not_found',text:''}, {id:'FAILED',status:'error',text:'',error:'Tempo esgotado'}];
  const result = normalizeExtraction([extracted], orders);
  assert.deepEqual(result.map(x => x.status), ['found','not_found','review']);
  assert.deepEqual(normalizeExtraction({orders:result}, orders), result);
  assert.throws(() => exportNamesCsv(result));
});
test('CSV emits BOM, exactly ID,Nome, escaped names and original sibling source ID on import', () => {
  const original = order(['João "Junior", Silva','Ana-Clara']);
  const csv = exportNamesCsv([original, {id:'MISSING',names:[],status:'not_found'}]);
  assert.ok(csv.startsWith('\uFEFFID,Nome\r\n'));
  assert.ok(csv.includes('PED123_1,"João ""Junior"", Silva"'));
  assert.ok(csv.includes('MISSING,Não Encontrado'));
  const parsed = parseNamesCsv(csv);
  assert.equal(parsed[0].id, original.id);
  assert.deepEqual(parsed[0].names.map(x=>x.name), original.names.map(x=>x.name));
  assert.deepEqual(toLabelFields(parsed[0]).map(x=>x.qty), [75,75]);
  assert.equal(parsed[1].status, 'not_found');
});
test('CSV supports legacy three columns, semicolons, quotes and lone suffix IDs', () => {
  const [a,b] = parseNamesCsv('ID;Nome1;Nome2;Nome3\r\nORDER1;Benício Soares;"Ana, Bia";\r\nORDER_1;João;;');
  assert.equal(a.names[1].name, 'Ana, Bia'); assert.equal(b.id, 'ORDER_1');
  assert.deepEqual(toLabelFields(a).map(x=>x.qty), [75,75]);
  assert.throws(() => parseNamesCsv('ID,Nome\nABC,Ana\nABC,Bia'));
  assert.throws(() => parseNamesCsv('ID,Nome\nABC,"Ana'));
  assert.throws(() => parseNamesCsv('ID,Nome\nABC,Ana,Bia'));
  const [siblings] = parseNamesCsv('ID,Nome\nABC_2,Bia\nABC_1,Ana');
  assert.deepEqual(siblings.names.map(x=>x.name), ['Ana', 'Bia']);
});
test('spreadsheet formulas are neutralized and round-trip without repeated apostrophes', () => {
  for (const name of ['=SUM(1,2)', '+Nome', '@Nome', '-Nome']) {
    const original = order([name]);
    const csv = exportNamesCsv([original]);
    assert.ok(csv.includes("'"));
    const [parsed] = parseNamesCsv(csv);
    assert.equal(parsed.names[0].name, name);
    assert.equal(exportNamesCsv([parsed]), csv);
  }
});
