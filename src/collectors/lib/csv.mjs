/**
 * A small RFC 4180 CSV reader. No dependency, because a CSV parser is forty lines and a supply
 * chain is forever - and this repository screens supply chains for a living.
 *
 * Handles quoted fields, embedded commas, embedded newlines, and doubled quotes. Does not handle
 * alternate delimiters or BOM-less UTF-16, which are worth failing loudly on rather than guessing.
 */
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, ''); // Excel writes a BOM; it silently corrupts the first header
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];

    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // swallow; \n handles the break
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/**
 * Parses to objects keyed by header.
 *
 * Headers are normalised to snake_case so `Supplier ID`, `supplier_id` and `SUPPLIER-ID` all land
 * on the same column. That is deliberate leniency in exactly one place: the analyst is exporting
 * from a procurement system they do not control, and failing on a capital letter would be a
 * pointless obstacle. Everything downstream stays strict.
 */
export function readCsvObjects(text, { required = [] } = {}) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], objects: [], missing: required };

  const headers = rows[0].map(normaliseHeader);
  const missing = required.filter((r) => !headers.includes(r));
  const objects = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      o[h] = (r[i] ?? '').trim();
    });
    return o;
  });
  return { headers, objects, missing };
}

export const normaliseHeader = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

/** Loose truthiness for spreadsheet columns - people write yes, Y, TRUE, 1. */
export const csvBool = (v) => ['true', 'yes', 'y', '1'].includes(String(v ?? '').trim().toLowerCase());

/**
 * Normalised entity name for list matching.
 *
 * Screening joins on this, so it is the most consequential function in the supply-chain controls:
 * too aggressive and you create false hits, too lax and a listed entity slips through on a
 * suffix. It lowercases, strips punctuation, and removes common corporate suffixes - and it is
 * DELIBERATELY not fuzzy. Fuzzy matching here would produce a screening result nobody can
 * reproduce or defend, and an unresolved possible match belongs in a human queue rather than in a
 * similarity score.
 */
export function normaliseEntityName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(
      /\b(co|corp|corporation|inc|incorporated|ltd|limited|llc|llp|plc|gmbh|ag|sa|nv|bv|pte|pty|kk|co ltd|company|holdings|group|technologies|technology|tech)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}
