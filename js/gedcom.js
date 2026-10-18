/*
 * GEDCOM-leser: gjør teksten om til personer og familier.
 * Leser bare – ingenting skrives tilbake.
 */
(function (root) {
  'use strict';

  const LINE_RE = /^\s*(\d{1,2})\s+(?:(@[^@\s]+@)\s+)?(\S+)(?: (.*))?$/;

  const EVENT_LABELS = {
    BIRT: 'Født', CHR: 'Døpt', BAPM: 'Døpt', BLES: 'Velsignet', CONF: 'Konfirmert',
    FCOM: 'Første nattverd', ADOP: 'Adoptert', BARM: 'Bar mitzva', BASM: 'Bat mitzva',
    DEAT: 'Død', BURI: 'Gravlagt', CREM: 'Kremert',
    MARR: 'Gift', MARB: 'Lysning', MARC: 'Ektepakt', MARL: 'Vigselsbrev', MARS: 'Ekteskapsavtale',
    ENGA: 'Forlovet', DIV: 'Skilt', DIVF: 'Skilsmisse begjært', ANUL: 'Ekteskap annullert',
    EMIG: 'Utvandret', IMMI: 'Innvandret', NATU: 'Statsborgerskap', CENS: 'Folketelling',
    RESI: 'Bosted', OCCU: 'Yrke', EDUC: 'Utdanning', GRAD: 'Eksamen', RETI: 'Pensjonert',
    PROB: 'Skifte', WILL: 'Testamente', ORDN: 'Ordinert', RELI: 'Religion', TITL: 'Tittel',
    NATI: 'Nasjonalitet', DSCR: 'Beskrivelse', PROP: 'Eiendom', CAST: 'Stand',
    EVEN: 'Hendelse', FACT: 'Opplysning',
    _MILT: 'Militærtjeneste', _MDCL: 'Helse', _DEG: 'Grad', _ELEC: 'Valgt', _FUN: 'Begravelse',
    _HEIG: 'Høyde', _WEIG: 'Vekt'
  };
  const BIRTH_TAGS = new Set(['BIRT', 'CHR', 'BAPM']);
  const DEATH_TAGS = new Set(['DEAT', 'BURI', 'CREM', 'PROB']);
  const NO_AGE_TAGS = new Set(['BIRT', 'CHR', 'BAPM', 'BURI', 'CREM', 'PROB', 'WILL']);

  const MONTHS = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, MAI: 5, JUN: 6, JUL: 7, AUG: 8,
    SEP: 9, OCT: 10, OKT: 10, NOV: 11, DEC: 12, DES: 12
  };
  const MONTH_LONG = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
  const MONTH_SHORT = ['jan.', 'feb.', 'mars', 'apr.', 'mai', 'juni', 'juli', 'aug.', 'sep.', 'okt.', 'nov.', 'des.'];

  // ---------- Linjer til tre ----------

  function parseLines(text) {
    const lines = text.split(/\r\n|\n|\r/);
    const records = [];
    const stack = [];
    let last = null;
    for (const raw of lines) {
      if (!raw) continue;
      const m = LINE_RE.exec(raw);
      if (!m) {
        // Linje uten nivånummer: noen program bryter lange notater slik.
        if (last && raw.trim()) last.value = (last.value ? last.value + '\n' : '') + raw.trim();
        continue;
      }
      const level = +m[1];
      const tag = m[3].toUpperCase();
      const value = m[4] === undefined ? '' : m[4];
      if (tag === 'CONC' || tag === 'CONT') {
        const parent = stack[level - 1];
        if (parent) parent.value = (parent.value || '') + (tag === 'CONT' ? '\n' : '') + value;
        continue;
      }
      const node = { tag, value, xref: m[2] || null, children: [] };
      if (level === 0) {
        records.push(node);
        stack.length = 0;
        stack[0] = node;
      } else {
        const parent = stack[level - 1];
        if (!parent) continue;
        parent.children.push(node);
        stack[level] = node;
        stack.length = level + 1;
      }
      last = node;
    }
    return records;
  }

  const strip = v => (v || '').trim().replace(/^@|@$/g, '');
  const clean = v => (v || '').replace(/@@/g, '@').trim();
  const first = (node, tag) => node.children.find(c => c.tag === tag) || null;
  const all = (node, tag) => node.children.filter(c => c.tag === tag);
  const val = (node, tag) => { const c = first(node, tag); return c ? clean(c.value) : ''; };
  const isPointer = v => /^@[^@\s]+@$/.test((v || '').trim());

  // ---------- Datoer ----------

  function parseSimpleDate(s) {
    s = s.trim();
    let m = /^(?:(\d{1,2})(?:\.\s*|\s+|(?=[A-Za-zæøåÆØÅ])))?(?:([A-Za-zæøåÆØÅ]{3,})\.?\s*)?(\d{3,4})(?:\/(\d{1,4}))?(\s*B\.?\s?C\.?)?$/.exec(s);
    if (m) {
      const day = m[1] ? +m[1] : null;
      let mon = null;
      if (m[2]) {
        mon = MONTHS[m[2].slice(0, 3).toUpperCase()] || null;
        if (!mon) return null;
      }
      if (day && !mon) return null;
      if (day && (day < 1 || day > 31)) return null;
      return { d: day, m: mon, y: +m[3], dual: m[4] || null, bc: !!m[5] };
    }
    // 12.03.1850 eller 1850-03-12
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    if (m && +m[2] >= 1 && +m[2] <= 12) return { d: +m[1], m: +m[2], y: +m[3] };
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m && +m[2] >= 1 && +m[2] <= 12) return { d: +m[3], m: +m[2], y: +m[1] };
    return null;
  }

  function fmtSimple(p, short) {
    const months = short ? MONTH_SHORT : MONTH_LONG;
    let y = String(p.y);
    if (p.dual) y += '/' + p.dual;
    if (p.bc) y += ' f.Kr.';
    if (p.d && p.m) return `${p.d}. ${months[p.m - 1]} ${y}`;
    if (p.m) return `${months[p.m - 1]} ${y}`;
    return y;
  }

  /**
   * Tolker en GEDCOM-dato. Ukjente formater vises som de står.
   * @returns {{raw, text, short, y, m, d, approx, sort}}
   */
  function parseDate(raw) {
    const out = { raw: raw || '', text: '', short: '', y: null, m: null, d: null, approx: false, sort: null };
    let s = clean(raw);
    if (!s) return out;
    out.text = out.short = s;

    // Tekst i parentes: (ukjent dato)
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) { out.text = out.short = paren[1]; return withYear(out, s); }

    const up = s.toUpperCase();
    let m;
    const one = (prefix, rest, approx) => {
      const p = parseSimpleDate(rest);
      if (!p) return false;
      out.text = (prefix ? prefix + ' ' : '') + fmtSimple(p, false);
      out.short = (prefix ? prefix + ' ' : '') + fmtSimple(p, true);
      Object.assign(out, { y: p.y, m: p.m, d: p.d, approx });
      return true;
    };
    const two = (w1, a, w2, b) => {
      const p = parseSimpleDate(a), q = parseSimpleDate(b);
      if (!p || !q) return false;
      out.text = `${w1} ${fmtSimple(p, false)} ${w2} ${fmtSimple(q, false)}`;
      out.short = `${w1} ${fmtSimple(p, true)} ${w2} ${fmtSimple(q, true)}`;
      Object.assign(out, { y: p.y, m: p.m, d: p.d, approx: true });
      return true;
    };

    let ok = false;
    if ((m = /^(ABT|ABOUT|CA|CIRCA|C|EST|CAL)\.?\s+(.+)$/.exec(up))) ok = one('ca.', s.slice(s.length - m[2].length), true);
    else if ((m = /^BEF\.?\s+(.+)$/.exec(up))) ok = one('før', s.slice(s.length - m[1].length), true);
    else if ((m = /^AFT\.?\s+(.+)$/.exec(up))) ok = one('etter', s.slice(s.length - m[1].length), true);
    else if ((m = /^BET\.?\s+(.+?)\s+AND\s+(.+)$/.exec(up))) {
      const a = s.substr(up.indexOf(m[1]), m[1].length), b = s.slice(s.length - m[2].length);
      ok = two('mellom', a, 'og', b);
    } else if ((m = /^FROM\s+(.+?)\s+TO\s+(.+)$/.exec(up))) {
      const a = s.substr(up.indexOf(m[1]), m[1].length), b = s.slice(s.length - m[2].length);
      ok = two('fra', a, 'til', b);
    } else if ((m = /^FROM\s+(.+)$/.exec(up))) ok = one('fra', s.slice(s.length - m[1].length), false);
    else if ((m = /^TO\s+(.+)$/.exec(up))) ok = one('til', s.slice(s.length - m[1].length), true);
    else if ((m = /^INT\s+(.+?)\s*(\(.*\))?$/.exec(up))) ok = one('', s.substr(4, m[1].length), false);
    else ok = one('', s, false);

    if (!ok) return withYear(out, s);
    out.sort = out.y * 10000 + (out.m || 0) * 100 + (out.d || 0);
    return out;
  }

  function withYear(out, s) {
    const y = /\b(\d{3,4})\b/.exec(s);
    if (y) { out.y = +y[1]; out.approx = true; out.sort = out.y * 10000; }
    return out;
  }

  /** Alder mellom to tolkede datoer, f.eks. «80 år» eller «ca. 80 år». */
  function ageBetween(a, b) {
    if (!a || !b || !a.y || !b.y) return null;
    let age = b.y - a.y;
    if (a.m && b.m && (b.m < a.m || (b.m === a.m && a.d && b.d && b.d < a.d))) age--;
    if (age < 0 || age > 125) return null;
    const exact = !a.approx && !b.approx && a.m && b.m && a.d && b.d;
    if (age === 0 && exact) return null;
    return (exact ? '' : 'ca. ') + age + ' år';
  }

  // ---------- Søk ----------

  /** Gjør tekst sammenlignbar: små bokstaver, uten aksenter, å=aa=a, ø=o, æ=ae. */
  function fold(s) {
    return (s || '').toLowerCase()
      .replace(/æ/g, 'ae').replace(/[øö]/g, 'o').replace(/œ/g, 'oe').replace(/ß/g, 'ss')
      .replace(/ð/g, 'd').replace(/þ/g, 'th').replace(/ł/g, 'l')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/aa/g, 'a');
  }
  const tokenize = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

  // ---------- Modell ----------

  function parseName(node) {
    const raw = clean(node.value);
    let given = '', surname = '', suffix = '';
    const m = /^([^/]*)\/([^/]*)\/?(.*)$/.exec(raw);
    if (m) { given = m[1].trim(); surname = m[2].trim(); suffix = m[3].trim(); }
    else given = raw;
    if (!given) given = val(node, 'GIVN');
    if (!surname) surname = val(node, 'SURN');
    const nick = val(node, 'NICK');
    const full = [given, surname, suffix].filter(Boolean).join(' ').replace(/\s+/g, ' ');
    const extra = [];
    for (const t of ['_MARNM', '_AKA', '_AKAN']) {
      for (const c of all(node, t)) if (clean(c.value)) extra.push(clean(c.value).replace(/\//g, ''));
    }
    return { full, given, surname, nick, type: val(node, 'TYPE').toLowerCase(), extra };
  }

  function build(records) {
    const notes = new Map(), sources = new Map(), repos = new Map();
    const indis = [], fams = [];
    let header = null;
    for (const r of records) {
      if (r.tag === 'HEAD') header = r;
      else if (r.tag === 'INDI' && r.xref) indis.push(r);
      else if (r.tag === 'FAM' && r.xref) fams.push(r);
      else if (r.tag === 'NOTE' && r.xref) notes.set(strip(r.xref), clean(r.value));
      else if (r.tag === 'SOUR' && r.xref) sources.set(strip(r.xref), r);
      else if (r.tag === 'REPO' && r.xref) repos.set(strip(r.xref), val(r, 'NAME'));
    }

    const noteText = n => {
      if (isPointer(n.value)) return notes.get(strip(n.value)) || '';
      return clean(n.value);
    };
    const sourceInfo = s => {
      const out = { title: '', page: '', text: '', note: '' };
      if (isPointer(s.value)) {
        const rec = sources.get(strip(s.value));
        if (rec) {
          out.title = val(rec, 'TITL') || val(rec, 'ABBR') || clean(rec.value);
          const auth = val(rec, 'AUTH'), publ = val(rec, 'PUBL');
          out.detail = [auth, publ].filter(Boolean).join('. ');
          const repo = first(rec, 'REPO');
          if (repo && repos.get(strip(repo.value))) out.repo = repos.get(strip(repo.value));
          const t = first(rec, 'TEXT');
          if (t) out.text = clean(t.value);
        }
      } else {
        out.title = clean(s.value);
      }
      out.page = val(s, 'PAGE');
      const data = first(s, 'DATA');
      if (data && first(data, 'TEXT')) out.text = clean(first(data, 'TEXT').value) || out.text;
      const n = first(s, 'NOTE');
      if (n) out.note = noteText(n);
      return out;
    };

    function buildEvent(node, index) {
      const tag = node.tag;
      let label = EVENT_LABELS[tag] || tag;
      const type = val(node, 'TYPE');
      if ((tag === 'EVEN' || tag === 'FACT') && type) label = type;
      let value = clean(node.value);
      const flagged = value.toUpperCase() === 'Y';
      if (flagged) value = '';
      if (isPointer(value)) value = '';
      const date = parseDate(val(node, 'DATE'));
      const place = val(node, 'PLAC');
      const evNotes = all(node, 'NOTE').map(noteText).filter(Boolean);
      const evSources = all(node, 'SOUR').map(sourceInfo).filter(s => s.title || s.page || s.text);
      const cause = val(node, 'CAUS');
      const age = val(node, 'AGE');
      const addr = first(node, 'ADDR') ? clean(first(node, 'ADDR').value) : '';
      const empty = !date.raw && !place && !value && !evNotes.length && !evSources.length && !cause && !addr;
      if (empty && !flagged) return null;
      // EVEN/FACT med type men ellers ingenting gir lite mening å vise
      return { tag, label, value, date, place, addr, notes: evNotes, sources: evSources, cause, age, index };
    }

    const persons = new Map();
    for (const r of indis) {
      const p = {
        id: strip(r.xref), names: [], sex: 'U', events: [],
        famcRefs: [], famsRefs: [], notes: [], sources: [], index: persons.size
      };
      r.children.forEach((c, i) => {
        switch (c.tag) {
          case 'NAME': p.names.push(parseName(c)); break;
          case 'SEX': {
            const s = clean(c.value).toUpperCase()[0];
            p.sex = s === 'M' || s === 'F' ? s : 'U';
            break;
          }
          case 'FAMC': p.famcRefs.push({ id: strip(c.value), pedi: val(c, 'PEDI').toLowerCase() }); break;
          case 'FAMS': p.famsRefs.push(strip(c.value)); break;
          case 'NOTE': { const t = noteText(c); if (t) p.notes.push(t); break; }
          case 'SOUR': { const s = sourceInfo(c); if (s.title || s.page || s.text) p.sources.push(s); break; }
          default:
            if (EVENT_LABELS[c.tag]) {
              const ev = buildEvent(c, i);
              if (ev) p.events.push(ev);
            }
        }
      });
      const n = p.names[0] || { full: '', given: '', surname: '' };
      p.name = n.full || 'Uten navn';
      p.given = n.given;
      p.surname = n.surname;
      p.aka = [];
      for (const nm of p.names.slice(1)) if (nm.full && nm.full !== p.name) p.aka.push(nm.full);
      for (const nm of p.names) {
        if (nm.nick) p.aka.push('«' + nm.nick + '»');
        for (const x of nm.extra) if (x !== p.name) p.aka.push(x);
      }
      p.aka = [...new Set(p.aka)];
      persons.set(p.id, p);
    }

    const families = new Map();
    for (const r of fams) {
      const f = { id: strip(r.xref), husb: null, wife: null, children: [], events: [], notes: [], married: true };
      r.children.forEach((c, i) => {
        switch (c.tag) {
          case 'HUSB': if (persons.has(strip(c.value))) f.husb = strip(c.value); break;
          case 'WIFE': if (persons.has(strip(c.value))) f.wife = strip(c.value); break;
          case 'CHIL': {
            const id = strip(c.value);
            if (persons.has(id) && !f.children.includes(id)) f.children.push(id);
            break;
          }
          case 'NOTE': { const t = noteText(c); if (t) f.notes.push(t); break; }
          case '_MARRIED': if (/^N/i.test(clean(c.value))) f.married = false; break;
          case '_STAT': if (/NOT\s*MARRIED|UNMARRIED|UGIFT/i.test(clean(c.value))) f.married = false; break;
          default:
            if (EVENT_LABELS[c.tag]) {
              const ev = buildEvent(c, i);
              if (ev) f.events.push(ev);
            }
        }
      });
      if (f.events.some(e => e.tag === 'MARR')) f.married = true;
      families.set(f.id, f);
    }

    // Familieposten er fasiten for hvem som hører sammen. Personens egne
    // FAMS/FAMC-lenker brukes bare til rekkefølgen.
    for (const p of persons.values()) { p.fams = []; p.famc = []; }
    for (const p of persons.values()) {
      for (const id of p.famsRefs) {
        const f = families.get(id);
        if (f && (f.husb === p.id || f.wife === p.id) && !p.fams.includes(id)) p.fams.push(id);
      }
      for (const ref of p.famcRefs) {
        const f = families.get(ref.id);
        if (f && f.children.includes(p.id) && !p.famc.some(x => x.id === ref.id)) p.famc.push(ref);
      }
    }
    for (const f of families.values()) {
      for (const pid of [f.husb, f.wife]) {
        if (pid && !persons.get(pid).fams.includes(f.id)) persons.get(pid).fams.push(f.id);
      }
      for (const cid of f.children) {
        const c = persons.get(cid);
        if (!c.famc.some(x => x.id === f.id)) c.famc.push({ id: f.id, pedi: '' });
      }
    }

    // Avledede felt
    for (const p of persons.values()) {
      delete p.famsRefs; delete p.famcRefs;
      const pick = tags => { for (const t of tags) { const e = p.events.find(ev => ev.tag === t && (ev.date.y || ev.place)); if (e) return e; } return null; };
      p.birth = pick(['BIRT', 'CHR', 'BAPM']);
      p.death = pick(['DEAT', 'BURI', 'CREM']);
      p.deceased = !!p.death || p.events.some(e => DEATH_TAGS.has(e.tag));
      p.lifespan = lifespan(p);
      const words = [p.name, ...p.aka].join(' ');
      p.tokens = [...new Set(tokenize(words))];
      p.firstToken = tokenize(p.given)[0] || '';
    }

    const headerInfo = header ? {
      program: val(header, 'SOUR') || '',
      programName: first(header, 'SOUR') ? val(first(header, 'SOUR'), 'NAME') : '',
      date: val(header, 'DATE'),
      file: val(header, 'FILE')
    } : {};

    return makeDb(persons, families, headerInfo);
  }

  function yearText(ev) {
    if (!ev || !ev.date.y) return '';
    return (ev.date.approx ? 'ca. ' : '') + ev.date.y;
  }

  function lifespan(p) {
    const b = yearText(p.birth);
    const d = yearText(p.death);
    if (b && d) return `${b}–${d}`;
    if (b) return p.birth.tag === 'BIRT' ? `f. ${b}` : `døpt ${b}`;
    if (d) return p.death.tag === 'DEAT' ? `d. ${d}` : `gravlagt ${d}`;
    return '';
  }

  // ---------- Spørringer ----------

  function makeDb(persons, families, header) {
    const P = id => persons.get(id) || null;

    function parentFamilies(p) {
      return p.famc.map(ref => {
        const f = families.get(ref.id);
        return { fam: f, father: P(f.husb), mother: P(f.wife), pedi: ref.pedi };
      });
    }

    function spouseFamilies(p) {
      return p.fams.map(fid => {
        const f = families.get(fid);
        const spouseId = f.husb === p.id ? f.wife : f.husb;
        return { fam: f, spouse: P(spouseId), children: f.children.map(P).filter(Boolean) };
      });
    }

    function parents(p) {
      const pf = parentFamilies(p).find(x => x.pedi !== 'adopted' && x.pedi !== 'foster') || parentFamilies(p)[0];
      return pf ? { father: pf.father, mother: pf.mother, fam: pf.fam } : { father: null, mother: null, fam: null };
    }

    function children(p) {
      const out = [];
      for (const sf of spouseFamilies(p)) for (const c of sf.children) if (!out.includes(c)) out.push(c);
      return out;
    }

    function siblings(p) {
      const out = [];
      const seen = new Set([p.id]);
      const pfs = parentFamilies(p);
      for (const pf of pfs) {
        for (const cid of pf.fam.children) {
          if (seen.has(cid)) continue;
          seen.add(cid);
          out.push({ person: P(cid), half: false });
        }
      }
      for (const pf of pfs) {
        for (const parent of [pf.father, pf.mother]) {
          if (!parent) continue;
          for (const fid of parent.fams) {
            if (fid === pf.fam.id) continue;
            for (const cid of families.get(fid).children) {
              if (seen.has(cid)) continue;
              seen.add(cid);
              out.push({ person: P(cid), half: true, via: parent });
            }
          }
        }
      }
      return out;
    }

    /** Alle hendelser i livsløpet, inkludert ekteskap, i fornuftig rekkefølge. */
    function timeline(p) {
      const list = p.events.map(e => ({ ...e }));
      for (const sf of spouseFamilies(p)) {
        for (const e of sf.fam.events) list.push({ ...e, spouse: sf.spouse, family: true });
      }
      const group = e => BIRTH_TAGS.has(e.tag) ? 0 : DEATH_TAGS.has(e.tag) ? 2 : 1;
      const ordered = list.map((e, i) => ({ e, i, g: group(e) }));
      ordered.sort((a, b) => {
        if (a.g !== b.g) return a.g - b.g;
        if (a.g === 0 || a.g === 2) {
          const order = ['BIRT', 'CHR', 'BAPM', 'DEAT', 'BURI', 'CREM', 'PROB'];
          return order.indexOf(a.e.tag) - order.indexOf(b.e.tag);
        }
        const as = a.e.date.sort, bs = b.e.date.sort;
        if (as != null && bs != null && as !== bs) return as - bs;
        if (as != null && bs == null) return -1;
        if (as == null && bs != null) return 1;
        return a.i - b.i;
      });
      const birthDate = p.birth && p.birth.date;
      return ordered.map(({ e }) => {
        if (!NO_AGE_TAGS.has(e.tag) && e.date.y) e.ageText = ageBetween(birthDate, e.date);
        return e;
      });
    }

    function search(query, limit = 80) {
      const words = String(query || '').trim().split(/\s+/).filter(Boolean);
      const years = [];
      const toks = [];
      for (const w of words) {
        if (/^\d{3,4}$/.test(w)) years.push(+w);
        else toks.push(...tokenize(w));
      }
      if (!toks.length && !years.length) return { total: 0, results: [] };
      const hits = [];
      for (const p of persons.values()) {
        let score = 0;
        let ok = true;
        for (const t of toks) {
          let best = 0;
          for (const pt of p.tokens) {
            if (pt === t) { best = 3; break; }
            if (best < 1 && pt.startsWith(t)) best = 1;
          }
          if (!best) { ok = false; break; }
          score += best;
        }
        if (!ok) continue;
        if (toks.length && p.firstToken && p.firstToken.startsWith(toks[0])) score += 1;
        for (const y of years) {
          const by = p.birth && p.birth.date.y, dy = p.death && p.death.date.y;
          if (by && Math.abs(by - y) <= 2) score += by === y ? 3 : 1;
          else if (dy === y) score += 2;
          else { ok = false; break; }
        }
        if (!ok) continue;
        hits.push({ p, score });
      }
      hits.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ay = a.p.birth ? a.p.birth.date.y : null, by = b.p.birth ? b.p.birth.date.y : null;
        if (ay && by && ay !== by) return ay - by;
        if (ay && !by) return -1;
        if (!ay && by) return 1;
        return a.p.name.localeCompare(b.p.name, 'nb');
      });
      return { total: hits.length, results: hits.slice(0, limit).map(h => h.p) };
    }

    return {
      persons, families, header,
      person: P, parentFamilies, spouseFamilies, parents, children, siblings, timeline, search
    };
  }

  function parseGedcom(text) {
    const records = parseLines(text);
    if (!records.length || records[0].tag !== 'HEAD') {
      const err = new Error('Ikke en GEDCOM-fil');
      err.code = 'NOT_GEDCOM';
      throw err;
    }
    return build(records);
  }

  const api = { parseGedcom, parseDate, ageBetween, fold, tokenize, EVENT_LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Gedcom = api;
})(typeof window !== 'undefined' ? window : globalThis);
