'use strict';

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(...fields) {
  return fields.map(csvEscape).join(',');
}

module.exports = { csvEscape, csvRow };
