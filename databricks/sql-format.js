'use strict';

const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  const s = String(value);
  if (s === '') return 'NULL';
  return `'${s.replace(/'/g, "''")}'`;
}

function sqlTimestamp(value) {
  if (value === null || value === undefined || value === '') return 'CURRENT_TIMESTAMP()';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'CURRENT_TIMESTAMP()';
  const iso = d.toISOString().replace('T', ' ').replace('Z', '');
  return `TIMESTAMP ${sqlString(iso)}`;
}

function sqlDate(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'NULL';
  return `DATE ${sqlString(s)}`;
}

function sqlDecimal(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = Number(value);
  if (Number.isNaN(n)) return 'NULL';
  return String(value);
}

function sqlBigInt(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = Number(value);
  if (Number.isNaN(n)) return 'NULL';
  return String(Math.trunc(n));
}

function sqlBoolean(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return value ? 'true' : 'false';
}

function sqlVariant(value) {
  if (value === null || value === undefined) return 'parse_json(NULL)';
  const json = JSON.stringify(value);
  return `parse_json(${sqlString(json)})`;
}

module.exports = {
  sha256,
  stableStringify,
  sqlString,
  sqlTimestamp,
  sqlDate,
  sqlDecimal,
  sqlBigInt,
  sqlBoolean,
  sqlVariant,
};
