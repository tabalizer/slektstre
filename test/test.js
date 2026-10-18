/* Kjør: node test/test.js [sti/til/fil.ged] */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decodeGedcom, _tables } = require('../js/tegnsett.js');
const { parseGedcom, parseDate, fold } = require('../js/gedcom.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FEIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// ---------- Kodere for testfiler ----------
function encodeTable(str, table) {
  const out = [];
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    if (c < 128) { out.push(c); continue; }
    const i = table.indexOf(ch);
    if (i < 0) throw new Error('Kan ikke kode ' + ch);
    out.push(0x80 + i);
  }
  return Uint8Array.from(out);
}
function encodeAnsel(str) {
  const spacing = {}; for (const [k, v] of Object.entries(_tables.ANSEL_SPACING)) spacing[v] = +k;
  const comb = {}; for (const [k, v] of Object.entries(_tables.ANSEL_COMBINING)) comb[v] = +k;
  const out = [];
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    if (c < 128) { out.push(c); continue; }
    if (spacing[ch] !== undefined) { out.push(spacing[ch]); continue; }
    const d = ch.normalize('NFD');
    const marks = [...d.slice(1)].map(m => comb[m.charCodeAt(0)]);
    if (marks.some(m => m === undefined) || d.charCodeAt(0) > 127) throw new Error('Kan ikke kode ' + ch);
    out.push(...marks, d.charCodeAt(0));
  }
  return Uint8Array.from(out);
}
function encode1252(str) { return encodeTable(str, null1252()); }
function null1252() {
  // Windows-1252 0x80–0xFF; posisjoner uten tegn markeres med \0
  const t = '€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ';
  let s = t;
  for (let c = 0xA0; c <= 0xFF; c++) s += String.fromCharCode(c);
  return s;
}

const NAMES = ['Øystein /Breivikås/', 'Åse /Sæther/', 'Kåre /Bråten/', 'Ærlig /Østby/', 'Jöns /Müller/', 'Hélène /Lødøen/'];
const WANT = ['Øystein Breivikås', 'Åse Sæther', 'Kåre Bråten', 'Ærlig Østby', 'Jöns Müller', 'Hélène Lødøen'];
function sampleGed(charTag) {
  const lines = ['0 HEAD', '1 SOUR TEST', `1 CHAR ${charTag}`, '1 GEDC', '2 VERS 5.5'];
  NAMES.forEach((n, i) => {
    lines.push(`0 @I${i + 1}@ INDI`, `1 NAME ${n}`, '1 SEX M', '1 BIRT', `2 DATE ${10 + i} MAR 18${50 + i}`, '2 PLAC Sør-Fron, Oppland, Norge');
  });
  lines.push('0 @I7@ INDI', '1 NAME Liv /Haugen/', '1 SEX F', '1 FAMC @F1@');
  lines.push('0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 CHIL @I7@', '1 MARR', '2 DATE ABT 1875');
  lines.push('0 TRLR');
  return lines.join('\r\n') + '\r\n';
}
function namesOf(text) { return [...parseGedcom(text).persons.values()].slice(0, 6).map(p => p.name); }

console.log('\nTegnsett');
const cases = [
  ['UTF-8 uten BOM', 'UTF-8', s => Buffer.from(s, 'utf8'), 'utf-8'],
  ['UTF-8 med BOM', 'UTF-8', s => Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(s, 'utf8')]), 'utf-8'],
  ['UTF-16LE med BOM', 'UNICODE', s => Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(s, 'utf16le')]), 'utf-16le'],
  ['ANSEL', 'ANSEL', encodeAnsel, 'ansel'],
  ['Windows-1252 (ANSI)', 'ANSI', encode1252, 'windows-1252'],
  ['DOS nordisk 865 merket IBMPC', 'IBMPC', s => encodeTable(s, _tables.CP865), null],
  ['Windows-1252 feilmerket som ANSEL', 'ANSEL', encode1252, 'windows-1252'],
  ['ANSEL feilmerket som ANSI', 'ANSI', encodeAnsel, 'ansel'],
  ['UTF-8 feilmerket som ANSEL', 'ANSEL', s => Buffer.from(s, 'utf8'), 'utf-8'],
  ['Windows-1252 uten CHAR-linje', '', s => encode1252(s.replace(/1 CHAR \r\n/, '')), 'windows-1252']
];
for (const [name, tag, enc, expected] of cases) {
  test(name, () => {
    const bytes = new Uint8Array(enc(sampleGed(tag)));
    const d = decodeGedcom(bytes);
    if (expected) assert.strictEqual(d.encoding, expected, 'valgte ' + d.encoding);
    assert.deepStrictEqual(namesOf(d.text), WANT);
  });
}
test('Tabellene har 128 tegn', () => {
  assert.strictEqual([..._tables.CP850].length, 128);
  assert.strictEqual([..._tables.CP865].length, 128);
});
test('Manuelt valgt tegnsett overstyrer', () => {
  const d = decodeGedcom(new Uint8Array(encode1252(sampleGed('ANSI'))), 'ansel');
  assert.strictEqual(d.encoding, 'ansel');
  assert.strictEqual(d.auto, false);
});

