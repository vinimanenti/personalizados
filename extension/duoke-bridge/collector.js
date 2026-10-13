/* Shared by the isolated content script and controlled DOM tests. No page code is evaluated. */
(() => {
  const RESULT = '.search_result_item';
  const RESULT_FALLBACK = "[class*='search_result']";
  const MESSAGE = '.msg_cont';
  const NOTES = ".order_item_remark, .note_detail, [class*='remark'], [class*='note_detail']";
  const HEADERS = "[data-order-id], [data-order-sn], .order_sn, .order_no, .order_number, .order_detail, .chat_header, .conversation_header, [class*='chat_header']";
  const EMPTY = ".result_empty, .el-empty, .search_no_result, [class*='no_result'], .el-table__empty-text";
  const LOADING = '.el-loading-mask, [aria-busy="true"], .chat_search_bar .el-icon-loading';
  const CANCELLED = 'Coleta cancelada.';
  function deepQuery(root, selector, onRoot = () => {}) {
    const results = [];
    const visited = new Set();
    function visit(scope) {
      if (!scope || visited.has(scope)) return;
      visited.add(scope);
      onRoot(scope);
      results.push(...scope.querySelectorAll(selector));
      for (const node of scope.querySelectorAll('*')) if (node.shadowRoot) visit(node.shadowRoot);
    }
    visit(root);
    return [...new Set(results)];
  }
  const nodeText = node => String(node?.innerText ?? node?.textContent ?? '').trim();
  function hasExactCode(value, code) {
    return String(value).split(/[^A-Za-z0-9_-]+/).some(token => token === code);
  }
  function hasOnlyOrderCode(node, code) {
    const tokens = nodeText(node).split(/[^A-Za-z0-9_-]+/).filter(token => /^[A-Za-z0-9_-]{6,40}$/.test(token) && /\d/.test(token));
    return hasExactCode(nodeText(node), code) && tokens.every(token => token === code);
  }
  function createCollector(document, options = {}) {
    const clock = options.now || (() => Date.now());
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const timeout = options.timeout ?? 12000;
    const settle = options.settle ?? 900;
    const interval = options.interval ?? 100;
    const style = options.getStyle || (node => document.defaultView.getComputedStyle(node));
    const observed = new Set();
    const mutations = [];
    const Observer = options.MutationObserver || document.defaultView?.MutationObserver;
    const observer = Observer ? new Observer(records => mutations.push(...records)) : null;
    const query = selector => deepQuery(document, selector, root => {
      if (observer && !observed.has(root)) { observer.observe(root, { childList: true, characterData: true, attributes: true, subtree: true }); observed.add(root); }
    });
    const visible = node => {
      if (node.isConnected === false) return false;
      if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
      // A child may retain display:block inside a hidden panel. Follow the
      // composed ancestry so hidden slots/shadow hosts are checked as well.
      const visited = new Set();
      for (let current = node; current && !visited.has(current); current = current.assignedSlot || current.parentElement || current.getRootNode?.()?.host || null) {
        visited.add(current);
        const css = style(current);
        if (current.isConnected === false || css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || css.contentVisibility === 'hidden' || css.opacity === '0' || current.getAttribute?.('aria-hidden') === 'true') return false;
      }
      return true;
    };
    const snapshot = nodes => new Map(nodes.map(node => [node, nodeText(node)]));
    function changed(node, before, since) {
      if (!before.has(node) || before.get(node) !== nodeText(node)) return true;
      return mutations.slice(since).some(record => record.type !== 'attributes' && (record.target === node || node.contains?.(record.target) || [...(record.addedNodes || [])].some(added => added === node || added.contains?.(node))));
    }
    const assertRunning = signal => { if (signal?.aborted) throw new Error(CANCELLED); };
    async function waitFor(probe, signal, error) {
      const start = clock();
      while (clock() - start < timeout) {
        assertRunning(signal);
        const result = probe();
        if (result) return result;
        await sleep(interval);
      }
      assertRunning(signal);
      throw new Error(error);
    }
    const within = (root, selector) => deepQuery(root, selector);
    const resultsOpen = container => container.classList.contains('show_result');
    function resultItems(container) {
      if (!resultsOpen(container)) return [];
      const primary = within(container, RESULT).filter(visible);
      if (primary.length) return primary;
      const fallback = within(container, RESULT_FALLBACK).filter(visible);
      // A generic result group is never clicked when it contains result descendants.
      return fallback.filter(node => !fallback.some(other => other !== node && node.contains?.(other)));
    }
    function matchesOrder(node, code) {
      // Order links carry the ID as their title; buyer/shop names can also contain
      // digits. Click the row, since clicking the link opens order details instead.
      const links = within(node, '.search_result_item_info_name a[title]');
      if (links.length) return links.every(link => link.getAttribute('title') === code) && links.some(link => hasExactCode(nodeText(link), code));
      return hasOnlyOrderCode(node, code);
    }
    async function orderSearch(signal) {
      const containers = query('.chat_search_container').filter(visible);
      if (containers.length !== 1) throw new Error('Barra de pesquisa do chat Duoke não encontrada ou ambígua. Abra o chat da Shopee.');
      const container = containers[0];
      const mode = () => within(container, '.chat_search_bar .el-select input').find(visible);
      const isOrder = () => /^pedido$/i.test(String(mode()?.value || '').trim());
      const control = mode();
      if (!control) throw new Error('Seletor de pesquisa Duoke não encontrado. Selecione Pedido na barra do chat.');
      if (!isOrder()) {
        control.click();
        const option = await waitFor(() => within(container, '.el-select-dropdown__item').find(node => visible(node) && /^pedido$/i.test(nodeText(node))), signal, 'Opção Pedido não encontrada na barra de pesquisa Duoke.');
        option.click();
        await waitFor(isOrder, signal, 'Não foi possível confirmar a pesquisa por Pedido no Duoke.');
      }
      const input = within(container, '.chat_search_bar .input_with_select input').find(visible);
      if (!input) throw new Error('Campo de pesquisa Duoke não encontrado. Feche a pesquisa em massa e use um pedido por vez.');
      return { container, input, isOrder };
    }
    function headersFor(code) {
      const results = query(RESULT_FALLBACK);
      const outsideSearch = node => !results.some(result => result === node || result.contains?.(node) || node.contains?.(result));
      const explicit = query(HEADERS).filter(node => {
        if (!visible(node) || !outsideSearch(node)) return false;
        if (node.getAttribute?.('data-order-id') === code || node.getAttribute?.('data-order-sn') === code) return true;
        const text = nodeText(node);
        if (text.length > 600 || !hasExactCode(text, code)) return false;
        return !String(node.getAttribute?.('class') || '').includes('order_detail') || /ID\s+do\s+Pedido\s*[:：]?/i.test(text);
      });
      if (explicit.length) return explicit;
      // Some Duoke layouts expose only a labeled detail row, without an order class.
      return query('div, span, label, dt, dd').filter(node => {
        const text = nodeText(node);
        return visible(node) && outsideSearch(node) && text.length <= 240 && /ID\s+do\s+Pedido\s*[:：]?/i.test(text) && hasOnlyOrderCode(node, code);
      });
    }
    function customerMessages() {
      return query(MESSAGE).filter(node => {
        if (!visible(node)) return false;
        if (node.closest?.("[data-sender-role='customer'], [data-message-direction='incoming'], .msg_customer, .customer_message")) return true;
        const color = style(node).backgroundColor || '';
        return /rgba?\(\s*236\s*,\s*238\s*,\s*242\s*(?:,\s*1(?:\.0+)?\s*)?\)/.test(color);
      });
    }
    function extractText() {
      const messages = customerMessages().map(nodeText).filter(Boolean);
      const notes = [...new Set(query(NOTES).filter(visible).map(nodeText).filter(Boolean))];
      const text = [...messages, ...notes.map(note => `Observação: ${note}`)].join('\n\n');
      if (!text) throw new Error('A conversa carregou sem mensagens do cliente ou observações identificáveis. Revise no Duoke.');
      if (text.length > 12000) throw new Error('A conversa ultrapassa 12.000 caracteres. Importe um trecho revisado por TXT.');
      return text;
    }
    async function collectOrder(code, signal) {
      assertRunning(signal);
      const { container, input, isOrder } = await orderSearch(signal);
      const beforeResults = snapshot(resultItems(container));
      const beforeEmpty = snapshot(resultsOpen(container) ? within(container, EMPTY).filter(visible) : []);
      // Pending records from the preceding order cannot certify a fresh search.
      observer?.takeRecords?.();
      mutations.length = 0;
      const searchSince = mutations.length;
      const inputEvent = type => new document.defaultView.Event(type, { bubbles: true, composed: true });
      // Use the native setter so framework-controlled inputs receive the new value.
      const setter = Object.getOwnPropertyDescriptor(document.defaultView.HTMLInputElement?.prototype || {}, 'value')?.set;
      const fill = value => {
        if (setter) setter.call(input, value); else input.value = value;
        input.dispatchEvent(inputEvent('input'));
      };
      input.focus();
      fill('');
      // Duoke resets its prior search 200 ms after clearing/changing the mode.
      // Finish that reset before entering the next ID (including a repeated ID).
      await sleep(250);
      assertRunning(signal);
      if (!isOrder()) throw new Error('A pesquisa saiu da opção Pedido. Reinicie a coleta.');
      fill(code);
      input.dispatchEvent(inputEvent('change'));
      const enteredAt = clock();
      let submitted = false;
      const found = await waitFor(() => {
        if (!isOrder() || input.value !== code) throw new Error('A pesquisa Duoke mudou durante a coleta. Reinicie a coleta.');
        if (query(LOADING).some(visible)) return null;
        const candidate = resultItems(container).find(node => matchesOrder(node, code) && changed(node, beforeResults, searchSince));
        if (candidate) return { node: candidate };
        const empty = resultsOpen(container) && within(container, EMPTY).find(node => visible(node) && /nenhum|não encontr|não existe|sem resultado|sem dados|no results?|not found|no data|does not exist/i.test(nodeText(node)) && changed(node, beforeEmpty, searchSince));
        if (empty) return { notFound: true };
        // Some layouts search as the user types. The current Pedido component
        // also handles keyup.enter; use that only if no result has appeared.
        if (!submitted && clock() - enteredAt >= 350) {
          submitted = true;
          input.dispatchEvent(new document.defaultView.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
        }
        return null;
      }, signal, 'Tempo esgotado ao confirmar um resultado novo da pesquisa. Nenhuma conversa antiga foi coletada.');
      if (found.notFound) return { id: code, status: 'not_found', text: '' };
      assertRunning(signal);
      const beforeMessages = snapshot(query(MESSAGE));
      const beforeNotes = snapshot(query(NOTES));
      found.node.click();
      let stableFingerprint = null;
      let stableSince = clock();
      await waitFor(() => {
        if (query(LOADING).some(visible) || !headersFor(code).length) { stableFingerprint = null; stableSince = clock(); return false; }
        const nodes = query(MESSAGE).filter(visible);
        // All visible messages and notes must belong to a refreshed conversation.
        // Attribute/hover mutations and one new placeholder cannot validate old text.
        const notes = query(NOTES).filter(visible);
        const refreshed = (nodes.some(node => nodeText(node)) || notes.some(node => nodeText(node))) && nodes.every(node => changed(node, beforeMessages, Infinity)) && notes.every(node => changed(node, beforeNotes, Infinity));
        if (!refreshed) { stableFingerprint = null; stableSince = clock(); return false; }
        const fingerprint = [...nodes.map(nodeText), ...query(NOTES).filter(visible).map(nodeText)].join('\u0000');
        if (fingerprint !== stableFingerprint) { stableFingerprint = fingerprint; stableSince = clock(); return false; }
        return clock() - stableSince >= settle;
      }, signal, 'Tempo esgotado ao confirmar a conversa do pedido. Nenhuma mensagem antiga foi coletada.');
      assertRunning(signal);
      if (!headersFor(code).length) throw new Error('A conversa mudou durante a coleta.');
      return { id: code, status: 'collected', text: extractText() };
    }
    async function run(codes, { signal, onProgress = async () => {} } = {}) {
      const uniqueCodes = [...new Set(codes)];
      const orders = [];
      try {
        for (const code of uniqueCodes) {
          assertRunning(signal);
          let order;
          try { order = await collectOrder(code, signal); }
          catch (error) {
            if (signal?.aborted) break;
            order = { id: code, status: 'error', text: '', error: error.message };
          }
          if (signal?.aborted) break;
          orders.push(order);
          await onProgress({ completed: orders.length, total: uniqueCodes.length, order });
        }
      } catch (error) { if (!signal?.aborted) throw error; }
      finally { observer?.disconnect(); }
      return { orders, completed: orders.length, total: uniqueCodes.length, cancelled: Boolean(signal?.aborted) };
    }
    return { run, collectOrder, extractText, disconnect: () => observer?.disconnect() };
  }
  globalThis.StickerDuokeCollector = Object.freeze({ deepQuery, hasExactCode, hasOnlyOrderCode, createCollector });
})();
