// ==UserScript==
// @name         Pommu bookmarks
// @namespace    https://github.com/4STRA1/pommu-bookmarks
// @version      1.0.0
// @description  Pommuの投稿をブックマークし、タグで整理・検索できるようにするユーザースクリプト
// @author       4STRA1
// @match        https://ch.dlsite.com/pommu
// @match        https://ch.dlsite.com/pommu/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @downloadURL  https://raw.githubusercontent.com/4STRA1/pommu-bookmarks/main/pommu-bookmarks.user.js
// @updateURL    https://raw.githubusercontent.com/4STRA1/pommu-bookmarks/main/pommu-bookmarks.user.js
// ==/UserScript==

(() => {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const ex = typeof exportFunction === 'function' ? exportFunction : (f) => f;
  const STORE = 'pommu_bookmarks_v1';
  const PAGE = 30;
  const MAX_TAG_LEN = 30;
  const PRIMARY = 'var(--primary,#3fa9f5)';
  const ON_PRIMARY = 'var(--on-primary,#fff)';
  const LINE = 'rgba(128,128,128,.5)';
  const CARD = '[data-testid="post-timeline-item"]';
  const QUOTE = '[data-testid="post-quote-item"]';
  const NAME_SEL = '[data-testid="post-username-link"],[data-testid="post-username-no-link"]';
  const IMG_SEL = '[data-testid="post-image-grid-item"] img,img[src*="/pommu/images/"]';
  const HOST_ATTR = 'data-pf-host';
  const BM_PATH = 'M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z';
  const BACK_PATH = 'M15 18l-6-6 6-6';
  const MAX_RESP_LEN = 5_000_000;

  let db = { items: {}, prefs: {} };
  let mode = 'and';
  let dialog = null, tagDialog = null, toastEl = null, toastT = 0;
  let viewEl = null, viewPath = '', shownCount = PAGE;
  let selTags = new Set(), selNone = false;
  let pendingOpen = false, enrichedPath = '';
  const idMap = new Map();
  const hashMap = new Map();

  function safeUrl(value) {
    if (!value || typeof value !== 'string') return '';
    try {
      const u = new URL(value, location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
    } catch {
      return '';
    }
  }

  const readRaw = () => {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(STORE, '');
    } catch {}

    try {
      return localStorage.getItem(STORE) || '';
    } catch {}

    return '';
  };

  const load = () => {
    try {
      const j = JSON.parse(readRaw() || '{}');

      db = {
        items: j.items && typeof j.items === 'object' ? j.items : {},
        prefs: j.prefs && typeof j.prefs === 'object' ? j.prefs : {},
      };
    } catch {
      db = { items: {}, prefs: {} };
    }

    for (const k of Object.keys(db.items)) {
      const it = db.items[k];

      if (!it || typeof it !== 'object' || typeof it.key !== 'string') {
        delete db.items[k];
        continue;
      }

      if (!Array.isArray(it.tags)) it.tags = [];
    }

    mode = db.prefs.mode === 'or' ? 'or' : 'and';
  };

  const save = (() => {
    let timer = 0, lastWritten = '';

    const flush = () => {
      timer = 0;

      const s = JSON.stringify(db);

      if (s === lastWritten) return;

      lastWritten = s;

      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(STORE, s);
          return;
        }
      } catch {}

      try {
        localStorage.setItem(STORE, s);
      } catch {}
    };

    return () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 150);
    };
  })();

  load();

  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };

  const css = (e, s) => {
    e.style.cssText = s;
    return e;
  };

  const normTag = (s) =>
    s.trim()
      .replace(/^[#＃]+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, MAX_TAG_LEN);

  const allTags = () => {
    const m = new Map();

    for (const it of Object.values(db.items)) {
      for (const t of it.tags) {
        m.set(t, (m.get(t) || 0) + 1);
      }
    }

    return m;
  };

  const chip = (label, on, click, small) => {
    const c = el('button');

    c.type = 'button';

    css(
      c,
      `flex:none;display:inline-flex;align-items:center;padding:${small ? '2px 8px' : '3px 10px'};border-radius:9999px;font-size:${small ? 12 : 13}px;line-height:1.4;cursor:pointer;border:1px solid ${on ? PRIMARY : LINE};background:${on ? PRIMARY : 'transparent'};color:${on ? ON_PRIMARY : 'inherit'}`
    );

    c.textContent = label;
    c.addEventListener('click', click);

    return c;
  };

  const iconSvg = (path, size, cls) =>
    `<svg class="${cls || ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

  function toast(msg) {
    if (!toastEl) {
      toastEl = css(
        el('div', 'bg-surface text-on-surface border border-surface-outline rounded-lg'),
        'position:fixed;left:50%;bottom:5rem;transform:translateX(-50%);z-index:2147483001;max-width:min(90vw,24rem);padding:10px 14px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4)'
      );
    }

    toastEl.textContent = msg;

    if (!toastEl.isConnected && document.body) {
      document.body.append(toastEl);
    }

    clearTimeout(toastT);

    toastT = setTimeout(() => {
      if (toastEl) toastEl.remove();
    }, 3800);
  }

  const put = (m, k, v) => {
    if (m.size > 4000) {
      m.delete(m.keys().next().value);
    }

    m.set(k, v);
  };

  let lastApiSig = '';

  const onApi = (url, text) => {
    try {
      if (!text || text.length > MAX_RESP_LEN) return;

      const u = new URL(String(url), location.href);
      const m = u.pathname.match(
        /^\/api\/pommu\/posts(?:\/([0-9a-f]{64}))?\/?$/
      );

      if (!m) return;

      const sig = u.href + '|' + text.length;

      if (sig === lastApiSig) return;

      lastApiSig = sig;

      const j = JSON.parse(text);

      const reg = (e, h) => {
        const us = e && e.user;
        const p = e && e.post;

        if (!us || !p || !p.createdAt) return;

        const k = `${us.accountId}|${p.createdAt}`;

        if (p.id) put(idMap, k, String(p.id));
        if (h) put(hashMap, k, h);
      };

      if (m[1]) {
        reg(j, m[1]);
      } else if (Array.isArray(j.posts)) {
        for (const e of j.posts) {
          reg(e, '');
        }
      }

      clearTimeout(backfillTimer);
      backfillTimer = setTimeout(backfillIds, 300);

      schedule();
    } catch {}
  };

  try {
    const of = W.fetch;

    W.fetch = ex(function (...a) {
      const p = of.apply(this, a);

      try {
        const url = String(a[0]?.url ?? a[0]);

        if (url.includes('/api/pommu/posts')) {
          p.then((r) =>
            r.clone().text()
              .then((t) => onApi(url, t))
              .catch(() => {})
          ).catch(() => {});
        }
      } catch {}

      return p;
    }, W);

    const proto = W.XMLHttpRequest.prototype;
    const oo = proto.open;

    proto.open = ex(function (m, url, ...r) {
      try {
        const u = String(url);

        if (u.includes('/api/pommu/posts')) {
          const self = this;

          this.addEventListener('load', () => {
            try {
              onApi(u, self.responseText);
            } catch {}
          });
        }
      } catch {}

      return oo.call(this, m, url, ...r);
    }, W);
  } catch {}

  const mainOf = (root, s) =>
    [...root.querySelectorAll(s)].find((e) => !e.closest(QUOTE));

  const rootOf = (node) => {
    const c = node.closest(CARD);

    if (c) return c;

    let e = node.parentElement;

    for (
      let i = 0;
      e && e !== document.body && i < 14;
      i++, e = e.parentElement
    ) {
      if (
        e.querySelector('time[datetime]') &&
        e.querySelector(NAME_SEL)
      ) {
        return e;
      }
    }

    return null;
  };

  const keyOf = (root) => {
    const link = mainOf(
      root,
      'a[data-testid="post-avatar-link"],a[data-testid="post-username-link"]'
    );

    let id = link?.getAttribute('href')?.match(/\/profile\/(\d+)/)?.[1];

    if (!id) {
      id = mainOf(
        root,
        '[data-testid="post-username-no-link"]'
      )?.textContent.match(/ID:(\d+)/)?.[1];
    }

    const t = mainOf(root, 'time[datetime]')?.getAttribute('datetime');

    return id && t
      ? { key: `${id}|${t}`, id, t }
      : null;
  };

  const mediaOf = (root) => {
    const set = new Set();
    let hash = '';

    for (const i of root.querySelectorAll(IMG_SEL)) {
      if (i.closest(QUOTE)) continue;

      const s = i.currentSrc || i.src;

      if (s) set.add(s);

      if (!hash) {
        hash =
          (i.alt || '').match(/^([0-9a-f]{64})/)?.[1] || '';
      }
    }

    return {
      images: [...set],
      hash,
    };
  };

  const extract = (root) => {
    const k = keyOf(root);

    if (!k) return null;

    const nameEl = mainOf(root, NAME_SEL);
    const first = nameEl?.querySelector('span')?.firstChild;

    const name = (
      (
        first && first.nodeType === 3
          ? first.nodeValue
          : (nameEl?.textContent || '').replace(/ID:\d+/, '')
      ) || ''
    ).trim();

    const avatar =
      mainOf(
        root,
        '[data-testid="post-avatar-link"] img,[data-testid="post-avatar-no-link"] img'
      )?.src || '';

    const text = (
      mainOf(root, '[data-testid="post-text-content"]')
        ?.textContent || ''
    ).trim();

    const { images, hash } = mediaOf(root);

    return {
      key: k.key,
      accountId: k.id,
      createdAt: k.t,
      name,
      avatar,
      text,
      images,
      pid: idMap.get(k.key) || '',
      hash: hashMap.get(k.key) || hash || '',
      path: '',
    };
  };

  const detailToken = () =>
    (
      location.pathname.match(
        /\/([0-9a-f]{64}|[0-9a-f]{40})\/?$/
      ) || []
    )[1] || '';

  const isMain = (d) => {
    const t = detailToken();
    return !!t && (t === d.pid || t === d.hash);
  };

  const learnRoute = () => {
    const m = location.pathname.match(
      /^(.*\/)([0-9a-f]{64}|[0-9a-f]{40})\/?$/
    );

    if (!m) return;

    const r = db.prefs.route;

    if (
      r &&
      r.prefix === m[1] &&
      r.len === m[2].length
    ) {
      return;
    }

    load();

    db.prefs.route = {
      prefix: m[1],
      len: m[2].length,
    };

    save();
  };

  const enrich = () => {
    const tok = detailToken();

    if (!tok || enrichedPath === location.pathname) return;

    for (
      const like of document.querySelectorAll(
        '[data-testid="like-button"]'
      )
    ) {
      const root = rootOf(like);
      const d = root && extract(root);

      if (!d || !(tok === d.pid || tok === d.hash)) continue;

      const it = db.items[d.key];

      if (
        it &&
        (
          it.path !== location.pathname ||
          (!it.pid && d.pid) ||
          (!it.hash && d.hash)
        )
      ) {
        load();

        const cur = db.items[d.key];

        if (cur) {
          cur.path = location.pathname;

          if (d.pid) cur.pid = d.pid;
          if (d.hash) cur.hash = d.hash;

          save();
        }
      }

      enrichedPath = location.pathname;
      break;
    }
  };

  const detailUrl = (it) => {
    if (it.path) return it.path;

    const r = db.prefs.route;

    if (!r) return '';

    const t = r.len === 40 ? it.pid : it.hash;

    return t ? r.prefix + t : '';
  };

  function spaNavigate(url) {
    const safe = safeUrl(url);

    if (!safe) return;

    const before = location.pathname;

    try {
      const router =
        W.document.getElementById('__nuxt')
          ?.__vue_app__
          ?.config
          ?.globalProperties
          ?.$router;

      if (router) {
        router.push(
          safe
            .replace(location.origin, '')
            .replace(/^\/pommu(?=\/|$)/, '') || '/'
        );

        setTimeout(() => {
          if (location.pathname === before) {
            location.href = safe;
          }
        }, 900);

        return;
      }
    } catch {}

    location.href = safe;
  }

  function linkNav(a, href) {
    const safe = safeUrl(href);

    if (!safe) {
      a.removeAttribute('href');
      return;
    }

    a.href = safe;

    a.addEventListener('click', (e) => {
      if (
        e.defaultPrevented ||
        e.button ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }

      e.preventDefault();
      spaNavigate(safe);
    });
  }

  function goDetail(it) {
    const url = detailUrl(it);

    if (!url) {
      toast(
        'この投稿の詳細ページのURLがまだ分かりません。タイムラインからこの投稿を一度開くと、次から開けます'
      );
      return;
    }

    spaNavigate(url);
  }

  let backfillTimer = 0;

  function backfillIds() {
    let changed = false;

    for (const key of Object.keys(db.items)) {
      const it = db.items[key];

      if (it.pid && it.hash) continue;

      const pid = idMap.get(key);
      const hash = hashMap.get(key);

      if (
        (pid && pid !== it.pid) ||
        (hash && hash !== it.hash)
      ) {
        if (pid) it.pid = pid;
        if (hash) it.hash = hash;

        changed = true;
      }
    }

    if (changed) {
      save();

      if (viewEl) renderView();
    }
  }

  const fileInput = (() => {
    const i = document.createElement('input');

    i.type = 'file';
    i.accept = 'application/json,.json';
    i.style.display = 'none';

    if (document.body) {
      document.body.append(i);
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => document.body.append(i)
      );
    }

    return i;
  })();

  function doExport() {
    load();

    const payload = {
      app: 'pommu-bookmarks',
      version: 1,
      exportedAt: new Date().toISOString(),
      items: db.items,
    };

    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: 'application/json' }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;

    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');

    a.download =
      `pommu-bookmarks-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;

    document.body.append(a);
    a.click();
    a.remove();

    setTimeout(
      () => URL.revokeObjectURL(url),
      4000
    );

    toast('ブックマークを書き出しました');
  }

  function mergeImported(items) {
    if (!items || typeof items !== 'object') {
      return {
        added: 0,
        updated: 0,
        skipped: 0,
      };
    }

    load();

    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const [key, raw] of Object.entries(items)) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof key !== 'string'
      ) {
        skipped++;
        continue;
      }

      if (!raw.accountId || !raw.createdAt) {
        skipped++;
        continue;
      }

      const tags = Array.isArray(raw.tags)
        ? raw.tags
            .filter((t) => typeof t === 'string')
            .map(normTag)
            .filter(Boolean)
            .slice(0, 50)
        : [];

      const cur = db.items[key];

      if (cur) {
        const mergedTags = [
          ...new Set([
            ...cur.tags,
            ...tags,
          ]),
        ];

        const changed =
          mergedTags.length !== cur.tags.length;

        db.items[key] = {
          ...cur,
          tags: mergedTags,
        };

        if (changed) updated++;
      } else {
        db.items[key] = {
          key,
          accountId: String(raw.accountId),
          createdAt: String(raw.createdAt),
          name:
            typeof raw.name === 'string'
              ? raw.name.slice(0, 200)
              : '',
          avatar:
            typeof raw.avatar === 'string'
              ? raw.avatar
              : '',
          text:
            typeof raw.text === 'string'
              ? raw.text.slice(0, 4000)
              : '',
          images:
            Array.isArray(raw.images)
              ? raw.images
                  .filter((x) => typeof x === 'string')
                  .slice(0, 8)
              : [],
          pid:
            typeof raw.pid === 'string'
              ? raw.pid
              : '',
          hash:
            typeof raw.hash === 'string'
              ? raw.hash
              : '',
          path:
            typeof raw.path === 'string'
              ? raw.path
              : '',
          tags,
          at:
            typeof raw.at === 'number'
              ? raw.at
              : Date.now(),
        };

        added++;
      }
    }

    save();

    return {
      added,
      updated,
      skipped,
    };
  }

  function doImportFile(file) {
    const reader = new FileReader();

    reader.onload = () => {
      let json;

      try {
        json = JSON.parse(
          String(reader.result || '')
        );
      } catch {
        toast(
          'ファイルを読み取れませんでした(JSON形式ではありません)'
        );
        return;
      }

      const items =
        json &&
        json.items &&
        typeof json.items === 'object'
          ? json.items
          : (
              json &&
              typeof json === 'object' &&
              !json.items
            )
            ? json
            : null;

      if (!items) {
        toast('対応していないファイル形式です');
        return;
      }

      const {
        added,
        updated,
        skipped,
      } = mergeImported(items);

      toast(
        `読み込み完了: 追加${added}件 / タグ統合${updated}件${skipped ? ` / 無視${skipped}件` : ''}`
      );

      if (viewEl) renderView();

      for (const b of mountedBtns) {
        if (b.isConnected) paintBtn(b);
      }
    };

    reader.onerror = () => {
      toast('ファイルの読み込みに失敗しました');
    };

    reader.readAsText(file);
  }

  fileInput.addEventListener('change', () => {
    const f =
      fileInput.files &&
      fileInput.files[0];

    fileInput.value = '';

    if (f) doImportFile(f);
  });

  const onEsc = (e) => {
    if (e.key === 'Escape') closeDialog();
  };

  function closeDialog() {
    if (dialog) {
      dialog.remove();
      dialog = null;
    }

    document.removeEventListener(
      'keydown',
      onEsc,
      true
    );
  }

  function afterChange() {
    closeDialog();

    for (const b of mountedBtns) {
      if (b.isConnected) paintBtn(b);
    }

    if (viewEl) renderView();
  }

  function openDialog(base) {
    closeDialog();
    load();

    const existing = db.items[base.key];
    const tags = existing
      ? existing.tags.slice()
      : [];

    const back = css(
      el('div'),
      'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px'
    );

    const panel = css(
      el(
        'div',
        'bg-surface text-on-surface border border-surface-outline rounded-lg'
      ),
      'width:100%;max-width:24rem;max-height:88vh;overflow:auto;padding:16px;box-sizing:border-box;font-size:14px'
    );

    const title =
      el('div', 'text-body-lg font-700');

    title.textContent =
      existing
        ? 'タグを編集'
        : 'ブックマークに追加';

    const who = css(
      el('div', 'text-on-surface-variant'),
      'font-size:12px;margin:4px 0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    );

    who.textContent =
      `${base.name || ''} ${(base.text || '')
        .replace(/\s+/g, ' ')
        .slice(0, 40)}`;

    const chosen = css(
      el('div'),
      'display:flex;flex-wrap:wrap;gap:6px;min-height:8px;margin-bottom:8px'
    );

    const input = css(
      el('input'),
      `width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid ${LINE};background:transparent;color:inherit;font-size:16px`
    );

    input.type = 'text';
    input.placeholder =
      'タグを入力(Enterで追加)';
    input.maxLength = 60;
    input.autocomplete = 'off';

    const suggBox = el('div');

    const suggLabel = css(
      el('div', 'text-on-surface-variant'),
      'font-size:12px;margin:12px 0 6px'
    );

    suggLabel.textContent = '既存のタグ';

    const sugg = css(
      el('div'),
      'display:flex;flex-wrap:wrap;gap:6px'
    );

    suggBox.append(suggLabel, sugg);

    const actions = css(
      el('div'),
      'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:16px'
    );

    const right = css(
      el('div'),
      'display:flex;gap:8px;margin-left:auto'
    );

    const refresh = () => {
      chosen.replaceChildren(
        ...tags.map((t) =>
          chip(
            '#' + t + ' ×',
            true,
            () => {
              tags.splice(tags.indexOf(t), 1);
              refresh();
            }
          )
        )
      );

      const cand = [...allTags()]
        .sort((a, b) => b[1] - a[1])
        .map((x) => x[0])
        .filter((t) => !tags.includes(t));

      sugg.replaceChildren(
        ...cand.map((t) =>
          chip(
            '#' + t,
            false,
            () => {
              tags.push(t);
              refresh();
            }
          )
        )
      );

      suggBox.style.display =
        cand.length ? '' : 'none';
    };

    const addFromInput = () => {
      for (
        const part of input.value.split(/[,、，]/)
      ) {
        const t = normTag(part);

        if (
          t &&
          t.length <= MAX_TAG_LEN &&
          !tags.includes(t)
        ) {
          tags.push(t);
        }
      }

      input.value = '';
      refresh();
    };

    input.addEventListener(
      'keydown',
      (e) => {
        if (
          e.key === 'Enter' &&
          !e.isComposing &&
          e.keyCode !== 229
        ) {
          e.preventDefault();
          addFromInput();
        }
      }
    );

    input.addEventListener(
      'input',
      () => {
        if (
          !input.isComposing &&
          /[,、，]$/.test(input.value)
        ) {
          addFromInput();
        }
      }
    );

    const btn = (label, style, fn) => {
      const b = css(
        el('button'),
        'padding:8px 16px;border-radius:9999px;font-size:14px;cursor:pointer;' +
          style
      );

      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', fn);

      return b;
    };

    const ghost =
      `border:1px solid ${LINE};background:transparent;color:inherit`;

    right.append(
      btn(
        'キャンセル',
        ghost,
        closeDialog
      ),
      btn(
        '保存',
        `border:1px solid ${PRIMARY};background:${PRIMARY};color:${ON_PRIMARY};font-weight:700`,
        () => {
          addFromInput();
          load();

          const cur = db.items[base.key];

          const merged = {
            ...(cur || {}),
            ...base,
            tags: tags.slice(),
            at: cur ? cur.at : Date.now(),
          };

          for (const f of ['pid', 'hash', 'path']) {
            if (
              !base[f] &&
              cur &&
              cur[f]
            ) {
              merged[f] = cur[f];
            }
          }

          db.items[base.key] = merged;

          save();
          afterChange();
        }
      )
    );

    if (existing) {
      actions.append(
        btn(
          '解除',
          'border:1px solid #ef4444;background:transparent;color:#ef4444',
          () => {
            if (
              !confirm(
                'ブックマークを解除しますか？'
              )
            ) {
              return;
            }

            load();
            delete db.items[base.key];
            save();
            afterChange();
          }
        )
      );
    }

    actions.append(right);

    panel.append(
      title,
      who,
      chosen,
      input,
      suggBox,
      actions
    );

    back.append(panel);

    back.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target === back) {
          closeDialog();
        }
      }
    );

    panel.addEventListener(
      'keydown',
      (e) => e.stopPropagation()
    );

    document.body.append(back);

    dialog = back;

    document.addEventListener(
      'keydown',
      onEsc,
      true
    );

    refresh();
    input.focus();
  }

  const onTagEsc = (e) => {
    if (e.key === 'Escape') {
      closeTagFilter();
    }
  };

  function closeTagFilter() {
    if (tagDialog) {
      tagDialog.remove();
      tagDialog = null;
    }

    document.removeEventListener(
      'keydown',
      onTagEsc,
      true
    );
  }

  function filterSummary() {
    if (selNone) return '未分類';
    if (!selTags.size) return 'すべて';

    const arr = [...selTags];
    const joiner =
      mode === 'and'
        ? ' AND '
        : ' OR ';

    const s = arr
      .map((t) => '#' + t)
      .join(joiner);

    return s.length > 26
      ? arr.length + '件選択中'
      : s;
  }

  function openTagFilter() {
    closeTagFilter();

    const workTags = new Set(selTags);
    let workNone = selNone;
    let workMode = mode;
    let q = '';

    const back = css(
      el('div'),
      'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px'
    );

    const panel = css(
      el(
        'div',
        'bg-surface text-on-surface border border-surface-outline rounded-lg'
      ),
      'width:100%;max-width:26rem;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;border-radius:16px;box-sizing:border-box;font-size:14px'
    );

    const head = css(
      el('div'),
      'display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid ' +
        LINE
    );

    const htitle =
      el('div', 'text-body-lg font-700');

    htitle.textContent =
      'タグで絞り込み';

    const closeX = css(
      el('button'),
      'font-size:13px;padding:4px 8px;color:inherit;background:transparent;border:none;cursor:pointer'
    );

    closeX.type = 'button';
    closeX.textContent = '閉じる';
    closeX.addEventListener(
      'click',
      closeTagFilter
    );

    head.append(htitle, closeX);

    const modeRow = css(
      el('div'),
      'display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid ' +
        LINE
    );

    const modeLabel = css(
      el('span', 'text-on-surface-variant'),
      'font-size:12px'
    );

    modeLabel.textContent =
      '複数選択時の条件';

    const modeBtns = css(
      el('div'),
      'display:flex;gap:6px;margin-left:auto'
    );

    const repaintMode = () => {
      modeBtns.replaceChildren(
        chip(
          'AND',
          workMode === 'and',
          () => {
            workMode = 'and';
            repaintMode();
          },
          true
        ),
        chip(
          'OR',
          workMode === 'or',
          () => {
            workMode = 'or';
            repaintMode();
          },
          true
        )
      );
    };

    repaintMode();
    modeRow.append(modeLabel, modeBtns);

    const searchWrap = css(
      el('div'),
      'padding:10px 16px;border-bottom:1px solid ' +
        LINE
    );

    const search = css(
      el('input'),
      `width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid ${LINE};background:transparent;color:inherit;font-size:16px`
    );

    search.type = 'text';
    search.placeholder = 'タグを検索';
    search.autocomplete = 'off';

    searchWrap.append(search);

    const listWrap = css(
      el('div'),
      'flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-wrap:wrap;align-content:flex-start;gap:8px'
    );

    const repaintList = () => {
      const counts = [...allTags()]
        .sort(
          (a, b) =>
            b[1] - a[1] ||
            a[0].localeCompare(b[0])
        );

      const none =
        Object.values(db.items)
          .filter((i) => !i.tags.length)
          .length;

      const kids = [];

      if (!q) {
        kids.push(
          chip(
            'すべて',
            !workNone && !workTags.size,
            () => {
              workNone = false;
              workTags.clear();
              repaintList();
            }
          )
        );

        if (none) {
          kids.push(
            chip(
              `未分類 ${none}`,
              workNone,
              () => {
                workNone = !workNone;

                if (workNone) {
                  workTags.clear();
                }

                repaintList();
              }
            )
          );
        }
      }

      const ql =
        q.trim().toLowerCase();

      for (const [t, n] of counts) {
        if (
          ql &&
          !t.toLowerCase().includes(ql)
        ) {
          continue;
        }

        kids.push(
          chip(
            `#${t} ${n}`,
            workTags.has(t),
            () => {
              workNone = false;

              if (workTags.has(t)) {
                workTags.delete(t);
              } else {
                workTags.add(t);
              }

              repaintList();
            }
          )
        );
      }

      if (!kids.length) {
        const e2 = css(
          el(
            'div',
            'text-on-surface-variant'
          ),
          'font-size:13px;padding:8px 0'
        );

        e2.textContent =
          '一致するタグがありません';

        kids.push(e2);
      }

      listWrap.replaceChildren(...kids);

      modeRow.style.display =
        workTags.size > 1
          ? ''
          : 'none';
    };

    search.addEventListener(
      'input',
      () => {
        q = search.value;
        repaintList();
      }
    );

    repaintList();

    const foot = css(
      el('div'),
      'display:flex;gap:8px;padding:12px 16px;border-top:1px solid ' +
        LINE
    );

    const btn = (label, style, fn) => {
      const b = css(
        el('button'),
        'flex:1;padding:10px 16px;border-radius:9999px;font-size:14px;cursor:pointer;' +
          style
      );

      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', fn);

      return b;
    };

    foot.append(
      btn(
        'クリア',
        `border:1px solid ${LINE};background:transparent;color:inherit`,
        () => {
          workNone = false;
          workTags.clear();
          repaintList();
        }
      ),
      btn(
        '適用',
        `border:1px solid ${PRIMARY};background:${PRIMARY};color:${ON_PRIMARY};font-weight:700`,
        () => {
          selNone = workNone;
          selTags = new Set(workTags);

          if (mode !== workMode) {
            mode = workMode;
            load();
            db.prefs.mode = mode;
            save();
          }

          closeTagFilter();

          shownCount = PAGE;

          renderView();
        }
      )
    );

    panel.append(
      head,
      modeRow,
      searchWrap,
      listWrap,
      foot
    );

    back.append(panel);

    back.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target === back) {
          closeTagFilter();
        }
      }
    );

    panel.addEventListener(
      'keydown',
      (e) => e.stopPropagation()
    );

    document.body.append(back);

    tagDialog = back;

    document.addEventListener(
      'keydown',
      onTagEsc,
      true
    );
  }

  const mountedBtns = new Set();

  function paintBtn(b) {
    const root = rootOf(b);
    const k = root && keyOf(root);
    const saved =
      !!(k && db.items[k.key]);

    if (
      b.dataset.saved === String(saved)
    ) {
      return;
    }

    b.dataset.saved = String(saved);

    const svg = b.firstElementChild;

    if (svg) {
      svg.style.color =
        saved ? PRIMARY : '';

      svg.setAttribute(
        'fill',
        saved
          ? 'currentColor'
          : 'none'
      );
    }

    b.setAttribute(
      'aria-pressed',
      String(saved)
    );
  }

  function mountButtons() {
    for (
      const like of document.querySelectorAll(
        '[data-testid="like-button"]'
      )
    ) {
      const n = like.nextElementSibling;

      if (
        n &&
        n.dataset &&
        n.dataset.pf === 'bm'
      ) {
        mountedBtns.add(n);
        continue;
      }

      if (like.closest('#pf-bm-view')) {
        continue;
      }

      const b = el(
        'button',
        'flex items-center gap-x-1'
      );

      b.type = 'button';
      b.dataset.pf = 'bm';
      b.setAttribute(
        'aria-label',
        'ブックマーク'
      );

      b.innerHTML =
        iconSvg(
          BM_PATH,
          20,
          'size-5 text-on-surface-variant'
        );

      b.addEventListener(
        'click',
        (e) => {
          e.preventDefault();
          e.stopPropagation();

          const root = rootOf(b);
          const d =
            root && extract(root);

          if (!d) {
            toast(
              'この投稿の情報を取得できませんでした'
            );
            return;
          }

          d.path = isMain(d)
            ? location.pathname
            : '';

          openDialog(d);
        }
      );

      b.addEventListener(
        'keydown',
        (e) => e.stopPropagation()
      );

      like.after(b);
      mountedBtns.add(b);
      paintBtn(b);
    }
  }

  function setMenuActive(on) {
    for (
      const li of document.querySelectorAll(
        '[data-pf="bmli"] a > span'
      )
    ) {
      li.className =
        on
          ? 'font-bold text-on-surface-primary'
          : 'text-on-surface';
    }
  }

  function closeDrawer() {
    try {
      const t =
        document.querySelector(
          'input.drawer-toggle'
        );

      if (t && t.checked) {
        t.checked = false;

        t.dispatchEvent(
          new Event('change', {
            bubbles: true,
          })
        );
      }

      document
        .querySelector('.drawer-overlay')
        ?.click();
    } catch {}
  }

  function makeMenuItem() {
    const li = el(
      'li',
      'text-body-lg text-on-surface-variant'
    );

    li.dataset.pf = 'bmli';
    li.style.position = 'relative';

    const a = el('a', 'pl-1');

    a.href = '#';

    const ic = el('div', 'relative');

    ic.innerHTML =
      iconSvg(
        BM_PATH,
        24,
        'size-6 text-on-surface-variant'
      );

    const sp = el(
      'span',
      viewEl
        ? 'font-bold text-on-surface-primary'
        : 'text-on-surface'
    );

    sp.textContent = 'ブックマーク';

    a.append(ic, sp);
    li.append(a);

    a.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        openView();
        closeDrawer();
      }
    );

    return li;
  }

  const menuText = (li, t) =>
    li.textContent.replace(/\s+/g, '') === t;

  function mountMenu() {
    for (
      const ul of document.querySelectorAll(
        'ul.menu'
      )
    ) {
      const lis = [...ul.children]
        .filter(
          (c) =>
            c.tagName === 'LI' &&
            c.dataset.pf !== 'bmli'
        );

      const st = lis.find(
        (li) =>
          menuText(li, '設定')
      );

      if (
        !st ||
        !lis.some(
          (li) =>
            menuText(
              li,
              'プロフィール'
            )
        )
      ) {
        continue;
      }

      const mine = [...ul.children]
        .filter(
          (c) =>
            c.dataset &&
            c.dataset.pf === 'bmli'
        );

      if (
        mine.length === 1 &&
        st.nextElementSibling === mine[0]
      ) {
        continue;
      }

      mine.forEach((m) => m.remove());

      st.after(makeMenuItem());
    }
  }

  const style = el('style');

  style.textContent =
    `html[data-pf-bm] [${HOST_ATTR}] > :not(#pf-bm-view){display:none!important}
html[data-pf-bm] body{overflow-x:hidden!important}`;

  document.documentElement.append(style);

  const hostEl = () =>
    document.querySelector(
      '[data-testid="navbar"]'
    )?.parentElement || null;

  function openView() {
    const host = hostEl();

    if (!host) {
      pendingOpen = true;

      setTimeout(() => {
        pendingOpen = false;
      }, 6000);

      spaNavigate('/pommu/');
      return;
    }

    closeView();
    load();

    shownCount = PAGE;

    viewEl = el('div');
    viewEl.id = 'pf-bm-view';

    host.setAttribute(
      HOST_ATTR,
      ''
    );

    host.append(viewEl);

    document.documentElement.setAttribute(
      'data-pf-bm',
      ''
    );

    viewPath =
      location.pathname;

    renderView();
    setMenuActive(true);

    window.scrollTo(0, 0);
  }

  function closeView() {
    closeTagFilter();

    if (viewEl) {
      viewEl.remove();
      viewEl = null;
    }

    document.documentElement.removeAttribute(
      'data-pf-bm'
    );

    document
      .querySelectorAll(
        `[${HOST_ATTR}]`
      )
      .forEach(
        (h) =>
          h.removeAttribute(HOST_ATTR)
      );

    setMenuActive(false);
  }

  function buildGrid(imgs) {
    const safeImgs = imgs
      .map(safeUrl)
      .filter(Boolean);

    const n =
      Math.min(safeImgs.length, 4);

    if (!n) return el('div');

    const L = {
      1: [[4, 2]],
      2: [
        [2, 2],
        [2, 2],
      ],
      3: [
        [2, 2],
        [2, 1],
        [2, 1],
      ],
      4: [
        [2, 1],
        [2, 1],
        [2, 1],
        [2, 1],
      ],
    }[n];

    const ul = css(
      el('ul'),
      'display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(2,1fr);gap:2px;height:min(14rem,45vw);list-style:none;margin:0;padding:0;border-radius:.5rem;overflow:hidden'
    );

    for (let i = 0; i < n; i++) {
      const li = css(
        el('li'),
        `grid-column:span ${L[i][0]};grid-row:span ${L[i][1]};position:relative;overflow:hidden`
      );

      const a = css(
        el('a'),
        'display:block;width:100%;height:100%'
      );

      a.href = safeImgs[i];
      a.target = '_blank';
      a.rel = 'noopener';

      const im = css(
        el('img'),
        'width:100%;height:100%;object-fit:cover;display:block'
      );

      im.src = safeImgs[i];
      im.loading = 'lazy';
      im.alt = '';

      a.append(im);
      li.append(a);
      ul.append(li);
    }

    return ul;
  }

  function buildMeta(it) {
    const m = css(
      el('div'),
      'margin-top:8px'
    );

    if (it.tags.length) {
      const tl = css(
        el('div'),
        'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px'
      );

      for (const t of it.tags) {
        tl.append(
          chip(
            '#' + t,
            selTags.has(t),
            () => {
              selNone = false;
              selTags = new Set([t]);
              shownCount = PAGE;
              renderView();
            },
            true
          )
        );
      }

      m.append(tl);
    }

    const foot = css(
      el(
        'div',
        'text-body-sm text-on-surface-variant'
      ),
      'display:flex;align-items:center;justify-content:space-between;gap:8px'
    );

    const d = el('span');
    d.textContent = it.createdAt;

    const b = css(
      el('button', 'text-on-surface-variant'),
      `font-size:12px;padding:2px 8px;border:1px solid ${LINE};border-radius:9999px`
    );

    b.type = 'button';
    b.textContent = 'タグ編集';

    b.addEventListener(
      'click',
      () => openDialog(it)
    );

    foot.append(d, b);
    m.append(foot);

    return m;
  }

  function buildCard(it) {
    if (
      !it ||
      typeof it !== 'object' ||
      !it.accountId
    ) {
      return el('div');
    }

    const card = css(
      el(
        'div',
        'border-b border-surface-outline p-3'
      ),
      'cursor:pointer'
    );

    const row = el(
      'div',
      'flex w-full items-start gap-x-3'
    );

    const href =
      `/pommu/profile/${it.accountId}`;

    const av = el(
      'a',
      'flex hover:opacity-70'
    );

    linkNav(av, href);

    const avw =
      el('div', 'avatar');

    const avi =
      el(
        'div',
        'rounded-full size-10 pc:size-12'
      );

    const avSrc =
      safeUrl(it.avatar);

    if (avSrc) {
      const im =
        el('img');

      im.src = avSrc;
      im.alt = '';
      im.loading = 'lazy';

      avi.append(im);
    }

    avw.append(avi);
    av.append(avw);

    const body =
      el('div', 'min-w-0 flex-auto');

    const nm =
      el('div', 'w-fit max-w-full mb-2');

    const na =
      el(
        'a',
        'decoration-on-surface hover:underline'
      );

    linkNav(na, href);

    const p =
      el(
        'p',
        'break-words text-body-md font-700 text-on-surface line-clamp-2'
      );

    const sp =
      el('span');

    sp.append(
      document.createTextNode(
        it.name || ''
      )
    );

    const ids =
      el(
        'span',
        'whitespace-nowrap font-normal text-on-surface-variant text-body-sm ml-1'
      );

    ids.textContent =
      `ID:${it.accountId}`;

    sp.append(ids);
    p.append(sp);
    na.append(p);
    nm.append(na);

    const col =
      el(
        'div',
        'flex flex-col gap-y-3'
      );

    if (it.text) {
      const t =
        el(
          'div',
          'whitespace-pre-wrap break-words text-article-md'
        );

      t.textContent = it.text;
      col.append(t);
    }

    if (
      it.images &&
      it.images.length
    ) {
      col.append(
        buildGrid(it.images)
      );
    }

    body.append(
      nm,
      col,
      buildMeta(it)
    );

    row.append(av, body);
    card.append(row);

    card.addEventListener(
      'click',
      (e) => {
        if (
          e.target.closest(
            'a,button,input,textarea,select,summary,details'
          )
        ) {
          return;
        }

        if (
          String(
            window.getSelection
              ? window.getSelection()
              : ''
          ).length
        ) {
          return;
        }

        goDetail(it);
      }
    );

    return card;
  }

  const matches = (it) => {
    if (selNone) {
      return !it.tags.length;
    }

    if (!selTags.size) {
      return true;
    }

    const t = [...selTags];

    return mode === 'and'
      ? t.every(
          (x) => it.tags.includes(x)
        )
      : t.some(
          (x) => it.tags.includes(x)
        );
  };

  function renderView() {
    if (!viewEl) return;

    const items =
      Object.values(db.items)
        .sort(
          (a, b) =>
            (b.at || 0) -
            (a.at || 0)
        );

    const counts = allTags();

    for (
      const t of [...selTags]
    ) {
      if (!counts.has(t)) {
        selTags.delete(t);
      }
    }

    if (
      selNone &&
      !items.some(
        (i) => !i.tags.length
      )
    ) {
      selNone = false;
    }

    const list =
      items.filter(matches);

    const filtered =
      selNone || selTags.size;

    const wrap = el('div');

    css(
      wrap,
      'width:100%;max-width:100%;overflow-x:hidden;box-sizing:border-box'
    );

    const head = css(
      el(
        'div',
        'sticky top-0 z-40 bg-surface/70 backdrop-blur'
      ),
      'display:flex;align-items:center;gap:8px;padding:10px 12px'
    );

    const backBtn = css(
      el('button'),
      'display:flex;align-items:center;justify-content:center;width:2rem;height:2rem;border:none;background:transparent;color:inherit;cursor:pointer;flex:none'
    );

    backBtn.type = 'button';
    backBtn.setAttribute(
      'aria-label',
      '戻る'
    );

    backBtn.innerHTML =
      iconSvg(
        BACK_PATH,
        22,
        ''
      );

    backBtn.addEventListener(
      'click',
      closeView
    );

    const title =
      el(
        'div',
        'text-body-lg font-700 text-on-surface'
      );

    title.textContent =
      `ブックマーク (${filtered ? list.length + '/' + items.length : items.length})`;

    css(
      title,
      'flex:1;text-align:center;margin-right:2rem'
    );

    head.append(
      backBtn,
      title
    );

    const ioBtn = (label, fn) => {
      const b = css(
        el('button'),
        'font-size:12px;padding:4px 8px;border:1px solid ' +
          LINE +
          ';border-radius:9999px;background:transparent;color:inherit;cursor:pointer;flex:none'
      );

      b.type = 'button';
      b.textContent = label;
      b.addEventListener(
        'click',
        fn
      );

      return b;
    };

    head.append(
      ioBtn(
        '書き出し',
        doExport
      ),
      ioBtn(
        '読み込み',
        () => fileInput.click()
      )
    );

    const filterRow = css(
      el('div'),
      'display:flex;padding:0 16px 10px'
    );

    const filterBtn = css(
      el('button'),
      `display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:9999px;font-size:13px;cursor:pointer;border:1px solid ${filtered ? PRIMARY : LINE};background:${filtered ? PRIMARY : 'transparent'};color:${filtered ? ON_PRIMARY : 'inherit'}`
    );

    filterBtn.type = 'button';

    filterBtn.textContent =
      `🏷 ${filterSummary()}`;

    filterBtn.addEventListener(
      'click',
      openTagFilter
    );

    filterRow.append(filterBtn);

    if (filtered) {
      const clear = css(
        el('button'),
        'margin-left:8px;padding:6px 10px;border-radius:9999px;font-size:13px;cursor:pointer;border:1px solid ' +
          LINE +
          ';background:transparent;color:inherit'
      );

      clear.type = 'button';
      clear.textContent = '解除';

      clear.addEventListener(
        'click',
        () => {
          selNone = false;
          selTags.clear();
          shownCount = PAGE;
          renderView();
        }
      );

      filterRow.append(clear);
    }

    wrap.append(
      head,
      filterRow
    );

    const listEl = el('div');

    const more = css(
      el('button'),
      `display:block;margin:16px auto;padding:8px 20px;border-radius:9999px;border:1px solid ${LINE};font-size:14px;cursor:pointer;background:transparent;color:inherit`
    );

    more.type = 'button';
    more.textContent =
      'さらに表示';

    let idx = 0;

    const pump = (step) => {
      const end =
        Math.min(
          idx + step,
          list.length
        );

      for (
        ;
        idx < end;
        idx++
      ) {
        listEl.append(
          buildCard(list[idx])
        );
      }

      shownCount =
        Math.max(
          idx,
          PAGE
        );

      more.style.display =
        idx < list.length
          ? ''
          : 'none';
    };

    more.addEventListener(
      'click',
      () => pump(PAGE)
    );

    pump(
      Math.max(
        shownCount,
        PAGE
      )
    );

    if (!list.length) {
      const empty = css(
        el(
          'div',
          'text-on-surface-variant'
        ),
        'padding:32px 16px;text-align:center;font-size:14px'
      );

      empty.textContent =
        items.length
          ? 'この条件に一致するブックマークはありません。'
          : 'ブックマークはまだありません。投稿のいいねの右のボタンから追加できます。';

      wrap.append(empty);
    } else {
      wrap.append(
        listEl,
        more
      );
    }

    viewEl.replaceChildren(wrap);
  }

  document.addEventListener(
    'click',
    (e) => {
      if (
        !viewEl ||
        !e.target.closest
      ) {
        return;
      }

      const li =
        e.target.closest(
          'ul.menu > li'
        );

      if (
        li &&
        li.dataset.pf !== 'bmli' &&
        !li.closest(
          '.dropdown-content'
        )
      ) {
        closeView();
      }
    },
    true
  );

  function run() {
    if (document.hidden) return;

    if (
      viewEl &&
      (
        location.pathname !== viewPath ||
        !viewEl.isConnected
      )
    ) {
      closeView();
    }

    learnRoute();
    mountMenu();
    mountButtons();

    for (
      const b of mountedBtns
    ) {
      if (!b.isConnected) {
        mountedBtns.delete(b);
        continue;
      }

      paintBtn(b);
    }

    enrich();

    if (
      pendingOpen &&
      !viewEl &&
      hostEl() &&
      /^\/pommu\/?$/.test(
        location.pathname
      )
    ) {
      pendingOpen = false;
      openView();
    }
  }

  let queued = false;

  function schedule() {
    if (queued) return;

    queued = true;

    requestAnimationFrame(
      () => {
        queued = false;
        run();
      }
    );
  }

  new MutationObserver(
    schedule
  ).observe(
    document.documentElement,
    {
      childList: true,
      subtree: true,
    }
  );

  document.addEventListener(
    'visibilitychange',
    () => {
      if (!document.hidden) {
        schedule();
      }
    }
  );

  schedule();
})();