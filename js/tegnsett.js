/*
 * Tegnsett for GEDCOM-filer.
 *
 * Eldre slektsprogram skriver ofte ANSEL, Windows-1252 eller DOS-tegnsett,
 * og CHAR-linjen i filhodet er ikke alltid riktig. Vi leser derfor filen som
 * bytes, prøver de aktuelle tegnsettene og velger det som gir mest
 * troverdig tekst (æ, ø, å og vanlige aksenter fremfor rot).
 */
(function (root) {
  'use strict';

  // Øvre halvdel (0x80–0xFF) av DOS-tegnsettene. Nettlesere har ikke disse innebygd.
  const CP850 =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
    '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';
  const CP865 =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø₧ƒáíóúñÑªº¿⌐¬½¼¡«¤░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

  // ANSEL (ANSI Z39.47) slik GEDCOM 5.5 bruker det.
  const ANSEL_SPACING = {
    0xA1: 'Ł', 0xA2: 'Ø', 0xA3: 'Đ', 0xA4: 'Þ', 0xA5: 'Æ', 0xA6: 'Œ', 0xA7: 'ʹ',
    0xA8: '·', 0xA9: '♭', 0xAA: '®', 0xAB: '±', 0xAC: 'Ơ', 0xAD: 'Ư', 0xAE: 'ʼ',
    0xB0: 'ʻ', 0xB1: 'ł', 0xB2: 'ø', 0xB3: 'đ', 0xB4: 'þ', 0xB5: 'æ', 0xB6: 'œ',
    0xB7: 'ʺ', 0xB8: 'ı', 0xB9: '£', 0xBA: 'ð', 0xBC: 'ơ', 0xBD: 'ư', 0xBE: '□',
    0xBF: '■', 0xC0: '°', 0xC1: 'ℓ', 0xC2: '℗', 0xC3: '©', 0xC4: '♯', 0xC5: '¿',
    0xC6: '¡', 0xC7: 'ß', 0xC8: '€', 0xCD: 'e', 0xCE: 'o', 0xCF: 'ß'
  };
  // Kombinerende tegn står FØR bokstaven i ANSEL, men ETTER i Unicode.
  const ANSEL_COMBINING = {
    0xE0: 0x0309, 0xE1: 0x0300, 0xE2: 0x0301, 0xE3: 0x0302, 0xE4: 0x0303,
    0xE5: 0x0304, 0xE6: 0x0306, 0xE7: 0x0307, 0xE8: 0x0308, 0xE9: 0x030C,
    0xEA: 0x030A, 0xEB: 0xFE20, 0xEC: 0xFE21, 0xED: 0x0315, 0xEE: 0x030B,
    0xEF: 0x0310, 0xF0: 0x0327, 0xF1: 0x0328, 0xF2: 0x0323, 0xF3: 0x0324,
    0xF4: 0x0325, 0xF5: 0x0333, 0xF6: 0x0332, 0xF7: 0x0326, 0xF8: 0x031C,
    0xF9: 0x032E, 0xFA: 0xFE22, 0xFB: 0xFE23, 0xFE: 0x0313
  };

  const ENCODINGS = {
    'utf-8':        { label: 'UTF-8 (Unicode)' },
    'utf-16le':     { label: 'UTF-16 (Unicode)' },
    'utf-16be':     { label: 'UTF-16 (Unicode)' },
    'ansel':        { label: 'ANSEL' },
    'windows-1252': { label: 'Windows (ANSI)' },
    'cp865':        { label: 'DOS nordisk (IBM 865)' },
    'cp850':        { label: 'DOS (IBM 850)' },
    'macintosh':    { label: 'Mac (MacRoman)' }
  };

  // Rekkefølgen brukes som tie-breaker når to tegnsett gir like god tekst.
  const SINGLE_BYTE = ['windows-1252', 'ansel', 'cp865', 'cp850', 'macintosh'];

  function decodeTable(bytes, table) {
    const out = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      out[i] = b < 0x80 ? String.fromCharCode(b) : table[b - 0x80];
    }
    return out.join('');
  }

  function decodeAnsel(bytes) {
    const out = new Uint16Array(bytes.length * 2 + 16);
    let n = 0;
    const pending = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const mark = ANSEL_COMBINING[b];
      if (mark) { pending.push(mark); continue; }
      let code;
      if (b < 0x80) code = b;
      else if (ANSEL_SPACING[b]) code = ANSEL_SPACING[b].charCodeAt(0);
      else if (b >= 0x80 && b <= 0x9F) code = -1; // kontrolltegn (f.eks. 0x88/0x89): hoppes over
      else code = 0xFFFD;
      if (code < 0) continue;
      out[n++] = code;
      if (pending.length) {
        if (code !== 10 && code !== 13) for (const m of pending) out[n++] = m;
        pending.length = 0;
      }
    }
    let s = '';
    for (let i = 0; i < n; i += 8192) {
      s += String.fromCharCode.apply(null, out.subarray(i, Math.min(n, i + 8192)));
    }
    return s;
  }

  function decodeWith(enc, bytes) {
    switch (enc) {
      case 'ansel': return decodeAnsel(bytes);
      case 'cp850': return decodeTable(bytes, CP850);
      case 'cp865': return decodeTable(bytes, CP865);
      case 'utf-8': return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      default: return new TextDecoder(enc).decode(bytes);
    }
  }

  // Tegn som er vanlige i norske og nordiske slektsdata.
  const NORDIC = new Set('æøåÆØÅ');
  const COMMON = new Set('äöüÄÖÜéèêëáàâóòôúùûíìîïçñÉÈÁÀÓÚÍÇÑßý–—’‘“”«»…');
  const SUSPECT = new Set('¤¥¦§¨©ª¬®¯±²³´µ¶¸¹º¼½¾¿×÷ƒ‗¢£€ıłŁđĐþÞœŒðÐʹʺʻʼ□■♭♯℗ℓαΓπΣστΦΘΩδ∞φε∩≡≥≤⌠⌡≈∙√ⁿ⌐₧ÃÂ');

  // Høy poengsum = troverdig tekst. Ser bare på tegn utenfor ASCII.
  function scoreText(s) {
    let score = 0;
    let prev = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 128) { prev = c; continue; }
      const ch = s[i];
      if (c === 0xFFFD) score -= 10;
      else if (c <= 0x9F) score -= 10;
      else if (NORDIC.has(ch)) score += 3;
      else if (COMMON.has(ch)) score += 1.5;
      else if (c >= 0x0300 && c <= 0x036F) score -= 4; // løse aksenter som ikke ble satt sammen
      else if (c >= 0xFE20 && c <= 0xFE23) score -= 4;
      else if (c >= 0x2500 && c <= 0x25FF) score -= 5; // rammetegn fra DOS
      else if (SUSPECT.has(ch)) score -= 3;
      else score -= 1;
      // Bokstav rett etter et siffer eller mellomrom er normalt; aksent rett etter mellomrom er ikke det.
      if (c >= 0x0300 && c <= 0x036F && (prev === 32 || prev === 0)) score -= 4;
      prev = c;
    }
    return score;
  }

  function readDeclared(bytes) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const m = /(?:^|[\r\n])\s*1\s+CHAR\s+([^\r\n]+)/i.exec(head);
    if (!m) return { raw: null, enc: null };
    const raw = m[1].trim();
    const key = raw.toUpperCase().replace(/[\s_]/g, '');
    let enc = null;
    if (key === 'UTF-8' || key === 'UTF8') enc = 'utf-8';
    else if (key === 'UNICODE' || key === 'UTF-16' || key === 'UTF16') enc = 'utf-16le';
    else if (key === 'ANSEL') enc = 'ansel';
    else if (/^(ANSI|WINDOWS|CP1252|WINDOWS-1252|ISO-?8859-?1|LATIN-?1|IBMWINDOWS)$/.test(key)) enc = 'windows-1252';
    else if (/^(IBMPC|IBM-PC|IBMDOS|DOS|CP850|MSDOS)$/.test(key)) enc = 'cp850';
    else if (key === 'CP865') enc = 'cp865';
    else if (/^(MACINTOSH|MAC|MACROMAN)$/.test(key)) enc = 'macintosh';
    return { raw, enc };
  }

  function hasHighBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7F) return true;
    return false;
  }

  /**
   * Leser GEDCOM-bytes som tekst.
   * @param {Uint8Array} bytes
   * @param {string|null} override  tvunget tegnsett (fra innstillingene), ellers automatisk
   * @returns {{text, encoding, label, declared, declaredRaw, auto, reason}}
   */
  function decodeGedcom(bytes, override) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const declared = readDeclared(bytes);
    const result = (encoding, text, reason, auto) => ({
      text: text.replace(/^﻿/, '').normalize('NFC'),
      encoding,
      label: ENCODINGS[encoding].label,
      declared: declared.enc,
      declaredRaw: declared.raw,
      auto,
      reason
    });

    if (override && ENCODINGS[override]) {
      let text;
      try { text = decodeWith(override, bytes); }
      catch (e) { text = new TextDecoder(override === 'utf-8' ? 'utf-8' : 'windows-1252').decode(bytes); }
      return result(override, text, 'Valgt manuelt i innstillingene.', false);
    }

    // Byte order mark
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return result('utf-8', new TextDecoder('utf-8').decode(bytes), 'Filen er merket som UTF-8.', true);
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return result('utf-16le', new TextDecoder('utf-16le').decode(bytes), 'Filen er merket som UTF-16.', true);
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return result('utf-16be', new TextDecoder('utf-16be').decode(bytes), 'Filen er merket som UTF-16.', true);
    }
    // UTF-16 uten merke: «0 HEAD» med nullbytes mellom tegnene
    if (bytes[0] === 0x30 && bytes[1] === 0x00) {
      return result('utf-16le', new TextDecoder('utf-16le').decode(bytes), 'Filen ser ut til å være UTF-16.', true);
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x30) {
      return result('utf-16be', new TextDecoder('utf-16be').decode(bytes), 'Filen ser ut til å være UTF-16.', true);
    }

    if (!hasHighBytes(bytes)) {
      return result('utf-8', new TextDecoder('utf-8').decode(bytes), 'Filen inneholder bare vanlige tegn (ingen æ, ø eller å).', true);
    }

    // Gyldig UTF-8 med spesialtegn er nesten aldri et tilfeldig sammentreff.
    try {
      const text = decodeWith('utf-8', bytes);
      const reason = declared.enc && declared.enc !== 'utf-8'
        ? `Filen oppgir «${declared.raw}», men innholdet er UTF-8.`
        : 'Innholdet er UTF-8.';
      return result('utf-8', text, reason, true);
    } catch (e) { /* ikke UTF-8 – prøv enkeltbyte-tegnsettene */ }

    const order = declared.enc && SINGLE_BYTE.includes(declared.enc)
      ? [declared.enc, ...SINGLE_BYTE.filter(e => e !== declared.enc)]
      : SINGLE_BYTE;
    let best = null;
    for (const enc of order) {
      let text;
      try { text = decodeWith(enc, bytes); } catch (e) { continue; }
      if (enc === 'ansel') text = text.normalize('NFC');
      const score = scoreText(text);
      if (!best || score > best.score) best = { enc, text, score };
    }
    let reason;
    if (declared.enc === best.enc) reason = `Filen oppgir «${declared.raw}», og innholdet stemmer med det.`;
    else if (declared.raw) reason = `Filen oppgir «${declared.raw}», men innholdet passet best med ${ENCODINGS[best.enc].label}.`;
    else reason = `Filen oppgir ikke tegnsett. Innholdet passet best med ${ENCODINGS[best.enc].label}.`;
    return result(best.enc, best.text, reason, true);
  }

  const api = { decodeGedcom, ENCODINGS, scoreText, _tables: { CP850, CP865, ANSEL_SPACING, ANSEL_COMBINING } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tegnsett = api;
})(typeof window !== 'undefined' ? window : globalThis);
