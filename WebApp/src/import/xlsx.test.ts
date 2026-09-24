import { describe, expect, it } from 'vitest';
import { parseCellDate } from './dates';
import { makeZip } from './testing/zip-writer';
import { XlsxError, isDateFormat, parseCellRef, readXlsx } from './xlsx';
import { XmlError, decodeEntities, parseXml } from './xml';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function workbookFiles(opts: { date1904?: boolean; sheets: Record<string, string>; hidden?: string[] }) {
  const names = Object.keys(opts.sheets);
  const sheetEls = names
    .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"${opts.hidden?.includes(n) ? ' state="hidden"' : ''}/>`)
    .join('');
  const rels = names
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  return [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<workbook ${NS} ${RNS}><workbookPr${opts.date1904 ? ' date1904="1"' : ''}/><sheets>${sheetEls}</sheets></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}
<Relationship Id="rS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rT" Type="${REL}/styles" Target="/xl/styles.xml"/></Relationships>`
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `<sst ${NS} count="4" uniqueCount="4">
<si><t>Title</t></si>
<si><r><rPr><b/></rPr><t>Rich </t></r><r><t xml:space="preserve">text &amp; runs</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>
<si><t>GST filing</t></si>
<si><t>Line_x000D_break</t></si>
</sst>`
    },
    {
      name: 'xl/styles.xml',
      data: `<styleSheet ${NS}>
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs>
</styleSheet>`
    },
    ...names.map((n, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: opts.sheets[n] }))
  ];
}

const SHEET1 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet ${NS}><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Due &lt;date&gt;</t></is></c></row>
<row r="3"><c r="B3"><v>42</v></c></row>
<row r="4">
  <c r="A4" s="1"><v>46300</v></c>
  <c r="B4" s="2"><v>46300.75</v></c>
  <c r="C4" s="3"><v>46300</v></c>
  <c r="D4" t="b"><v>1</v></c>
  <c r="E4" t="e"><v>#N/A</v></c>
  <c r="F4" t="str"><f>A1&amp;"x"</f><v>Titlex</v></c>
  <c r="G4" t="s"><v>1</v></c>
  <c r="H4" t="s"><v>3</v></c>
  <c r="I4" s="1"/>
</row>
</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;

const SHEET2 = `<worksheet ${NS}><sheetData><row><c t="s"><v>2</v></c><c s="1"><v>44838</v></c></row></sheetData></worksheet>`;

describe('readXlsx', () => {
  it('reads shared, inline, rich, numeric, boolean, formula and date cells on a sparse grid', async () => {
    const wb = await readXlsx(await makeZip(workbookFiles({ sheets: { Tasks: SHEET1, Other: SHEET2 }, hidden: ['Other'] })));
    expect(wb.date1904).toBe(false);
    expect(wb.sheets.map((s) => [s.name, s.hidden])).toEqual([['Tasks', false], ['Other', true]]);
    const rows = wb.sheets[0].rows;
    expect(rows.length).toBe(4);
    expect(rows[0].slice(0, 3)).toEqual([{ v: 'Title' }, { v: null }, { v: 'Due <date>' }]);
    expect(rows[1].every((c) => c.v === null)).toBe(true);
    expect(rows[2][1]).toEqual({ v: 42 });
    const r4 = rows[3];
    expect(r4[0]).toEqual({ v: 46300, date: true });
    expect(r4[1]).toEqual({ v: 46300.75, date: true });
    expect(r4[2]).toEqual({ v: 46300 });
    expect(r4[3]).toEqual({ v: true });
    expect(r4[4]).toEqual({ v: null });
    expect(r4[5]).toEqual({ v: 'Titlex' });
    expect(r4[6]).toEqual({ v: 'Rich text & runs' });
    expect(r4[7]).toEqual({ v: 'Line\rbreak' });
    expect(r4[8]).toBeUndefined(); // an empty styled cell does not widen the grid
    expect(parseCellDate(r4[0])).toBe('2026-10-05');
    expect(parseCellDate(r4[1])).toBe('2026-10-05');
    // Sheet rows are rectangular.
    expect(new Set(rows.map((r) => r.length))).toEqual(new Set([8]));
  });

  it('honours the 1904 date system and cells without r attributes', async () => {
    const wb = await readXlsx(await makeZip(workbookFiles({ date1904: true, sheets: { S: SHEET2 } })));
    expect(wb.date1904).toBe(true);
    const [title, when] = wb.sheets[0].rows[0];
    expect(title).toEqual({ v: 'GST filing' });
    expect(when).toEqual({ v: 44838, date: true });
    expect(parseCellDate(when, { date1904: wb.date1904 })).toBe('2026-10-05');
  });

  it('caps rows and columns', async () => {
    const rowsXml = Array.from({ length: 30 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${r}</v></c><c r="Z${r + 1}"><v>1</v></c></row>`).join('');
    const sheet = `<worksheet ${NS}><sheetData>${rowsXml}</sheetData></worksheet>`;
    const wb = await readXlsx(await makeZip(workbookFiles({ sheets: { S: sheet } })), { maxRows: 10, maxCols: 5 });
    const s = wb.sheets[0];
    expect(s.truncated).toBe(true);
    expect(s.rows.length).toBe(10);
    expect(s.rows[0].length).toBe(1);
  });

  it('ignores far-away row numbers beyond the cap instead of allocating them', async () => {
    const sheet = `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="A1048576"><v>2</v></c></row></sheetData></worksheet>`;
    const wb = await readXlsx(await makeZip(workbookFiles({ sheets: { S: sheet } })));
    expect(wb.sheets[0].rows.length).toBe(1);
    expect(wb.sheets[0].truncated).toBe(true);
  });

  it('explains legacy .xls files', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(readXlsx(ole)).rejects.toThrow(XlsxError);
    await expect(readXlsx(ole)).rejects.toThrow('.xlsx');
  });

  it('rejects a zip that is not a workbook', async () => {
    await expect(readXlsx(await makeZip([{ name: 'hello.txt', data: 'hi' }]))).rejects.toThrow('Not an Excel workbook');
  });
});

