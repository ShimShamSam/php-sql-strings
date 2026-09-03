import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  VSCODE_MSSQL_SQL_GRAMMAR_SOURCE_URL,
  VSCODE_MSSQL_SQL_GRAMMAR_URL,
  createSqlGrammarFixture,
  fetchSqlGrammarFixture,
  parsePlist,
  updateSqlGrammar
} from '../scripts/update-sql-grammar.mjs';

const broadKeywordAlternatives = [
  'case',
  'select',
  'where',
  'with',
  ...Array.from({ length: 950 }, (_, index) => `keyword_${index}`)
].join('|');
const functionAlternatives = [
  'coalesce',
  'count',
  'row_number',
  ...Array.from({ length: 250 }, (_, index) => `function_${index}`)
].join('|');
const sqlPlist = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>fileTypes</key>
  <array>
    <string>sql</string>
  </array>
  <key>keyEquivalent</key>
  <string>^~S</string>
  <key>name</key>
  <string>SQL</string>
  <key>scopeName</key>
  <string>source.sql</string>
  <key>patterns</key>
  <array>
    <dict>
      <key>match</key>
      <string>\b(?i)(${broadKeywordAlternatives})\b</string>
      <key>name</key>
      <string>keyword.other.sql</string>
    </dict>
    <dict>
      <key>match</key>
      <string>(?i)\b(${functionAlternatives})\b\s*\(</string>
      <key>captures</key>
      <dict>
        <key>1</key>
        <dict>
          <key>name</key>
          <string>support.function.synthetic.sql</string>
        </dict>
      </dict>
    </dict>
    <dict>
      <key>applyEndPatternLast</key>
      <integer>1</integer>
      <key>match</key>
      <string>(?&lt;!@)@@(?i)\b(version)\b\s*\(</string>
      <key>captures</key>
      <dict>
        <key>1</key>
        <dict>
          <key>name</key>
          <string>support.function.globalvar.sql</string>
        </dict>
      </dict>
    </dict>
  </array>
  <key>repository</key>
  <dict>
    <key>entityProbe</key>
    <string>&amp;&apos;&gt;&lt;&quot;&#65;&#x42;</string>
  </dict>
  <key>uuid</key>
  <string>C49120AC-6ECC-11D9-ACC8-000D93589AF6</string>
</dict>
</plist>`;

function response(body, init = {}) {
  return new Response(body, { status: 200, ...init });
}

test('parses the plist structures and XML entities used by the upstream grammar', () => {
  const grammar = parsePlist(sqlPlist);

  assert.equal(grammar.name, 'SQL');
  assert.equal(grammar.scopeName, 'source.sql');
  const globalVariableRule = grammar.patterns.find(
    (rule) => rule.captures?.[1]?.name === 'support.function.globalvar.sql'
  );
  assert.equal(globalVariableRule.applyEndPatternLast, 1);
  assert.equal(globalVariableRule.match, String.raw`(?<!@)@@(?i)\b(version)\b\s*\(`);
  assert.deepEqual(globalVariableRule.captures, {
    1: { name: 'support.function.globalvar.sql' }
  });
  assert.equal(grammar.repository.entityProbe, `&'><"AB`);
});

test('rejects unsupported plist types and malformed entities', () => {
  assert.throws(
    () => parsePlist('<plist><true/></plist>'),
    /Unsupported plist value type <true>/
  );
  assert.throws(
    () => parsePlist('<plist><string>&unknown;</string></plist>'),
    /Unsupported XML entity/
  );
});

test('normalizes XML line endings inside plist strings', () => {
  assert.equal(
    parsePlist('<plist><string>first\r\nsecond\rthird</string></plist>'),
    'first\nsecond\nthird'
  );
});

test('parses dictionary keys without allowing prototype mutation', () => {
  const value = parsePlist(
    '<plist><dict><key>__proto__</key><string>data</string></dict></plist>'
  );

  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.ok(Object.hasOwn(value, '__proto__'));
  assert.equal(value.__proto__, 'data');
});

test('adds the vscode-mssql main source URL to the converted fixture', () => {
  const fixture = createSqlGrammarFixture(sqlPlist);

  assert.equal(fixture.version, VSCODE_MSSQL_SQL_GRAMMAR_SOURCE_URL);
  assert.equal(fixture.name, 'SQL');
  assert.equal(fixture.scopeName, 'source.sql');
  assert.equal(
    fixture.information_for_contributors[0],
    `This file has been converted from ${VSCODE_MSSQL_SQL_GRAMMAR_SOURCE_URL}`
  );
  assert.ok(!Object.hasOwn(fixture, 'fileTypes'));
  assert.ok(!Object.hasOwn(fixture, 'keyEquivalent'));
  assert.ok(!Object.hasOwn(fixture, 'uuid'));
});

test('fetches the SQL grammar directly from vscode-mssql main', async () => {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url: String(url), options });
    return response(sqlPlist);
  };

  const fixture = await fetchSqlGrammarFixture({ fetchImplementation });

  assert.equal(fixture.version, VSCODE_MSSQL_SQL_GRAMMAR_SOURCE_URL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, VSCODE_MSSQL_SQL_GRAMMAR_URL);
  assert.equal(calls[0].options.headers['User-Agent'], 'php-sql-strings-build');
  assert.ok(!Object.hasOwn(calls[0].options.headers, 'Authorization'));
});

test('writes deterministic fixture output and leaves an identical fixture untouched', async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'php-sql-strings-'));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const destinationPath = join(temporaryDirectory, 'sql.tmLanguage.json');

  const fetchImplementation = async () => response(sqlPlist);

  const firstUpdate = await updateSqlGrammar({ destinationPath, fetchImplementation });
  const firstContents = await readFile(destinationPath, 'utf8');
  const secondUpdate = await updateSqlGrammar({ destinationPath, fetchImplementation });
  const secondContents = await readFile(destinationPath, 'utf8');

  assert.deepEqual(firstUpdate, { changed: true, destinationPath });
  assert.deepEqual(secondUpdate, { changed: false, destinationPath });
  assert.equal(secondContents, firstContents);
  assert.ok(firstContents.endsWith('\n'));
  assert.equal(firstContents, `${JSON.stringify(createSqlGrammarFixture(sqlPlist), null, 2)}\n`);
  assert.deepEqual(JSON.parse(firstContents), createSqlGrammarFixture(sqlPlist));
});

test('reports GitHub failures without replacing an existing fixture', async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'php-sql-strings-'));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const destinationPath = join(temporaryDirectory, 'sql.tmLanguage.json');
  const initialContents = '{"sentinel":true}\n';
  await writeFile(destinationPath, initialContents);

  const fetchImplementation = async () => response(
    'upstream unavailable',
    { status: 403, statusText: 'Forbidden' }
  );

  await assert.rejects(
    updateSqlGrammar({ destinationPath, fetchImplementation }),
    /GitHub returned 403 Forbidden.*upstream unavailable/
  );
  assert.equal(await readFile(destinationPath, 'utf8'), initialContents);
});
