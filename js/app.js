/*
 * Slektstre – leser en GEDCOM-fil lokalt og viser den.
 * Ingenting sendes over nettet: filen ligger i nettleserens lagring på enheten.
 */
(function () {
  'use strict';

  const { decodeGedcom, ENCODINGS } = window.Tegnsett;
  const { parseGedcom } = window.Gedcom;

  const $app = document.getElementById('app');
  const $fileInput = document.getElementById('file-input');
  const S = { db: null, file: null, decoded: null, depth: 0, storageOk: true, lastWidth: 0 };

  // ===================== Hjelpere =====================

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  const fmtNum = n => n.toLocaleString('nb-NO');
  const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 20;
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('slekt.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('slekt.' + k, JSON.stringify(v)); } catch (e) { /* privat modus */ } },
    del(k) { try { localStorage.removeItem('slekt.' + k); } catch (e) { /* privat modus */ } }
  };

  const CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
  const MARK = `<svg class="welcome-mark" viewBox="0 0 120 120" aria-hidden="true">
    <rect x="6" y="6" width="108" height="108" rx="28" fill="var(--accent)"/>
    <g fill="none" stroke="var(--accent-ink)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".55">
      <path d="M44 60h10v-22h12M54 60v22h12"/></g>
    <g fill="var(--accent-ink)"><rect x="22" y="50" width="26" height="20" rx="6"/>
      <rect x="66" y="28" width="32" height="20" rx="6"/><rect x="66" y="72" width="32" height="20" rx="6"/></g></svg>`;

  // ===================== Lagring (IndexedDB) =====================

  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open('slektstre', 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => req.result.createObjectStore('filer');
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => reject(req.error);
      });
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('filer', mode);
        const req = fn(tx.objectStore('filer'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    get(key) { return this.run('readonly', s => s.get(key)); },
    set(key, value) { return this.run('readwrite', s => s.put(value, key)); },
    del(key) { return this.run('readwrite', s => s.delete(key)); }
  };

  async function requestPersist() {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ikke støttet */ }
  }

  // ===================== Innlesing =====================

  function loadBytes(bytes, override) {
    const decoded = decodeGedcom(new Uint8Array(bytes), override || null);
    const db = parseGedcom(decoded.text);
    if (!db.persons.size) {
      const err = new Error('Ingen personer');
      err.code = 'EMPTY';
      throw err;
    }
    return { db, decoded };
  }

  function errorText(e, name) {
    if (e && e.code === 'NOT_GEDCOM') {
      return `<b>Dette ser ikke ut som en slektsfil.</b><br>«${esc(name || 'Filen')}» er ikke en GEDCOM-fil. Velg filen som slutter på <b>.ged</b>. Den lages med «Eksporter» eller «GEDCOM» i slektsprogrammet.`;
    }
    if (e && e.code === 'EMPTY') return '<b>Fant ingen personer i filen.</b><br>Filen er en GEDCOM-fil, men den inneholder ingen personer.';
    return `<b>Filen kunne ikke leses.</b><br>${esc(e && e.message || 'Ukjent feil')}`;
  }

  async function importFile(file) {
    if (!file) return;
    showLoading('Leser slektsfilen …');
    await nextFrame();
    let buf;
    try {
      buf = await file.arrayBuffer();
      const { db, decoded } = loadBytes(buf, null);
      S.db = db;
      S.decoded = decoded;
      S.file = { name: file.name, size: file.size, importedAt: Date.now(), override: null, bytes: buf };
    } catch (e) {
      renderWelcome(errorText(e, file.name));
      return;
    }
    try {
      await idb.set('aktiv', S.file);
      S.storageOk = true;
      requestPersist();
    } catch (e) {
      S.storageOk = false;
    }
    const home = prefs.get('hjem', null);
    if (!home || !S.db.persons.has(home)) prefs.del('hjem');
    prefs.set('nylig', prefs.get('nylig', []).filter(id => S.db.persons.has(id)));
    toast(S.storageOk
      ? `Slektsfilen er lest inn: ${fmtNum(S.db.persons.size)} personer.`
      : 'Filen er lest inn, men kunne ikke lagres. Du må åpne den igjen neste gang.', 4000);
    go(homeId() ? '#/p/' + enc(homeId()) : '#/velg-hjem', { replace: true });
  }

  $fileInput.addEventListener('change', () => {
    const f = $fileInput.files && $fileInput.files[0];
    $fileInput.value = '';
    importFile(f);
  });

  // Dra-og-slipp på datamaskin
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) importFile(f);
  });

  // ===================== Navigasjon =====================

  function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, '');
    const i = raw.indexOf('/');
    const name = i < 0 ? raw : raw.slice(0, i);
    let arg = '';
    if (i >= 0) { try { arg = decodeURIComponent(raw.slice(i + 1)); } catch (e) { arg = raw.slice(i + 1); } }
    return { name, arg };
  }

  function go(hash, opts = {}) {
    if (opts.replace) {
      history.replaceState({ depth: S.depth, scroll: 0 }, '', hash);
    } else {
      history.replaceState(Object.assign({}, history.state, { depth: S.depth, scroll: window.scrollY }), '');
      S.depth++;
      history.pushState({ depth: S.depth, scroll: 0 }, '', hash);
    }
    render({ fresh: true });
  }

  window.addEventListener('popstate', e => {
    S.depth = (e.state && e.state.depth) || 0;
    render({ scroll: (e.state && e.state.scroll) || 0 });
  });

  const homeId = () => {
    const h = prefs.get('hjem', null);
    return h && S.db && S.db.persons.has(h) ? h : null;
  };

  function render(opts = {}) {
    const r = parseRoute();
    updateTopbar(r);
    let view = r.name;
    if (!S.db) {
      if (view === 'innstillinger') renderSettings();
      else renderWelcome();
    } else {
      switch (view) {
        case 'p': renderPerson(r.arg); break;
        case 'aner': renderTree('aner', r.arg, opts); break;
        case 'etterk': renderTree('etterk', r.arg, opts); break;
        case 'sok': renderSearch(r.arg, 'sok'); break;
        case 'velg-hjem': renderSearch(r.arg, 'velg-hjem'); break;
        case 'innstillinger': renderSettings(); break;
        default:
          if (homeId()) renderPerson(homeId());
          else renderSearch('', 'velg-hjem');
      }
    }
    if (view !== 'aner' && view !== 'etterk') window.scrollTo(0, opts.fresh ? 0 : (opts.scroll || 0));
  }

  function updateTopbar(r) {
    const has = !!S.db;
    const back = document.getElementById('btn-back');
    back.disabled = S.depth <= 0;
    document.getElementById('btn-home').hidden = !has;
    document.getElementById('btn-search').hidden = !has;
    const home = homeId();
    const onHome = has && ((r.name === 'p' && r.arg === home) || (!r.name && home));
    document.getElementById('btn-home').classList.toggle('is-current', !!onHome);
    document.getElementById('btn-search').classList.toggle('is-current', r.name === 'sok');
    document.getElementById('btn-settings').classList.toggle('is-current', r.name === 'innstillinger');
  }

  document.getElementById('btn-back').addEventListener('click', () => { if (S.depth > 0) history.back(); });
  document.getElementById('btn-home').addEventListener('click', () => {
    const h = homeId();
    const target = h ? '#/p/' + enc(h) : '#/velg-hjem';
    if (location.hash === target) window.scrollTo({ top: 0, behavior: 'smooth' });
    else go(target);
  });
  document.getElementById('btn-search').addEventListener('click', () => {
    if (parseRoute().name === 'sok') { const q = document.getElementById('q'); if (q) q.focus(); return; }
    go('#/sok');
  });
  document.getElementById('btn-settings').addEventListener('click', () => { if (parseRoute().name !== 'innstillinger') go('#/innstillinger'); });

  // Alle knapper med data-go / data-act håndteres her
  document.addEventListener('click', e => {
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); go(g.dataset.go); return; }
    const a = e.target.closest('[data-act]');
    if (a && actions[a.dataset.act]) { e.preventDefault(); actions[a.dataset.act](a); }
  });

  // Gjør :active-stiler synlige på iPad
  document.addEventListener('touchstart', () => {}, { passive: true });

  // ===================== Felles byggeklosser =====================

  function toast(msg, ms = 2600) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('is-on'), ms);
  }

  function showLoading(msg) {
    $app.innerHTML = `<div class="loading"><div class="loading-inner">
      <div class="dots"><span></span><span></span><span></span></div>
      <p class="loading-text">${esc(msg)}</p></div></div>`;
  }

  const childWord = p => p.sex === 'M' ? 'Sønn' : p.sex === 'F' ? 'Datter' : 'Barn';
  const sibWord = (p, half) => half
    ? (p.sex === 'M' ? 'Halvbror' : p.sex === 'F' ? 'Halvsøster' : 'Halvsøsken')
    : (p.sex === 'M' ? 'Bror' : p.sex === 'F' ? 'Søster' : 'Søsken');

  function parentsLine(p) {
    const { father, mother } = S.db.parents(p);
    const names = [father, mother].filter(Boolean).map(x => x.name);
    return names.length ? `${childWord(p)} av ${names.join(' og ')}` : '';
  }

  function spouseLine(p) {
    const sf = S.db.spouseFamilies(p).find(f => f.spouse);
    if (!sf) return '';
    return (sf.fam.married ? 'Gift med ' : 'Partner: ') + sf.spouse.name;
  }

  /** Stor knapp for én person. */
  function personButton(p, role, opts = {}) {
    if (!p) {
      return `<div class="pbtn is-missing"><span class="pbtn-text">${role ? `<span class="pbtn-role">${esc(role)}</span>` : ''}<span class="pbtn-name">${esc(opts.missing || 'Ikke registrert')}</span></span></div>`;
    }
    const meta = [p.lifespan, opts.meta].filter(Boolean).join(' · ');
    const target = opts.act
      ? `data-act="${esc(opts.act)}" data-id="${esc(p.id)}"`
      : `data-go="${esc(opts.href || '#/p/' + enc(p.id))}"`;
    return `<button type="button" class="pbtn sex-${p.sex}" ${target}>
      <span class="pbtn-text">${role ? `<span class="pbtn-role">${esc(role)}</span>` : ''}<span class="pbtn-name">${esc(p.name)}</span>${meta ? `<span class="pbtn-meta">${esc(meta)}</span>` : ''}${opts.sub ? `<span class="pbtn-sub">${esc(opts.sub)}</span>` : ''}</span>
      <span class="pbtn-chev">${CHEV}</span></button>`;
  }

  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function viewTabs(p, active) {
    const tab = (key, label, href) => `<button type="button" class="tab${active === key ? ' is-active' : ''}"${active === key ? ' aria-current="page"' : ` data-go="${href}"`}>${label}</button>`;
    return `<nav class="tabs" aria-label="Visning">
      ${tab('p', 'Personkort', '#/p/' + enc(p.id))}
      ${tab('aner', 'Anetavle', '#/aner/' + enc(p.id))}
      ${tab('etterk', 'Etterkommere', '#/etterk/' + enc(p.id))}</nav>`;
  }

  function addRecent(id) {
    const list = prefs.get('nylig', []).filter(x => x !== id);
    list.unshift(id);
    prefs.set('nylig', list.slice(0, 12));
  }

  // ===================== Velkomst =====================

  function renderWelcome(error) {
    document.title = 'Slektstre';
    $app.innerHTML = `<section class="welcome">
      ${MARK}
      <h1 class="page-title">Slektstreet</h1>
      <p class="lead">Åpne slektsfilen én gang, så husker iPaden den til neste gang. Filen blir liggende her – ingenting sendes noe sted.</p>
      ${error ? `<div class="error-box" role="alert">${error}</div>` : ''}
      <button type="button" class="btn btn-primary btn-big" data-act="open-file">Åpne slektsfil</button>
      <div class="welcome-help">
        <h2>Hvor finner jeg filen?</h2>
        <p>Når du trykker på knappen, åpnes Filer. Filen ligger ofte i <b>iCloud Drive</b> eller <b>Nedlastinger</b>, og navnet slutter vanligvis på <b>.ged</b>.</p>
        <h2>Hvordan lager jeg filen?</h2>
        <p>I slektsprogrammet velger du «Eksporter» eller «Lag GEDCOM-fil». Når treet er oppdatert, lager du en ny fil og åpner den her via Innstillinger.</p>
      </div>
    </section>`;
  }

  // ===================== Søk og valg av Hjem =====================

  function renderSearch(q, mode) {
    const choosing = mode === 'velg-hjem';
    document.title = choosing ? 'Velg Hjem – Slektstre' : 'Søk – Slektstre';
    const first = S.db.persons.values().next().value;
    $app.innerHTML = `<section class="search-page">
      <h1 class="page-title">${choosing ? 'Hvem skal være «Hjem»?' : 'Finn en person'}</h1>
      ${choosing ? '<p class="lead" style="margin-top:.5rem">Hjem-knappen tar deg alltid tilbake til denne personen. Velg for eksempel deg selv eller en stamfar.</p>' : ''}
      <form class="search-box" id="search-form" role="search">
        <input id="q" class="search-input" type="search" value="${esc(q)}"
          placeholder="Skriv fornavn, etternavn eller begge" autocomplete="off" autocorrect="off"
          autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Navn">
        <button type="button" class="btn" data-act="clear-search">Tøm</button>
      </form>
      <p class="search-help">Du kan legge til et årstall, for eksempel «Ole Hansen 1850». Å, aa og a regnes som like.</p>
      ${choosing && first ? `<div class="suggest"><p class="results-head">Forslag: første person i filen</p>${personButton(first, null, { act: 'choose-home', sub: parentsLine(first) })}</div>` : ''}
      <div id="results" class="results-wrap"></div>
    </section>`;
    const input = document.getElementById('q');
    const results = document.getElementById('results');
    const update = () => {
      showResults(results, input.value, mode);
      const route = (choosing ? '#/velg-hjem' : '#/sok') + (input.value ? '/' + enc(input.value) : '');
      history.replaceState(Object.assign({}, history.state), '', route);
    };
    input.addEventListener('input', debounce(update, 120));
    document.getElementById('search-form').addEventListener('submit', e => { e.preventDefault(); input.blur(); });
    showResults(results, q, mode);
    if (!q) input.focus({ preventScroll: true });
  }

  function showResults(el, q, mode) {
    const act = mode === 'velg-hjem' ? 'choose-home' : null;
    const item = p => personButton(p, null, { act, sub: parentsLine(p) || spouseLine(p) });
    if (!q.trim()) {
      const recent = prefs.get('nylig', []).map(id => S.db.person(id)).filter(Boolean);
      el.innerHTML = recent.length
        ? `<p class="results-head">Nylig sett</p><div class="results">${recent.map(item).join('')}</div>`
        : '';
      return;
    }
    const { total, results } = S.db.search(q, 60);
    if (!total) {
      el.innerHTML = `<p class="results-head">Fant ingen som heter «${esc(q)}».</p>
        <p class="muted">Prøv bare fornavnet eller bare etternavnet, eller fjern årstallet.</p>`;
      return;
    }
    const head = total > results.length
      ? `Viser de ${results.length} beste av ${fmtNum(total)} treff. Skriv mer for å finne færre.`
      : `${fmtNum(total)} ${total === 1 ? 'treff' : 'treff'}`;
    el.innerHTML = `<p class="results-head">${head}</p><div class="results">${results.map(item).join('')}</div>`;
  }

  // ===================== Personkort =====================

  function renderPerson(id) {
    const db = S.db;
    const p = db.person(id);
    if (!p) return renderMissing();
    addRecent(id);
    document.title = p.name + ' – Slektstre';
    const isHome = homeId() === id;

    const pf = db.parentFamilies(p);
    const par = db.parents(p);
    const parentLinks = [par.father, par.mother].filter(Boolean)
      .map(x => `<button type="button" class="ilink" data-go="#/p/${enc(x.id)}">${esc(x.name)}</button>`);

    const head = `<div class="view-head">
      <div class="vh-who">
        <h1 class="vh-name${p.name.length > 34 ? ' is-small' : ''}">${esc(p.name)}${isHome ? ' <span class="vh-home-badge">Hjem</span>' : ''}</h1>
        ${p.lifespan ? `<p class="vh-life">${esc(lifeSummary(p))}</p>` : ''}
        ${parentLinks.length ? `<p class="vh-parents">${childWord(p)} av ${parentLinks.join(' og ')}</p>` : ''}
        ${p.aka.length ? `<p class="vh-aka">Også kjent som ${esc(p.aka.join(', '))}</p>` : ''}
      </div>
      <div class="vh-controls">
        ${viewTabs(p, 'p')}
        ${isHome ? '' : `<button type="button" class="btn" data-act="set-home" data-id="${esc(p.id)}">Gjør til Hjem</button>`}
      </div>
    </div>`;

    // Livsløp
    const tl = db.timeline(p);
    const life = `<section class="card"><h2 class="card-title">Livsløp</h2>
      ${tl.length ? `<ol class="timeline">${tl.map(eventRow).join('')}</ol>` : '<p class="empty-note">Ingen hendelser er registrert.</p>'}
    </section>`;

    // Familie
    const fam = [];
    if (pf.length) {
      for (const f of pf) {
        const adopt = f.pedi === 'adopted' ? 'Adoptiv' : f.pedi === 'foster' ? 'Foster' : '';
        fam.push(`<div class="fam-block"><h3 class="fam-h">${adopt ? adopt.toLowerCase() + 'foreldre' : 'Foreldre'}</h3>
          <div class="plist two">${personButton(f.father, adopt ? adopt + 'far' : 'Far', { missing: 'Far er ikke registrert' })}${personButton(f.mother, adopt ? adopt + 'mor' : 'Mor', { missing: 'Mor er ikke registrert' })}</div></div>`);
      }
    } else {
      fam.push('<div class="fam-block"><h3 class="fam-h">Foreldre</h3><p class="empty-note">Ingen foreldre er registrert.</p></div>');
    }
    const sfs = db.spouseFamilies(p);
    sfs.forEach((sf, i) => {
      const f = sf.fam;
      const marr = f.events.find(e => e.tag === 'MARR');
      const div = f.events.find(e => e.tag === 'DIV');
      const meta = [];
      if (marr && (marr.date.text || marr.place)) meta.push(['Gift', marr.date.text, marr.place && 'i ' + marr.place].filter(Boolean).join(' '));
      if (div) meta.push(['Skilt', div.date.text].filter(Boolean).join(' '));
      const word = f.married ? 'Ektefelle' : 'Partner';
      const title = sfs.length > 1 ? `${i + 1}. ${f.married ? 'ekteskap' : 'forhold'}` : word;
      fam.push(`<div class="fam-block">
        <h3 class="fam-h">${title}</h3>
        <div class="plist">${personButton(sf.spouse, sfs.length > 1 ? word : null, { missing: 'Ikke registrert' })}</div>
        ${meta.length ? `<p class="fam-meta" style="margin-top:.6rem">${esc(meta.join(' · '))}</p>` : ''}
        ${sf.children.length ? `<h3 class="fam-h" style="margin-top:1rem">Barn <span class="count">(${sf.children.length})</span></h3>
          <div class="plist two">${sf.children.map(c => personButton(c, childWord(c))).join('')}</div>` : ''}
        ${f.notes.map(n => `<p class="ev-note">${linkify(n)}</p>`).join('')}
      </div>`);
    });
    const family = `<section class="card"><h2 class="card-title">Familie</h2>${fam.join('')}</section>`;

    const sibs = db.siblings(p);
    const siblings = sibs.length
      ? `<section class="card"><h2 class="card-title">Søsken <span class="count">${sibs.length}</span></h2>
        <div class="plist">${sibs.map(s => personButton(s.person, sibWord(s.person, s.half), s.half && s.via ? { sub: `Felles ${s.via.sex === 'F' ? 'mor' : 'far'}: ${s.via.name}` } : {})).join('')}</div></section>`
      : '';

    const notes = p.notes.length
      ? `<section class="card"><h2 class="card-title">Notater</h2>${p.notes.map(n => `<p class="note-text">${linkify(n)}</p>`).join('')}</section>`
      : '';
    const sources = p.sources.length
      ? `<section class="card"><h2 class="card-title">Kilder</h2><ol class="src-list">${p.sources.map(sourceItem).join('')}</ol></section>`
      : '';

    $app.innerHTML = `${head}<div class="pc-grid">
      <div class="pc-col">${life}${siblings}${notes}${sources}</div>
      <div class="pc-col">${family}</div></div>`;
  }

  function lifeSummary(p) {
    let s = p.lifespan;
    if (p.birth && p.death && p.birth.tag === 'BIRT' && p.death.tag === 'DEAT') {
      const tl = S.db.timeline(p).find(e => e.tag === 'DEAT');
      if (tl && tl.ageText) s += ` · ble ${tl.ageText}`;
    }
    return s;
  }

  function eventRow(e) {
    let main = e.date.text;
    const subs = [];
    if (e.value) { if (main) subs.push(esc(e.value)); else main = e.value; }
    if (e.place) subs.push(esc(e.place));
    if (e.addr) subs.push(esc(e.addr.replace(/\n/g, ', ')));
    if (e.cause) subs.push('Årsak: ' + esc(e.cause));
    if (e.family && e.spouse) subs.unshift(`med <button type="button" class="ilink" data-go="#/p/${enc(e.spouse.id)}">${esc(e.spouse.name)}</button>`);
    if (!main && !subs.length && !e.notes.length) main = e.tag === 'DEAT' ? 'Dato ukjent' : 'Ingen dato';
    return `<li class="ev">
      <div class="ev-label">${esc(e.label)}</div>
      <div class="ev-body">
        ${main ? `<div class="ev-main">${esc(main)}${e.ageText ? ` <span class="ev-age">(${esc(e.ageText)})</span>` : ''}</div>` : ''}
        ${subs.map(s => `<div class="ev-sub">${s}</div>`).join('')}
        ${e.notes.map(n => `<div class="ev-note">${linkify(n)}</div>`).join('')}
        ${e.sources.map(s => `<div class="ev-src">Kilde: ${esc([s.title, s.page].filter(Boolean).join(', '))}</div>`).join('')}
      </div></li>`;
  }

  function sourceItem(s) {
    return `<li><div>${linkify(s.title || 'Kilde uten tittel')}</div>
      ${s.page ? `<div class="src-detail">${linkify(s.page)}</div>` : ''}
      ${s.detail ? `<div class="src-detail">${linkify(s.detail)}</div>` : ''}
      ${s.text ? `<div class="src-detail">${linkify(s.text)}</div>` : ''}
      ${s.note ? `<div class="src-detail">${linkify(s.note)}</div>` : ''}</li>`;
  }

  function renderMissing() {
    $app.innerHTML = `<section class="welcome"><h1 class="page-title">Fant ikke personen</h1>
      <p class="lead">Personen finnes ikke i slektsfilen. Kanskje filen er byttet ut siden sist.</p>
      <button type="button" class="btn btn-primary btn-big" data-go="#/sok">Søk etter en person</button></section>`;
  }

  // ===================== Trær =====================

  const GEN_OPTIONS = { aner: [3, 4, 5], etterk: [2, 3, 4] };
  const ANC_COLS = ['', 'Foreldre', 'Besteforeldre', 'Oldeforeldre', 'Tippoldeforeldre', 'Tipp-tippoldeforeldre'];
  const DESC_COLS = ['', 'Barn', 'Barnebarn', 'Oldebarn', 'Tippoldebarn'];

  function treeMetrics() {
    const rem = remPx();
    const gutter = Math.max(16, 1.4 * rem);
    const availW = $app.clientWidth - 2 * gutter;
    return { rem, availW, gap: availW < 900 ? 2 * rem : 2.6 * rem, minW: 11 * rem, maxW: 19 * rem };
  }

  function genCount(view) {
    const saved = prefs.get('gen.' + view, null);
    if (GEN_OPTIONS[view].includes(saved)) return saved;
    const m = treeMetrics();
    const fits = n => n * m.minW + (n - 1) * m.gap <= m.availW;
    return view === 'aner' ? (fits(4) ? 4 : 3) : (fits(3) ? 3 : 2);
  }

  function renderTree(view, id, opts) {
    const p = S.db.person(id);
    if (!p) return renderMissing();
    const G = genCount(view);
    const label = view === 'aner' ? 'Anetavle for' : 'Etterkommere etter';
    document.title = `${view === 'aner' ? 'Anetavle' : 'Etterkommere'}: ${p.name} – Slektstre`;

    let nav = '';
    if (view === 'aner') {
      const kids = S.db.children(p);
      if (kids.length) nav = `<span class="tree-nav-label">Gå ned til barn:</span>` + kids.map(k => chip(k, '#/aner/' + enc(k.id))).join('');
    } else {
      const par = S.db.parents(p);
      const ps = [par.father, par.mother].filter(Boolean);
      if (ps.length) nav = `<span class="tree-nav-label">Gå opp til foreldre:</span>` + ps.map(x => chip(x, '#/etterk/' + enc(x.id))).join('');
    }

    $app.innerHTML = `<div class="view-head">
        <div class="vh-who"><div class="vh-kicker">${label}</div>
          <h1 class="vh-name is-small">${esc(p.name)}</h1>
          ${p.lifespan ? `<p class="vh-life">${esc(p.lifespan)}</p>` : ''}</div>
        <div class="vh-controls">${viewTabs(p, view)}</div>
      </div>
      <div class="tree-bar">
        <div class="tree-nav">${nav}</div>
        <div class="gens" role="group" aria-label="Antall generasjoner"><span class="gens-label">Generasjoner</span>
          ${GEN_OPTIONS[view].map(n => `<button type="button" class="${n === G ? 'is-on' : ''}" data-act="gens" data-view="${view}" data-n="${n}" aria-pressed="${n === G}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="tree-scroll" id="tree-scroll"><div class="tree" id="tree"></div></div>
      <p class="hint">Trykk på en person for å flytte treet dit. Trykk på <b>${esc(p.name)}</b> for å åpne personkortet.</p>`;

    S.tree = { view, id, G };
    S.lastWidth = window.innerWidth;
    layoutTree({ animate: opts.fresh, center: opts.fresh || !opts.scroll, scroll: opts.scroll });
  }

  function chip(p, href) {
    return `<button type="button" class="chip sex-${p.sex}" data-go="${href}">${esc(p.name)}</button>`;
  }

  function layoutTree({ animate, center, scroll } = {}) {
    const el = document.getElementById('tree');
    if (!el || !S.tree) return;
    const { view, id, G } = S.tree;
    const p = S.db.person(id);
    const result = view === 'aner' ? layoutAncestors(p, G) : layoutDescendants(p, G);
    el.style.width = result.width + 'px';
    el.style.height = result.height + 'px';
    el.innerHTML = `<svg class="links" width="${result.width}" height="${result.height}" aria-hidden="true">${result.links.join('')}</svg>${result.html}`;
    if (animate) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
    const sc = document.getElementById('tree-scroll');
    if (sc) sc.scrollLeft = 0;
    if (center) {
      const root = el.querySelector('.is-root');
      if (root) {
        const r = root.getBoundingClientRect();
        const bottom = window.scrollY + r.bottom + remPx();
        window.scrollTo(0, Math.max(0, bottom - window.innerHeight));
      }
    } else if (scroll != null) {
      window.scrollTo(0, scroll);
    }
  }

  /** Avrundet albue-linje fra (x1,y1) til (x2,y2). */
  function elbow(x1, y1, x2, y2, xm, dashed) {
    const cls = dashed ? ' class="is-dashed"' : '';
    if (Math.abs(y2 - y1) < 1) return `<path${cls} d="M${x1},${y1}H${x2}"/>`;
    const s = y2 > y1 ? 1 : -1;
    const r = Math.min(14, Math.abs(y2 - y1) / 2, (xm - x1), (x2 - xm));
    return `<path${cls} d="M${x1},${y1}H${xm - r}Q${xm},${y1} ${xm},${y1 + s * r}V${y2 - s * r}Q${xm},${y2} ${xm + r},${y2}H${x2}"/>`;
  }

  function relLabel(g, i, sex) {
    if (g === 0) return '';
    const bits = [];
    for (let b = g - 1; b >= 0; b--) bits.push((i >> b) & 1 ? 'mor' : 'far');
    if (g === 1) return cap(bits[0]);
    if (g === 2) return cap(bits[0] + bits[1]);
    if (g === 3) return cap(bits[0] + bits[1] + 's ' + bits[2]);
    const last = bits[bits.length - 1];
    if (g === 4) return 'Tippolde' + last;
    return 'Tipp-tippolde' + last;
  }

  function shortDates(p) {
    const lines = [];
    const b = p.birth, d = p.death;
    if (b && b.date.short) lines.push(`<span class="tbox-line"><b>${b.tag === 'BIRT' ? 'f.' : 'døpt'}</b> ${esc(b.date.short)}</span>`);
    if (d && d.date.short) lines.push(`<span class="tbox-line"><b>${d.tag === 'DEAT' ? 'd.' : 'gravl.'}</b> ${esc(d.date.short)}</span>`);
    return lines.join('');
  }

  function boxHtml(p, o) {
    const cls = ['tbox', 'sex-' + p.sex, 'g' + Math.min(o.g, 5)];
    if (o.root) cls.push('is-root');
    if (o.more) cls.push('has-more');
    const href = o.root ? '#/p/' + enc(p.id) : o.href;
    const aria = [o.rel, p.name, p.lifespan].filter(Boolean).join(', ');
    return `<button type="button" class="${cls.join(' ')}" style="left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px" data-go="${href}" aria-label="${esc(aria)}">
      ${o.rel ? `<span class="tbox-rel">${esc(o.rel)}</span>` : ''}
      <span class="tbox-name">${esc(p.name)}</span>
      ${o.detail ? shortDates(p) || (p.lifespan ? `<span class="tbox-years">${esc(p.lifespan)}</span>` : '') : (p.lifespan ? `<span class="tbox-years">${esc(p.lifespan)}</span>` : '')}
      ${(o.extra || []).map(t => `<span class="tbox-line">${t}</span>`).join('')}
      ${o.root ? `<span class="tbox-open">Åpne personkortet ›</span>` : ''}
      ${o.more ? `<span class="tbox-more">${esc(o.more)}</span>` : ''}
    </button>`;
  }

  function emptyBox(text, x, y, w, h) {
    return `<div class="tbox is-empty" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"><span class="tbox-name">${esc(text)}</span></div>`;
  }

  function layoutAncestors(root, G) {
    const m = treeMetrics();
    const { rem, gap } = m;
    const boxW = Math.min(m.maxW, Math.max(m.minW, Math.floor((m.availW - gap * (G - 1)) / G)));
    const H = [10 * rem, 7.2 * rem, 5.8 * rem, 5.6 * rem, 5.6 * rem, 5.6 * rem];
    const vgap = 0.55 * rem;
    const labelH = 2 * rem;
    const width = G * boxW + (G - 1) * gap;

    // Fyll generasjon for generasjon: hver plass er {p} eller {empty} eller null
    const gens = [[{ p: root }]];
    for (let g = 1; g < G; g++) {
      const row = new Array(2 ** g).fill(null);
      gens[g - 1].forEach((slot, i) => {
        if (!slot || !slot.p) return;
        const { father, mother } = S.db.parents(slot.p);
        if (father) row[2 * i] = { p: father };
        if (mother) row[2 * i + 1] = { p: mother };
        if (!father && (mother || g === 1)) row[2 * i] = { empty: 'Far er ikke registrert' };
        if (!mother && (father || g === 1)) row[2 * i + 1] = { empty: 'Mor er ikke registrert' };
      });
      gens.push(row);
    }

    let need = 0;
    for (let g = 0; g < G; g++) need = Math.max(need, 2 ** g * (H[g] + vgap));
    const sc = document.getElementById('tree-scroll');
    const availH = window.innerHeight - (sc ? sc.getBoundingClientRect().top + window.scrollY : 0) - 3 * rem;
    const total = Math.max(need, Math.min(availH, need * 1.5));
    const height = total + labelH;

    const pos = []; // [g][i] → {x, y, h}
    let html = '';
    const links = [];
    for (let g = 0; g < G; g++) {
      pos[g] = [];
      const x = g * (boxW + gap);
      const slotH = total / 2 ** g;
      if (ANC_COLS[g] && gens[g].some(Boolean)) html += `<div class="col-label" style="left:${x}px;width:${boxW}px">${ANC_COLS[g]}</div>`;
      gens[g].forEach((slot, i) => {
        if (!slot) return;
        const h = slot.empty ? Math.min(H[g], 3.4 * rem) : H[g];
        const cy = labelH + (i + 0.5) * slotH;
        const y = Math.round(cy - h / 2);
        pos[g][i] = { x, y, h, cy };
        if (slot.empty) {
          html += emptyBox(slot.empty, x, y, boxW, h);
        } else {
          const p = slot.p;
          let more = '';
          if (g === G - 1) {
            const par = S.db.parents(p);
            if (par.father || par.mother) more = 'Flere ›';
          }
          html += boxHtml(p, {
            g, x, y, w: boxW, h, root: g === 0, rel: relLabel(g, i, p.sex),
            detail: g <= 1, more, href: '#/aner/' + enc(p.id)
          });
        }
        if (g > 0) {
          const c = pos[g - 1][i >> 1];
          if (c) links.push(elbow(c.x + boxW, c.cy, x, cy, c.x + boxW + gap / 2, !!slot.empty));
        }
      });
    }
    return { width, height, html, links };
  }

  function layoutDescendants(root, G) {
    const m = treeMetrics();
    const { rem, gap } = m;
    const boxW = Math.min(m.maxW + 2 * rem, Math.max(m.minW, Math.floor((m.availW - gap * (G - 1)) / G)));
    const vgap = 0.75 * rem;
    const labelH = 2 * rem;
    const lineH = 1.25 * rem;
    const width = G * boxW + (G - 1) * gap;
    const used = new Set();

    function build(p, depth) {
      const fams = S.db.spouseFamilies(p);
      const withKids = fams.filter(f => f.children.length);
      const node = { p, depth, kids: [], extra: [] };
      const spouses = fams.filter(f => f.spouse);
      spouses.slice(0, 2).forEach(f => node.extra.push(`<b>${f.fam.married ? 'Gift med' : 'Partner:'}</b> ${esc(f.spouse.name)}`));
      if (spouses.length > 2) node.extra.push(`<b>og ${spouses.length - 2} til</b>`);
      const childCount = fams.reduce((n, f) => n + f.children.length, 0);
      if (depth < G - 1) {
        for (const f of fams) {
          for (const c of f.children) {
            if (used.has(c.id)) continue; // vern mot sløyfer i feil data
            used.add(c.id);
            const k = build(c, depth + 1);
            if (withKids.length > 1) {
              const o = f.spouse;
              const word = o ? (o.sex === 'F' ? 'Mor' : o.sex === 'M' ? 'Far' : 'Forelder') : 'Annen forelder';
              k.extra.push(`<b>${word}:</b> ${esc(o ? o.name : 'ikke registrert')}`);
            }
            node.kids.push(k);
          }
        }
      } else if (childCount) {
        node.more = `${childCount} barn ›`;
      }
      // Anslå om navnet går over to linjer (ca. 0,56 em per tegn i fet skrift)
      const fontPx = (depth === 0 ? 1.35 : 1) * rem;
      const twoLines = p.name.length * 0.56 * fontPx > boxW - 2.2 * rem;
      const base = depth === 0 ? (twoLines ? 8.8 : 7.2) * rem : (twoLines ? 6.2 : 4.9) * rem;
      node.h = Math.round(base + node.extra.length * lineH);
      return node;
    }
    used.add(root.id);
    const tree = build(root, 0);

    function measure(n) {
      n.kidsSpan = n.kids.reduce((s, k) => s + measure(k), 0);
      n.span = Math.max(n.h + vgap, n.kidsSpan);
      return n.span;
    }
    measure(tree);

    let html = '';
    const links = [];
    const colsUsed = new Set();
    // Forelderen står på høyde med første barn, så treet leses ovenfra og ned.
    function place(n, top) {
      const x = n.depth * (boxW + gap);
      let t = top;
      const kidCys = n.kids.map(k => { const c = place(k, t); t += k.span; return c; });
      const cy = labelH + top + Math.max(n.h / 2, kidCys.length ? kidCys[0] - labelH - top : 0);
      const y = Math.round(cy - n.h / 2);
      colsUsed.add(n.depth);
      html += boxHtml(n.p, {
        g: n.depth, x, y, w: boxW, h: n.h, root: n.depth === 0,
        extra: n.extra, more: n.more, href: '#/etterk/' + enc(n.p.id),
        rel: n.depth === 0 ? '' : childWord(n.p)
      });
      for (const kcy of kidCys) links.push(elbow(x + boxW, cy, x + boxW + gap, kcy, x + boxW + gap / 2));
      return cy;
    }
    place(tree, 0);
    for (const d of colsUsed) if (DESC_COLS[d]) html += `<div class="col-label" style="left:${d * (boxW + gap)}px;width:${boxW}px">${DESC_COLS[d]}</div>`;
    if (!tree.kids.length && !tree.more) {
      html += `<div class="col-label" style="left:${boxW + gap}px;width:${boxW}px;top:${labelH + tree.h / 2 - rem}px;text-transform:none;letter-spacing:0;font-size:1rem">Ingen barn er registrert.</div>`;
    }
    return { width, height: tree.span + labelH, html, links };
  }

  window.addEventListener('resize', debounce(() => {
    if (Math.abs(window.innerWidth - S.lastWidth) < 2) return;
    S.lastWidth = window.innerWidth;
    const r = parseRoute();
    if ((r.name === 'aner' || r.name === 'etterk') && S.db) {
      S.tree.G = genCount(r.name);
      renderTree(r.name, r.arg, { scroll: window.scrollY });
    }
  }, 180));

  // ===================== Innstillinger =====================

  function renderSettings() {
    document.title = 'Innstillinger – Slektstre';
    const size = prefs.get('tekst', 'normal');
    const sizeBtn = (k, l) => `<button type="button" class="btn${size === k ? ' is-on' : ''}" data-act="text-size" data-size="${k}" aria-pressed="${size === k}">${l}</button>`;
    const textCard = `<section class="card"><h2 class="card-title">Tekststørrelse</h2>
      <div class="btn-row">${sizeBtn('normal', 'Normal')}${sizeBtn('stor', 'Stor')}${sizeBtn('ekstra', 'Ekstra stor')}</div></section>`;

    if (!S.db) {
      $app.innerHTML = `<section class="settings"><h1 class="page-title">Innstillinger</h1>${textCard}
        <section class="card"><h2 class="card-title">Slektsfilen</h2><p>Ingen fil er åpnet ennå.</p>
        <div class="btn-row" style="margin-top:.8rem"><button type="button" class="btn btn-primary" data-act="open-file">Åpne slektsfil</button></div></section></section>`;
      return;
    }

    const f = S.file;
    const d = S.decoded;
    const db = S.db;
    const when = f && f.importedAt ? new Date(f.importedAt).toLocaleString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const program = [db.header.programName || db.header.program].filter(Boolean).join('');
    const samples = [];
    for (const p of db.persons.values()) {
      if (/[^\x00-\x7F]/.test(p.name)) samples.push(p.name);
      if (samples.length >= 6) break;
    }
    const override = f && f.override;
    const encBtn = (k, l) => `<button type="button" class="btn${(override || '') === k ? ' is-on' : ''}" data-act="encoding" data-enc="${k}">${l}</button>`;
    const home = homeId() ? db.person(homeId()) : null;

    $app.innerHTML = `<section class="settings">
      <h1 class="page-title">Innstillinger</h1>

      <section class="card"><h2 class="card-title">Slektsfilen</h2>
        <dl class="facts">
          <dt>Fil</dt><dd>${esc(f ? f.name : '–')}</dd>
          ${when ? `<dt>Lest inn</dt><dd>${esc(when)}</dd>` : ''}
          <dt>Innhold</dt><dd>${fmtNum(db.persons.size)} personer og ${fmtNum(db.families.size)} familier</dd>
          ${program ? `<dt>Laget med</dt><dd>${esc(program)}</dd>` : ''}
          <dt>Tegnsett</dt><dd>${esc(d.label)}<br><span class="muted" style="font-weight:500">${esc(d.reason)}</span></dd>
        </dl>
        <div class="btn-row" style="margin-top:1.2rem"><button type="button" class="btn btn-primary" data-act="open-file">Last inn ny versjon av filen</button></div>
        <p class="muted" style="margin-top:.8rem">Når treet er oppdatert i slektsprogrammet: lag en ny GEDCOM-fil og last den inn her. Den gamle blir erstattet.</p>
      </section>

      <section class="card"><h2 class="card-title">Æ, ø og å</h2>
        ${samples.length ? `<p>Slik ser noen av navnene ut:</p><div class="sample-names">${samples.map(n => `<span>${esc(n)}</span>`).join('')}</div>` : '<p>Fant ingen navn med æ, ø, å eller aksenter.</p>'}
        <p>Ser bokstavene feil ut? Prøv et annet tegnsett:</p>
        <div class="btn-row">${encBtn('', 'Automatisk')}${encBtn('utf-8', 'UTF-8')}${encBtn('ansel', 'ANSEL')}${encBtn('windows-1252', 'Windows (ANSI)')}${encBtn('cp865', 'DOS')}${encBtn('macintosh', 'Mac')}</div>
      </section>

      <section class="card"><h2 class="card-title">Hjem</h2>
        ${home ? `<div class="plist">${personButton(home, 'Hjem er nå')}</div>` : '<p>Ingen er valgt som Hjem ennå.</p>'}
        <div class="btn-row" style="margin-top:.9rem"><button type="button" class="btn" data-go="#/velg-hjem">Velg en annen person</button></div>
      </section>

      ${textCard}

      <section class="card"><h2 class="card-title">Lagring og personvern</h2>
        <p>Slektsfilen ligger bare på denne enheten, i nettleserens lagring. Den sendes ikke til noen server.</p>
        ${S.storageOk ? '' : '<p><b>Obs:</b> Filen kunne ikke lagres på denne enheten (for eksempel i privat surfing). Du må åpne den på nytt neste gang.</p>'}
        <p id="persist-note" class="muted"></p>
        <div class="btn-row" style="margin-top:1rem"><button type="button" class="btn btn-danger" data-act="remove-file">Fjern slektsfilen fra denne enheten</button></div>
      </section>
    </section>`;

    const note = document.getElementById('persist-note');
    const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    note.textContent = standalone
      ? 'Appen ligger på Hjem-skjermen, så iPaden tar vare på filen.'
      : 'Tips: Legg siden på Hjem-skjermen (Del-knappen ▸ «Legg til på Hjem-skjerm»). Da åpnes den som en egen app, og iPaden tar bedre vare på filen. Safari kan ellers slette lagrede data etter en tid uten bruk.';
  }

  // ===================== Handlinger =====================

  const actions = {
    'open-file'() { $fileInput.click(); },

    'set-home'(el) {
      prefs.set('hjem', el.dataset.id);
      const p = S.db.person(el.dataset.id);
      toast(`${p.name} er nå Hjem.`);
      render({ scroll: window.scrollY });
    },

    'choose-home'(el) {
      prefs.set('hjem', el.dataset.id);
      const p = S.db.person(el.dataset.id);
      toast(`${p.name} er nå Hjem.`);
      go('#/p/' + enc(p.id), { replace: true });
    },

    'clear-search'() {
      const q = document.getElementById('q');
      q.value = '';
      q.dispatchEvent(new Event('input'));
      q.focus();
    },

    gens(el) {
      prefs.set('gen.' + el.dataset.view, +el.dataset.n);
      S.tree.G = +el.dataset.n;
      document.querySelectorAll('.gens button').forEach(b => {
        const on = b === el;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on);
      });
      layoutTree({ animate: true, center: true });
    },

    'text-size'(el) {
      prefs.set('tekst', el.dataset.size);
      applyTextSize();
      renderSettings();
    },

    async encoding(el) {
      const choice = el.dataset.enc || null;
      showLoading('Leser filen på nytt …');
      await nextFrame();
      try {
        const { db, decoded } = loadBytes(S.file.bytes, choice);
        S.db = db;
        S.decoded = decoded;
        S.file.override = choice;
        try { await idb.set('aktiv', S.file); } catch (e) { S.storageOk = false; }
        toast(choice ? `Tegnsett: ${ENCODINGS[choice].label}` : `Automatisk valg: ${decoded.label}`);
      } catch (e) {
        toast('Det tegnsettet fungerte ikke for denne filen.');
      }
      renderSettings();
    },

    async 'remove-file'(el) {
      if (!el.classList.contains('is-armed')) {
        el.classList.add('is-armed');
        el.textContent = 'Trykk igjen for å fjerne filen';
        setTimeout(() => {
          if (el.isConnected) { el.classList.remove('is-armed'); el.textContent = 'Fjern slektsfilen fra denne enheten'; }
        }, 5000);
        return;
      }
      try { await idb.del('aktiv'); } catch (e) { /* ignorer */ }
      S.db = null; S.file = null; S.decoded = null;
      prefs.del('hjem'); prefs.del('nylig');
      toast('Slektsfilen er fjernet fra denne enheten.');
      S.depth = 0;
      go('#/', { replace: true });
    }
  };

  function applyTextSize() {
    const size = prefs.get('tekst', 'normal');
    if (size === 'normal') document.documentElement.removeAttribute('data-text');
    else document.documentElement.setAttribute('data-text', size);
  }

  // ===================== Oppstart =====================

  async function start() {
    applyTextSize();
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    S.depth = (history.state && history.state.depth) || 0;
    if (!history.state) history.replaceState({ depth: 0, scroll: 0 }, '');
    showLoading('Åpner slektstreet …');

    let rec = null;
    try { rec = await idb.get('aktiv'); }
    catch (e) { S.storageOk = false; }

    if (rec && rec.bytes) {
      await nextFrame();
      try {
        const { db, decoded } = loadBytes(rec.bytes, rec.override);
        S.db = db; S.decoded = decoded; S.file = rec;
      } catch (e) {
        render();
        renderWelcome(errorText(e, rec.name));
        return;
      }
    }
    render({ fresh: true });

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* fungerer uten */ });
    }
  }

  start();
})();