describe('number formats', () => {
  it('recognises date formats and ignores quoted/bracketed text', () => {
    expect(isDateFormat('dd/mm/yyyy')).toBe(true);
    expect(isDateFormat('[$-409]d-mmm-yy;@')).toBe(true);
    expect(isDateFormat('yyyy-mm-dd hh:mm')).toBe(true);
    expect(isDateFormat('0.00')).toBe(false);
    expect(isDateFormat('General')).toBe(false);
    expect(isDateFormat('#,##0 "days"')).toBe(false);
    expect(isDateFormat('[Red]0.00')).toBe(false);
    expect(isDateFormat('0\\d')).toBe(false);
    expect(isDateFormat('[h]:mm:ss')).toBe(false);
  });

  it('parses cell refs', () => {
    expect(parseCellRef('A1')).toEqual({ row: 0, col: 0 });
    expect(parseCellRef('AB12')).toEqual({ row: 11, col: 27 });
    expect(parseCellRef('$C$3')).toEqual({ row: 2, col: 2 });
    expect(parseCellRef('A0')).toBeNull();
    expect(parseCellRef('12')).toBeNull();
  });
});

describe('xml tokenizer', () => {
  it('decodes only standard entities and char refs', () => {
    expect(decodeEntities('&lt;a&gt; &amp;amp; &quot;&apos; &#65;&#x42; &nbsp; &#0;')).toBe('<a> &amp; "\' AB &nbsp; �');
  });

  it('refuses DTDs (no entity expansion attacks)', () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><a>&lol;</a>';
    expect(() => parseXml(evil, {})).toThrow(XmlError);
  });

  it('handles CDATA, comments, prefixes and quoted ">" in attributes', () => {
    const events: string[] = [];
    parseXml('<x:a k="1>2"><!-- c --><![CDATA[<raw>]]><b/></x:a>', {
      open: (n, a, sc) => events.push(`open ${n} ${JSON.stringify(a)} ${sc}`),
      close: (n) => events.push(`close ${n}`),
      text: (t) => events.push(`text ${t}`)
    });
    expect(events).toEqual(['open a {"k":"1>2"} false', 'text <raw>', 'open b {} true', 'close b', 'close a']);
  });
});
