// Sidecar Monkey — content script.
// Runs in every page (document_idle). Executes DOM commands relayed by the
// service worker. The element-index map is per-document: re-snapshot after
// any navigation or heavy DOM change.
(() => {
  if (window.__dtBrowser) return;
  window.__dtBrowser = true;

  const els = new Map(); // index -> element, rebuilt on each snapshot

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.documentElement || el === document.body) return true;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    // opacity is NOT inherited — an element inside an opacity:0 parent passes
    // its own computed style, so walk ancestors (hidden menus, pre-fade modals)
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).opacity === '0') return false;
    }
    return true;
  };

  const FOCUSABLE = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="switch"],[role="combobox"],[role="searchbox"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

  const INTERACTIVE_SEL = 'a[href],button,input,textarea,select,summary,' +
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="option"],' +
    '[role="switch"],[role="combobox"],[role="searchbox"],[role="slider"],[role="spinbutton"],[role="treeitem"],[role="gridcell"],' +
    '[role="menuitemcheckbox"],[role="menuitemradio"],[role="dialog"],[role="alertdialog"],' +
    '[contenteditable="true"],[tabindex],[onclick],[aria-expanded],[aria-haspopup],[aria-pressed],[data-action],label,option,h1,h2,h3';
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  ]);

  const clampInt = (value, fallback, minimum, maximum) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
  };

  const cleanText = (value, limit = 160) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit);

  function selectedRoot(selector) {
    if (!selector) return document.body || document.documentElement;
    try {
      const root = document.querySelector(selector);
      if (!root) throw new Error(`no element matches selector: ${selector}`);
      return root;
    } catch (e) {
      if (e && /^no element matches/.test(e.message || '')) throw e;
      throw new Error(`bad CSS selector "${selector}": ${e.message}`);
    }
  }

  function accessibleName(el) {
    const aria = cleanText(el.getAttribute('aria-label'));
    if (aria) return aria;
    const labelledBy = cleanText(el.getAttribute('aria-labelledby'));
    if (labelledBy) {
      const text = cleanText(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' '));
      if (text) return text;
    }
    if (el.labels && el.labels.length) {
      const text = cleanText([...el.labels].map((label) => label.innerText || label.textContent).join(' '));
      if (text) return text;
    }
    return cleanText(el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder'));
  }

  function isSensitiveControl(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type === 'password') return true;
    const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    return tokens.some((token) => SENSITIVE_AUTOCOMPLETE.has(token));
  }

  function compactElement(item, includeGeometry) {
    const parts = [`[${item.index}]`, item.tag];
    if (item.role) parts.push(`role=${JSON.stringify(item.role)}`);
    const label = item.name || item.text;
    if (label) parts.push(JSON.stringify(label));
    if (item.id) parts.push(`id=${JSON.stringify(item.id)}`);
    if (item.type) parts.push(`type=${JSON.stringify(item.type)}`);
    if (item.placeholder && item.placeholder !== label) parts.push(`placeholder=${JSON.stringify(item.placeholder)}`);
    if (item.value && item.value !== label) parts.push(`value=${JSON.stringify(item.value)}`);
    if (item.href) parts.push(`href=${JSON.stringify(item.href.slice(0, 200))}`);
    if (item.checked === true) parts.push('checked');
    else if (item.checked === false && (item.type === 'checkbox' || item.type === 'radio' || item.role === 'switch' || item.role === 'checkbox' || item.role === 'menuitemcheckbox')) parts.push('unchecked');
    if (item.selected === true) parts.push('selected');
    else if (item.selected === false && (item.role === 'tab' || item.role === 'option' || item.tag === 'option')) parts.push('unselected');
    if (item.expanded === true) parts.push('expanded');
    else if (item.expanded === false) parts.push('collapsed');
    if (item.pressed === true) parts.push('pressed');
    else if (item.pressed === false) parts.push('unpressed');
    if (item.disabled === true) parts.push('disabled');
    if (item.sensitive === true) parts.push('sensitive');
    if (!item.inViewport) parts.push('offscreen');
    if (includeGeometry) parts.push(`box=${item.x},${item.y},${item.w},${item.h}`);
    return parts.join(' ');
  }

  function snapshot(p = {}) {
    els.clear();
    const format = p.format === 'full' ? 'full' : 'compact';
    const query = cleanText(p.query, 500).toLowerCase();
    const root = selectedRoot(p.selector);
    const maxElements = clampInt(p.maxElements, format === 'full' ? 5000 : 80, 0, 5000);
    const offset = clampInt(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const viewportOnly = p.viewportOnly === true;
    const includeGeometry = p.includeGeometry === true;
    const matches = [];
    const candidates = [];
    if (root.nodeType === 1 && root.matches(INTERACTIVE_SEL)) candidates.push(root);
    candidates.push(...root.querySelectorAll(INTERACTIVE_SEL));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const item = {
        tag,
        role: el.getAttribute('role') || '',
        text: cleanText(el.innerText || el.textContent),
      };
      const name = accessibleName(el);
      if (name && name !== item.text) item.name = name;
      if (el.id) item.id = cleanText(el.id, 80);
      if (el.href) item.href = el.href;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        item.type = el.type || tag;
        if (isSensitiveControl(el)) {
          item.sensitive = true;
          if (el.value) item.value = '[REDACTED]';
        } else if (el.value !== undefined && !(el instanceof HTMLSelectElement)) {
          item.value = String(el.value).slice(0, 160);
        }
        if (el.placeholder) item.placeholder = el.placeholder;
        if (el.checked !== undefined) item.checked = el.checked;
        if (el.disabled) item.disabled = true;
      }
      if (el.hasAttribute('aria-checked')) {
        item.checked = el.getAttribute('aria-checked') === 'true';
      }
      if (el.hasAttribute('aria-expanded')) {
        item.expanded = el.getAttribute('aria-expanded') === 'true';
      }
      if (el.hasAttribute('aria-pressed')) {
        item.pressed = el.getAttribute('aria-pressed') === 'true';
      }
      if (el.hasAttribute('aria-selected')) {
        item.selected = el.getAttribute('aria-selected') === 'true';
      }
      if (tag === 'option' && el.parentElement && el.parentElement.value !== undefined) {
        item.selected = el.selected;
      }
      const r = el.getBoundingClientRect();
      item.x = Math.round(r.x); item.y = Math.round(r.y);
      item.w = Math.round(r.width); item.h = Math.round(r.height);
      item.inViewport = r.bottom >= 0 && r.top <= window.innerHeight && r.right >= 0 && r.left <= window.innerWidth;
      if (viewportOnly && !item.inViewport) continue;
      const haystack = [item.tag, item.role, item.text, item.name, item.id, item.type, item.placeholder, item.value, item.href]
        .filter((value) => value != null).join(' ').toLowerCase();
      if (query && !haystack.includes(query)) continue;
      item.index = matches.length + 1;
      els.set(item.index, el);
      matches.push(item);
    }
    const page = matches.slice(offset, offset + maxElements);
    const nextOffset = offset + page.length < matches.length ? offset + page.length : null;
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      format,
      elements: format === 'full' ? page : page.map((item) => compactElement(item, includeGeometry)).join('\n'),
      count: page.length,
      total: matches.length,
      offset,
      truncated: nextOffset !== null,
      nextOffset,
    };
  }

  function resolveTarget(target) {
    if (target == null) return { ok: false, error: 'no target given — pass a snapshot element index or a CSS selector' };
    const num = typeof target === 'number' ? target : (/^\d+$/.test(String(target).trim()) ? Number(target) : null);
    if (num !== null) {
      const el = els.get(num);
      if (!el) return { ok: false, error: `element ${num} not in the current snapshot — the page changed, re-snapshot first` };
      if (!el.isConnected) return { ok: false, error: `element ${num} is detached from DOM (page re-rendered). Re-snapshot or target by CSS selector/id` };
      return { ok: true, el };
    }
    if (typeof target === 'string') {
      try {
        const el = document.querySelector(target);
        if (!el) return { ok: false, error: `no element matches selector: ${target}` };
        return { ok: true, el };
      } catch (e) {
        return { ok: false, error: `bad CSS selector "${target}": ${e.message}` };
      }
    }
    return { ok: false, error: 'target must be a number (snapshot index) or a CSS selector string' };
  }

  function dispatchMouse(el, type, coords) {
    const bubbles = type !== 'mouseenter' && type !== 'mouseleave';
    const opts = { bubbles, cancelable: true, composed: true, view: window };
    if (coords) { opts.clientX = coords.x; opts.clientY = coords.y; opts.detail = 1; }
    el.dispatchEvent(new MouseEvent(type, opts));
  }

  async function cmdClick(p) {
    const t = resolveTarget(p.target);
    if (!t.ok) return t;
    const el = t.el;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 80));
    const r = el.getBoundingClientRect();
    const coords = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    
    // Topmost element hit-testing: real user clicks hit topmost child (span/svg/icon) inside container
    const hit = (coords.x >= 0 && coords.y >= 0 && coords.x <= window.innerWidth && coords.y <= window.innerHeight)
      ? document.elementFromPoint(coords.x, coords.y)
      : null;
    const targetEl = (hit && (el.contains(hit) || hit.contains(el))) ? hit : el;

    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch {}
    }

    const clickOnce = () => {
      targetEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, clientX: coords.x, clientY: coords.y, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      dispatchMouse(targetEl, 'mousedown', coords);
      targetEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, clientX: coords.x, clientY: coords.y, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      dispatchMouse(targetEl, 'mouseup', coords);
      // Call native HTML activation behavior if available, or dispatch click event
      if (typeof el.click === 'function') {
        try { el.click(); } catch { dispatchMouse(targetEl, 'click', coords); }
      } else if (targetEl !== el && typeof targetEl.click === 'function') {
        try { targetEl.click(); } catch { dispatchMouse(targetEl, 'click', coords); }
      } else {
        dispatchMouse(targetEl, 'click', coords);
      }
    };
    clickOnce();
    if (p.double === true) {
      clickOnce();
      dispatchMouse(targetEl, 'dblclick', coords);
    }

    return { ok: true, clicked: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80), url: location.href };
  }

  async function cmdHover(p) {
    const t = resolveTarget(p.target);
    if (!t.ok) return t;
    const el = t.el;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 60));
    const r = el.getBoundingClientRect();
    const coords = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    const hit = (coords.x >= 0 && coords.y >= 0 && coords.x <= window.innerWidth && coords.y <= window.innerHeight)
      ? document.elementFromPoint(coords.x, coords.y)
      : null;
    const targetEl = (hit && (el.contains(hit) || hit.contains(el))) ? hit : el;
    targetEl.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, composed: true, clientX: coords.x, clientY: coords.y, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    targetEl.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, cancelable: false, composed: true, clientX: coords.x, clientY: coords.y, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    dispatchMouse(targetEl, 'mouseover', coords);
    dispatchMouse(targetEl, 'mouseenter', coords);
    dispatchMouse(targetEl, 'mousemove', coords);
    return { ok: true, hovered: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80), url: location.href };
  }

  async function cmdSelectOption(p) {
    const t = resolveTarget(p.target);
    if (!t.ok) return t;
    const el = t.el;
    const value = p.value != null ? String(p.value) : null;
    const label = p.label != null ? String(p.label) : null;
    if (value == null && label == null) {
      return { ok: false, error: 'select_option requires "value" or "label"' };
    }
    let selectEl = el instanceof HTMLSelectElement ? el : (typeof el.closest === 'function' ? el.closest('select') : null);
    if (selectEl) {
      let matchedOption = null;
      for (const opt of selectEl.options) {
        if (value != null && opt.value === value) { matchedOption = opt; break; }
        if (label != null && (opt.text.trim() === label || opt.text.trim().toLowerCase() === label.toLowerCase())) { matchedOption = opt; break; }
      }
      if (!matchedOption && label != null) {
        for (const opt of selectEl.options) {
          if (opt.text.toLowerCase().includes(label.toLowerCase())) { matchedOption = opt; break; }
        }
      }
      if (!matchedOption) {
        return { ok: false, error: `option not found matching value="${value}" label="${label}"` };
      }
      selectEl.value = matchedOption.value;
      matchedOption.selected = true;
      selectEl.dispatchEvent(new Event('input', { bubbles: true }));
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: matchedOption.value, text: matchedOption.text.trim(), url: location.href };
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'listbox' || role === 'combobox') {
      const options = el.querySelectorAll('[role="option"], option');
      for (const opt of options) {
        const optText = (opt.innerText || opt.textContent || '').trim();
        const optVal = opt.getAttribute('data-value') || opt.getAttribute('value') || optText;
        if ((value != null && optVal === value) || (label != null && (optText === label || optText.toLowerCase().includes(label.toLowerCase())))) {
          opt.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          if (typeof opt.click === 'function') opt.click();
          else dispatchMouse(opt, 'click');
          return { ok: true, selected: optVal, text: optText, url: location.href };
        }
      }
    }
    return { ok: false, error: `target is not a <select> or ARIA listbox/combobox (tag: ${el.tagName})` };
  }

  async function cmdType(p) {
    const t = resolveTarget(p.target);
    if (!t.ok) return t;
    const el = t.el;
    const text = String(p.text ?? '');
    const clear = p.clear !== false;
    el.focus();
    if (el.isContentEditable) {
      if (clear) {
        el.textContent = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
      if (text) {
        document.execCommand('insertText', false, text); // fires input events that rich editors listen to
      }
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      if (!(el instanceof HTMLTextAreaElement) && ['file', 'image', 'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'date', 'time', 'hidden'].includes(el.type)) {
        return { ok: false, error: `cannot type into <input type="${el.type}"> — the value setter is a no-op there` };
      }
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, (clear ? '' : el.value) + text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      return { ok: false, error: `element is not typeable (${el.tagName}) — expected input/textarea/contenteditable` };
    }
    if (p.press_enter === true || p.pressEnter === true) {
      await cmdPress({ key: 'Enter' });
    }
    const value = isSensitiveControl(el) ? '[REDACTED]' : (el.value !== undefined ? el.value : el.textContent);
    return { ok: true, typed: text.length, value, url: location.href };
  }

  function parseKeyCombo(combo) {
    const parts = String(combo || '').split('+');
    const main = parts.pop().trim();
    let ctrlKey = false, altKey = false, shiftKey = false, metaKey = false;
    for (const p of parts) {
      const mod = p.trim().toLowerCase();
      if (mod === 'ctrl' || mod === 'control') ctrlKey = true;
      else if (mod === 'alt') altKey = true;
      else if (mod === 'shift') shiftKey = true;
      else if (mod === 'cmd' || mod === 'meta' || mod === 'command') metaKey = true;
    }
    let code = main;
    if (/^[a-z]$/i.test(main)) code = `Key${main.toUpperCase()}`;
    else if (/^\d$/.test(main)) code = `Digit${main}`;
    else if (main === ' ') code = 'Space';
    const key = main === 'Space' ? ' ' : main;
    return { key, code, ctrlKey, altKey, shiftKey, metaKey };
  }

  async function cmdPress(p) {
    const rawKey = String(p.key || '');
    const parsed = parseKeyCombo(rawKey);
    const el = document.activeElement || document.body;
    const eventInit = {
      key: parsed.key,
      code: parsed.code,
      ctrlKey: parsed.ctrlKey,
      altKey: parsed.altKey,
      shiftKey: parsed.shiftKey,
      metaKey: parsed.metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    };
    // A page that cancels keydown has handled the key itself: a real key press then runs no default action.
    const proceed = el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    if (!proceed) return { ok: true, key: rawKey, action: 'handled_by_page' };
    if (parsed.key === 'Enter') {
      const ae = document.activeElement;
      if (ae) {
        if (ae instanceof HTMLInputElement && ae.form && !parsed.ctrlKey && !parsed.metaKey) {
          ae.form.requestSubmit();
          return { ok: true, key: rawKey, action: 'form_submit' };
        }
        if (parsed.ctrlKey || parsed.metaKey) {
          const launchBtn = document.querySelector('button[aria-label*="Ctrl/Cmd+Enter" i], button[title*="Ctrl" i]');
          if (launchBtn && isVisible(launchBtn)) {
            launchBtn.click();
            return { ok: true, key: rawKey, action: 'button_click', buttonText: (launchBtn.innerText || '').slice(0, 40) };
          }
        }
        const btn = ae.closest('button, [role="button"]');
        if (btn) { btn.click(); return { ok: true, key: rawKey, action: 'button_click' }; }
      }
    }
    if (parsed.key === 'Tab') {
      const focusables = [...document.querySelectorAll(FOCUSABLE)].filter(isVisible);
      const idx = focusables.indexOf(document.activeElement);
      const step = parsed.shiftKey ? -1 : 1;
      const next = focusables[(idx + step + focusables.length) % focusables.length];
      if (next) next.focus();
      return { ok: true, key: rawKey, action: parsed.shiftKey ? 'focus_prev' : 'focus_next' };
    }
    return { ok: true, key: rawKey, note: 'synthetic key event; native default actions (form submit, focus move) are handled explicitly' };
  }

  function findScrollableContainer(dir) {
    const s = (dir === 'up' || dir === 'left') ? -1 : 1;
    const isVert = dir === 'up' || dir === 'down';
    const can = (el) => {
      if (isVert) {
        return s > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 2 : el.scrollTop > 0;
      }
      return s > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 2 : el.scrollLeft > 0;
    };
    let best = null, area = 0;
    for (const el of document.querySelectorAll('*')) {
      const overflow = getComputedStyle(el)[isVert ? 'overflowY' : 'overflowX'];
      if (!/(auto|scroll|overlay)/.test(overflow)) continue;
      if (isVert && (el.scrollHeight <= el.clientHeight + 2 || !can(el))) continue;
      if (!isVert && (el.scrollWidth <= el.clientWidth + 2 || !can(el))) continue;
      const b = el.getBoundingClientRect();
      const a = Math.max(0, Math.min(b.right, window.innerWidth) - Math.max(b.left, 0)) *
                Math.max(0, Math.min(b.bottom, window.innerHeight) - Math.max(b.top, 0));
      if (a > area) { area = a; best = el; }
    }
    return best;
  }

  function cmdScroll(p) {
    if (p.target != null) {
      const t = resolveTarget(p.target);
      if (!t.ok) return t;
      t.el.scrollIntoView({ block: 'center', behavior: 'auto' });
      return { ok: true, top: Math.round(window.scrollY), left: Math.round(window.scrollX) };
    }
    const dir = p.direction || 'down';
    const amount = Number(p.amount ?? 600);
    const prevY = window.scrollY;
    const prevX = window.scrollX;
    if (dir === 'top') window.scrollTo({ top: 0, behavior: 'auto' });
    else if (dir === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
    else if (dir === 'up') window.scrollBy({ top: -amount, behavior: 'auto' });
    else if (dir === 'down') window.scrollBy({ top: amount, behavior: 'auto' });
    else if (dir === 'left') window.scrollBy({ left: -amount, behavior: 'auto' });
    else if (dir === 'right') window.scrollBy({ left: amount, behavior: 'auto' });
    else {
      return { ok: false, error: `unknown direction "${dir}" — use up/down/left/right/top/bottom or pass a target` };
    }
    if (['up', 'down', 'left', 'right'].includes(dir) && window.scrollY === prevY && window.scrollX === prevX) {
      const container = findScrollableContainer(dir);
      if (container) {
        const isVert = dir === 'up' || dir === 'down';
        const sign = (dir === 'up' || dir === 'left') ? -1 : 1;
        container.scrollBy({
          top: isVert ? sign * amount : 0,
          left: !isVert ? sign * amount : 0,
          behavior: 'auto',
        });
        return {
          ok: true,
          top: Math.round(container.scrollTop),
          left: Math.round(container.scrollLeft),
          innerContainer: true,
        };
      }
    }
    return { ok: true, top: Math.round(window.scrollY), left: Math.round(window.scrollX) };
  }

  function cmdExtract(p = {}) {
    const root = selectedRoot(p.selector);
    const text = (root.innerText || root.textContent || '') || '';
    const offset = clampInt(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxChars = clampInt(p.maxChars, 12000, 0, 200000);
    const chunk = text.slice(offset, offset + maxChars);
    const nextOffset = offset + chunk.length < text.length ? offset + chunk.length : null;
    return {
      ok: true,
      url: location.href,
      title: document.title,
      text: chunk,
      offset,
      totalChars: text.length,
      truncated: nextOffset !== null,
      nextOffset,
    };
  }

  function cmdExportHtml(p = {}) {
    const root = selectedRoot(p.selector);
    const outer = p.outer !== false;
    const rawHtml = outer ? (root.outerHTML || root.innerHTML || '') : (root.innerHTML || '');
    const maxChars = clampInt(p.maxChars, 200000, 1000, 2000000);
    const totalChars = rawHtml.length;
    const truncated = totalChars > maxChars;
    const html = truncated ? rawHtml.slice(0, maxChars) : rawHtml;
    return {
      ok: true,
      url: location.href,
      title: document.title,
      totalChars,
      truncated,
      html,
    };
  }

  function cmdRead(p = {}) {
    const mode = p.mode || 'page';
    if (!['page', 'text', 'snapshot', 'elements', 'html'].includes(mode)) {
      return { ok: false, error: `unknown read mode: ${mode}` };
    }
    if (mode === 'elements') {
      const snapped = snapshot({ ...p, format: 'full' });
      return {
        ok: true,
        url: snapped.url,
        title: snapped.title,
        total: snapped.total,
        count: snapped.count,
        offset: snapped.offset,
        truncated: snapped.truncated,
        nextOffset: snapped.nextOffset,
        elements: snapped.elements,
      };
    }
    if (mode === 'html') return cmdExportHtml(p);
    const result = { ok: true, url: location.href, title: document.title, readyState: document.readyState };
    if (mode !== 'snapshot') {
      const extracted = cmdExtract(p);
      result.text = extracted.text;
      result.text_meta = {
        offset: extracted.offset,
        total: extracted.totalChars,
        truncated: extracted.truncated,
        next_offset: extracted.nextOffset,
      };
    }
    if (mode !== 'text') {
      const snapped = snapshot({ ...p, format: 'compact' });
      result.elements = snapped.elements;
      result.element_meta = {
        offset: snapped.offset,
        returned: snapped.count,
        total: snapped.total,
        truncated: snapped.truncated,
        next_offset: snapped.nextOffset,
      };
    }
    return result;
  }

  async function cmdWaitFor(p) {
    const timeout = Number(p.timeoutMs ?? 10000);
    const start = Date.now();
    const isSelector = typeof p.target === 'string';
    while (Date.now() - start < timeout) {
      let found = false;
      if (isSelector) {
        try {
          const el = document.querySelector(p.target);
          found = !!el && isVisible(el);
        } catch (e) {
          return { ok: false, error: `bad CSS selector "${p.target}": ${e.message}` };
        }
      } else {
        const t = resolveTarget(p.target);
        found = t.ok;
      }
      if (found) return { ok: true, waitedMs: Date.now() - start };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, error: `timed out after ${timeout}ms waiting for ${isSelector ? 'selector "' + p.target + '"' : 'element ' + p.target}` };
  }

  function cmdGetState() {
    return { ok: true, url: location.href, title: document.title, readyState: document.readyState, hidden: document.hidden };
  }

  function cmdGetElementState(p = {}) {
    const t = resolveTarget(p.target);
    if (!t.ok) return t;
    const el = t.el;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const name = accessibleName(el);
    const text = cleanText(el.innerText || el.textContent);

    const attr = (name) => (el.hasAttribute(name) ? el.getAttribute(name) === 'true' : undefined);
    const checked = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : attr('aria-checked');
    const selected = tag === 'option' ? el.selected : attr('aria-selected');
    const expanded = el instanceof HTMLDetailsElement ? el.open : attr('aria-expanded');
    const pressed = attr('aria-pressed');
    const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');

    let value = undefined;
    if (isSensitiveControl(el)) {
      value = '[REDACTED]';
    } else if (el.value !== undefined) {
      value = el.value;
    }

    const r = el.getBoundingClientRect();
    const visible = isVisible(el);
    const inViewport = r.bottom >= 0 && r.top <= window.innerHeight && r.right >= 0 && r.left <= window.innerWidth;

    return {
      ok: true,
      target: p.target,
      tag,
      role,
      name,
      text,
      value,
      checked,
      selected,
      expanded,
      pressed,
      disabled,
      visible,
      inViewport,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      url: location.href,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'dtb') return;
    const p = msg.params || {};
    Promise.resolve().then(() => {
      switch (msg.cmd) {
        case 'snapshot': return snapshot(p);
        case 'click': return cmdClick(p);
        case 'hover': return cmdHover(p);
        case 'select_option': return cmdSelectOption(p);
        case 'type': return cmdType(p);
        case 'press': return cmdPress(p);
        case 'scroll': return cmdScroll(p);
        case 'extract_text': return cmdExtract(p);
        case 'export_html': return cmdExportHtml(p);
        case 'read': return cmdRead(p);
        case 'wait_for': return cmdWaitFor(p);
        case 'get_state': return cmdGetState();
        case 'get_element_state': return cmdGetElementState(p);
        default: return { ok: false, error: `unknown command: ${msg.cmd}` };
      }
    }).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  });
})();
