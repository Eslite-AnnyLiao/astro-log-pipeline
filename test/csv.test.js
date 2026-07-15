'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { csvEscape, csvRow } = require('../src/lib/csv');

test('csvEscape：null/undefined → 空字串', () => {
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('csvEscape：數字轉字串，不加引號', () => {
  assert.equal(csvEscape(42), '42');
});

test('csvEscape：一般字串不需跳脫', () => {
  assert.equal(csvEscape('hello'), 'hello');
});

test('csvEscape：含逗號需加引號包住', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
});

test('csvEscape：含雙引號需跳脫為兩個雙引號，並整體包住', () => {
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
});

test('csvEscape：含換行需加引號包住', () => {
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
});

test('csvRow：多欄位以逗號組合，個別欄位各自跳脫', () => {
  assert.equal(csvRow('a', 'b,c', 'd"e', null, 3), 'a,"b,c","d""e",,3');
});