console.log('\nDatoer');
const dates = [
  ['12 MAR 1850', '12. mars 1850'], ['29 sep 1943', '29. september 1943'], ['MAY 1900', 'mai 1900'],
  ['1850', '1850'], ['ABT 1850', 'ca. 1850'], ['BEF 3 JAN 1801', 'før 3. januar 1801'],
  ['AFT 1700', 'etter 1700'], ['BET 1850 AND 1855', 'mellom 1850 og 1855'],
  ['FROM 1900 TO 1910', 'fra 1900 til 1910'], ['(ukjent)', 'ukjent'], ['var ugift', 'var ugift'],
  ['12.03.1850', '12. mars 1850'], ['INT 1850 (omtrent)', '1850'], ['10 FEB 1699/00', '10. februar 1699/00']
];
for (const [raw, want] of dates) test(`${raw} → ${want}`, () => assert.strictEqual(parseDate(raw).text, want));

console.log('\nSøk og familie');
test('Bretting av navn', () => {
  assert.strictEqual(fold('Bråten'), fold('Braaten'));
  assert.strictEqual(fold('Håkon'), 'hakon');
  assert.strictEqual(fold('Sæther'), 'saether');
});
test('Søk, foreldre og alder', () => {
  const db = parseGedcom(sampleGed('UTF-8'));
  assert.strictEqual(db.search('braaten kare').results[0].name, 'Kåre Bråten');
  assert.strictEqual(db.search('Øystein 1850').results[0].id, 'I1');
  const liv = db.person('I7');
  assert.strictEqual(db.parents(liv).father.name, 'Øystein Breivikås');
  assert.strictEqual(db.parents(liv).mother.name, 'Åse Sæther');
  const tl = db.timeline(db.person('I1'));
  const marr = tl.find(e => e.tag === 'MARR');
  assert.strictEqual(marr.spouse.id, 'I2');
  assert.strictEqual(marr.ageText, 'ca. 25 år');
});
test('Ikke-GEDCOM avvises', () => {
  assert.throws(() => parseGedcom('Hei, dette er en vanlig tekstfil'), e => e.code === 'NOT_GEDCOM');
});

// ---------- Ekte fil (valgfritt) ----------
const real = process.argv[2];
if (real && fs.existsSync(real)) {
  console.log('\nEkte fil: ' + path.basename(real));
  const t0 = Date.now();
  const bytes = new Uint8Array(fs.readFileSync(real));
  const d = decodeGedcom(bytes);
  const t1 = Date.now();
  const db = parseGedcom(d.text);
  const t2 = Date.now();
  console.log(`  tegnsett: ${d.label} – ${d.reason}`);
  console.log(`  ${db.persons.size} personer, ${db.families.size} familier`);
  console.log(`  dekoding ${t1 - t0} ms, tolking ${t2 - t1} ms`);
  const t3 = Date.now(); db.search('ole hansen'); console.log(`  søk «ole hansen»: ${Date.now() - t3} ms, ${db.search('ole hansen').total} treff`);
  const undated = [...db.persons.values()].filter(p => !p.lifespan).length;
  console.log(`  personer uten årstall: ${undated}`);
  const raw = new Set();
  for (const p of db.persons.values()) for (const e of p.events) if (e.date.raw && !e.date.sort) raw.add(e.date.raw);
  console.log(`  datoer som ikke kunne tolkes (${raw.size}): ${[...raw].slice(0, 12).join(' | ')}`);
}

console.log(`\n${passed} tester bestått${process.exitCode ? ', noen feilet' : ''}.\n`);
