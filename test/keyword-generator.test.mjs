import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  SUPPLEMENTAL_DIALECT_KEYWORDS,
  buildSqlFunctionCallPattern,
  buildSqlKeywordPattern,
  getSqlFunctionInventory,
  getSqlFunctions,
  getSqlKeywordInventory,
  getSqlKeywords
} from '../scripts/sql-keywords.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(testDirectory, '..');
const vscodeMssqlSqlGrammarSourceUrl = 'https://github.com/microsoft/vscode-mssql/blob/main/extensions/mssql/syntaxes/SQL.plist';

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(projectDirectory, relativePath), 'utf8'));
}

const sqlGrammar = readJson('test/fixtures/sql.tmLanguage.json');
const injectionGrammar = readJson('syntaxes/php-sql-strings.tmLanguage.json');

function getBroadFixtureKeywords(grammar) {
  const broadRule = grammar.patterns.find(({ name }) => name === 'keyword.other.sql');
  assert.ok(broadRule, 'The SQL fixture should have a keyword.other.sql rule');

  const wrapper = /^\\b\(\?i\)\((.*)\)\\b$/s.exec(broadRule.match);
  assert.ok(wrapper, 'The broad SQL keyword rule should retain its expected shape');

  const keywords = new Set();
  for (const alternative of wrapper[1].split('|')) {
    const parsed = /^([a-z0-9_]+)(?:\(([a-z]+)\)\?)?/.exec(alternative.trim());
    assert.ok(parsed, `Unexpected broad SQL keyword alternative: ${alternative}`);
    keywords.add(parsed[1].toUpperCase());
    if (parsed[2]) {
      keywords.add(`${parsed[1]}${parsed[2]}`.toUpperCase());
    }
  }

  return keywords;
}

test('uses an attributed vscode-mssql SQL grammar fixture', () => {
  assert.equal(sqlGrammar.name, 'SQL');
  assert.equal(sqlGrammar.scopeName, 'source.sql');
  assert.equal(sqlGrammar.version, vscodeMssqlSqlGrammarSourceUrl);
  assert.equal(
    sqlGrammar.information_for_contributors[0],
    `This file has been converted from ${vscodeMssqlSqlGrammarSourceUrl}`
  );
  assert.ok(
    getBroadFixtureKeywords(sqlGrammar).size >= 900,
    'Expected the broad upstream T-SQL keyword inventory'
  );
});

test('derives specialized and captured keyword atoms from the upstream rules', () => {
  const syntheticGrammar = {
    patterns: [
      {
        name: 'keyword.other.sql',
        match: String.raw`\b(?i)(select|base_word)\b`
      },
      {
        name: 'keyword.other.synthetic.sql',
        match: String.raw`(?i:\b(future_clause|proc(edure)?)\b)`
      },
      {
        captures: { 1: { name: 'keyword.other.captured.sql' } },
        match: String.raw`(?i)\b(captured_word)\b`
      },
      {
        name: 'storage.type.sql',
        match: String.raw`(?i)\b(type_only_word)\b`
      },
      {
        captures: { 1: { name: 'support.function.synthetic.sql' } },
        match: String.raw`(?i)\b(function_only_word)\b\s*\(`
      }
    ]
  };

  const inventory = getSqlKeywordInventory(syntheticGrammar);
  assert.deepEqual(inventory.vscodeKeywords, [
    'BASE_WORD',
    'CAPTURED_WORD',
    'FUTURE_CLAUSE',
    'PROC',
    'PROCEDURE',
    'SELECT'
  ]);
  assert.equal(inventory.counts.broad, 2);
  assert.equal(inventory.counts.scoped, 4);
  assert.ok(!inventory.vscodeKeywords.includes('EDURE'));
  assert.ok(!inventory.vscodeKeywords.includes('TYPE_ONLY_WORD'));
  assert.ok(!inventory.vscodeKeywords.includes('FUNCTION_ONLY_WORD'));
});

test('expands finite broad-keyword alternatives without hard-coded lists', () => {
  const inventory = getSqlKeywordInventory({
    patterns: [
      {
        name: 'keyword.other.sql',
        match: String.raw`\b(?i)(create(?:\s+or\s+replace)?|day(s)?|within group)\b`
      }
    ]
  });

  assert.deepEqual(inventory.vscodeKeywords, ['CREATE', 'DAY', 'DAYS', 'WITHIN']);
});

test('respects keyword capture boundaries and finite regex semantics', () => {
  const syntheticGrammar = {
    patterns: [
      {
        name: 'keyword.other.sql',
        match: String.raw`\b(?i)(select)\b`
      },
      {
        captures: {
          1: { name: 'keyword.other.captured.sql' },
          2: { name: 'entity.name.synthetic.sql' }
        },
        match: String.raw`(?i)\b(create)\s+(customer_label)\b`
      },
      {
        name: 'keyword.other.synthetic.sql',
        match: String.raw`(?i:(foo(?:bar)?baz|un(lock|load)))`
      }
    ],
    repository: {
      nested: {
        patterns: [
          {
            name: 'keyword.other.nested.sql',
            match: String.raw`(?i:\b(repository_word)\b)`
          }
        ]
      }
    }
  };

  const inventory = getSqlKeywordInventory(syntheticGrammar);
  assert.deepEqual(inventory.vscodeKeywords, [
    'CREATE',
    'FOOBARBAZ',
    'FOOBAZ',
    'REPOSITORY_WORD',
    'SELECT',
    'UNLOAD',
    'UNLOCK'
  ]);
  for (const leakedFragment of [
    'BAR', 'CUSTOMER_LABEL', 'FOO', 'LOAD', 'LOCK'
  ]) {
    assert.ok(
      !inventory.vscodeKeywords.includes(leakedFragment),
      `${leakedFragment} should not leak from an unscoped or non-consuming regex fragment`
    );
  }
});

test('preserves empty and separator branches of finite repeated patterns', () => {
  const syntheticGrammar = {
    patterns: [
      {
        name: 'keyword.other.sql',
        match: String.raw`\b(?i)(select)\b`
      },
      {
        name: 'keyword.other.synthetic.sql',
        match: String.raw`(?i:(foo\s*bar|baz(?:\s?)+qux))`
      }
    ]
  };

  assert.deepEqual(getSqlKeywordInventory(syntheticGrammar).vscodeKeywords, [
    'BAR',
    'BAZ',
    'BAZQUX',
    'FOO',
    'FOOBAR',
    'QUX',
    'SELECT'
  ]);
});

test('rejects keyword regex constructs that cannot be enumerated safely', () => {
  const broadRule = {
    name: 'keyword.other.sql',
    match: String.raw`\b(?i)(select)\b`
  };
  const unsupportedRules = [
    {
      name: 'keyword.other.synthetic.sql',
      match: String.raw`(?i)(word)+`
    },
    {
      name: 'keyword.other.synthetic.sql',
      match: String.raw`(?i)([A-Z]+)`
    },
    {
      name: 'keyword.other.synthetic.sql',
      match: String.raw`(?i)(word)\1`
    },
    {
      name: 'keyword.other.synthetic.sql',
      match: String.raw`(?i)(?=guard_word)(word)`
    },
    {
      name: 'keyword.other.synthetic.sql',
      match: String.raw`(?i)(?# comment)(word)`
    },
    {
      name: 'keyword.other.synthetic.sql',
      match: String.raw`(?i)(unterminated`
    },
    {
      captures: { 2: { name: 'keyword.other.synthetic.sql' } },
      match: String.raw`(?i)(only_one_capture)`
    }
  ];

  for (const rule of unsupportedRules) {
    assert.throws(
      () => getSqlKeywordInventory({ patterns: [broadRule, rule] }),
      /Unsupported SQL keyword rule/
    );
  }
});

test('rejects non-ASCII pattern characters instead of treating them as separators', () => {
  const broadRule = {
    name: 'keyword.other.sql',
    match: String.raw`\b(?i)(select)\b`
  };

  for (const match of [
    '(?i)(foo[\u00e9]bar)',
    '(?i)(foo\u{10400}bar)'
  ]) {
    assert.throws(
      () => getSqlKeywordInventory({
        patterns: [broadRule, { name: 'keyword.other.synthetic.sql', match }]
      }),
      /non-ASCII character/
    );
  }
});

test('builds the complete, normalized SQL fragment-starter inventory', () => {
  const inventory = getSqlKeywordInventory(sqlGrammar);
  const { keywords, vscodeKeywords } = inventory;
  const keywordSet = new Set(keywords);
  const vscodeKeywordSet = new Set(vscodeKeywords);
  const supplementalSet = new Set(SUPPLEMENTAL_DIALECT_KEYWORDS);

  assert.equal(inventory.counts.broad, getBroadFixtureKeywords(sqlGrammar).size);
  assert.equal(inventory.counts.vscode, vscodeKeywords.length);
  assert.equal(inventory.counts.supplemental, SUPPLEMENTAL_DIALECT_KEYWORDS.length);
  assert.equal(
    inventory.counts.supplementalAdditions,
    SUPPLEMENTAL_DIALECT_KEYWORDS.filter((keyword) => !vscodeKeywordSet.has(keyword)).length
  );
  assert.equal(inventory.counts.total, keywords.length);
  assert.equal(SUPPLEMENTAL_DIALECT_KEYWORDS.length, 31);
  assert.equal(supplementalSet.size, 31, 'Supplemental keywords should be unique');
  assert.ok(
    SUPPLEMENTAL_DIALECT_KEYWORDS.every((keyword) => /^[A-Z][A-Z0-9_]*$/.test(keyword)),
    'Supplemental keywords should be normalized uppercase words'
  );

  assert.ok(vscodeKeywords.length >= 950, 'Expected the full vscode-mssql keyword inventory');
  assert.equal(vscodeKeywordSet.size, vscodeKeywords.length, 'The VS Code-derived inventory should be unique');
  assert.equal(
    keywords.length,
    vscodeKeywords.length + inventory.counts.supplementalAdditions,
    'The final inventory should be the union of upstream and supplemental keywords'
  );
  assert.equal(keywordSet.size, keywords.length, 'The final starter inventory should be unique');
  assert.deepEqual(keywords, [...keywords].sort(), 'The final inventory should be deterministic');
  assert.ok(
    keywords.every((keyword) => /^[A-Z][A-Z0-9_]*$/.test(keyword)),
    'Every generated starter should be a normalized uppercase word'
  );

  for (const keyword of [
    'SELECT', 'CASE', 'JOIN', 'LEFT', 'WHERE', 'GROUP', 'ORDER', 'WITH',
    'THEN', 'ELSE', 'ALL', 'WORK', 'BIGINT', 'VARCHAR', 'QUALIFY',
    'RETURNING', 'MATCH_RECOGNIZE'
  ]) {
    assert.ok(keywordSet.has(keyword), `Expected ${keyword} to be a SQL fragment starter`);
  }

  for (const nonKeyword of [
    'SELECTED', 'CASEY', 'WHEREVER'
  ]) {
    assert.ok(!keywordSet.has(nonKeyword), `${nonKeyword} should not be a SQL keyword starter`);
  }

  for (const supplementalKeyword of SUPPLEMENTAL_DIALECT_KEYWORDS) {
    assert.ok(
      keywordSet.has(supplementalKeyword),
      `${supplementalKeyword} should be present in the combined inventory`
    );
  }
});

test('builds the complete, normalized SQL function-call starter inventory', () => {
  const inventory = getSqlFunctionInventory(sqlGrammar);
  const functions = getSqlFunctions(sqlGrammar);
  const functionSet = new Set(functions);
  const keywordSet = new Set(getSqlKeywords(sqlGrammar));
  const functionOnlyStarters = functions.filter((functionName) => !keywordSet.has(functionName));

  assert.equal(
    inventory.counts.rules,
    inventory.counts.ordinaryRules + inventory.counts.excludedGlobalVariableRules
  );
  assert.equal(inventory.counts.excludedGlobalVariableRules, 1);
  assert.ok(inventory.counts.ordinaryRules >= 20, 'Expected all upstream function categories');
  assert.ok(inventory.counts.expandedOccurrences >= inventory.counts.rawAlternatives);
  assert.equal(inventory.counts.total, functions.length);
  assert.equal(
    inventory.counts.excludedGlobalVariableAlternatives,
    inventory.excludedGlobalVariables.length
  );
  assert.ok(functions.length >= 250, 'Expected the full vscode-mssql function inventory');
  assert.equal(functionSet.size, functions.length, 'The SQL function inventory should be unique');
  assert.deepEqual(functions, [...functions].sort(), 'The function inventory should be deterministic');
  assert.ok(
    functions.every((functionName) => /^[A-Z][A-Z0-9_]*$/.test(functionName)),
    'Every function starter should be a normalized uppercase word'
  );
  assert.ok(functionOnlyStarters.length >= 200);

  for (const functionName of [
    'COUNT',
    'COALESCE',
    'ROW_NUMBER',
    'CURRENT_TIME',
    'CURRENT_TIMESTAMP',
    'STRING_AGG',
    'VECTOR_DISTANCE'
  ]) {
    assert.ok(functionSet.has(functionName), `Expected ${functionName} to be a SQL function starter`);
  }

  assert.ok(inventory.excludedGlobalVariables.length >= 30);
  assert.ok(inventory.excludedGlobalVariables.includes('CURSOR_ROWS'));
  assert.ok(inventory.excludedGlobalVariables.includes('CONNECTIONS'));
  assert.ok(!functionSet.has('CURSOR_ROWS'));
  assert.ok(!functionSet.has('CONNECTIONS'));
});

test('discovers function rules nested in the grammar repository', () => {
  const syntheticGrammar = {
    patterns: [
      {
        captures: { 1: { name: 'support.function.globalvar.sql' } },
        match: String.raw`(?<!@)@@(?i)\b(version)\b\s*\(`
      }
    ],
    repository: {
      functions: {
        patterns: [
          {
            captures: { 1: { name: 'support.function.synthetic.sql' } },
            match: String.raw`(?i)\b(nested_function)\b\s*\(`
          }
        ]
      }
    }
  };

  assert.deepEqual(getSqlFunctions(syntheticGrammar), ['NESTED_FUNCTION']);
});

test('emits a deterministic, boundary-safe keyword pattern', () => {
  const keywords = getSqlKeywords(sqlGrammar);
  const originalOrder = [...keywords];
  const pattern = buildSqlKeywordPattern(keywords);

  assert.deepEqual(keywords, originalOrder, 'Building a pattern should not mutate its input');
  assert.equal(
    pattern,
    buildSqlKeywordPattern([...keywords].reverse()),
    'Input ordering should not affect the generated pattern'
  );
  assert.ok(
    pattern.endsWith(String.raw`(?![\p{L}\p{M}\p{N}_$])`),
    'The pattern should reject Unicode identifier continuations'
  );

  const alternatives = /^\(\?:(.*)\)\(\?!\[/s.exec(pattern)?.[1].split('|');
  assert.ok(alternatives, 'The generated alternatives should be inspectable');
  assert.ok(
    alternatives.indexOf('MATCH_RECOGNIZE') < alternatives.indexOf('MATCH'),
    'Longer alternatives should precede their prefixes'
  );
  assert.ok(
    alternatives.indexOf('STRAIGHT_JOIN') < alternatives.indexOf('JOIN'),
    'Longer alternatives should precede shorter alternatives'
  );

  const matchesAtStart = new RegExp(`^(?:${pattern})`, 'u');

  for (const source of [
    'SELECT', 'SELECT ', 'SELECT(', 'SELECT.', 'WHERE-', 'QUALIFY\n', 'SELECT\u{1f600}'
  ]) {
    assert.ok(matchesAtStart.test(source), `Expected a keyword boundary in ${JSON.stringify(source)}`);
  }

  for (const source of [
    'select', 'Select', 'SELECTED', 'WHERE_1', 'CASE$variable', 'ALL2',
    'SELECT\u00e9', 'SELECT\u0301', 'SELECT\u0663'
  ]) {
    assert.ok(!matchesAtStart.test(source), `Expected no keyword boundary in ${JSON.stringify(source)}`);
  }
});

test('emits a deterministic, boundary-safe function-call pattern', () => {
  const functions = getSqlFunctions(sqlGrammar);
  const originalOrder = [...functions];
  const pattern = buildSqlFunctionCallPattern(functions);

  assert.deepEqual(functions, originalOrder, 'Building a pattern should not mutate its input');
  assert.equal(
    pattern,
    buildSqlFunctionCallPattern([...functions].reverse()),
    'Input ordering should not affect the generated function pattern'
  );
  assert.ok(
    pattern.endsWith(String.raw`(?![\p{L}\p{M}\p{N}_$])[\t ]*\(`),
    'The pattern should require a call parenthesis after a Unicode-safe name boundary'
  );
  const alternatives = /^\(\?:(.*)\)\(\?!\[/s.exec(pattern)?.[1].split('|');
  assert.ok(alternatives, 'The generated function alternatives should be inspectable');
  assert.ok(
    alternatives.indexOf('CURRENT_TIMESTAMP') < alternatives.indexOf('CURRENT_TIME'),
    'Longer function names should precede their prefixes'
  );

  const matchesAtStart = new RegExp(`^(?:${pattern})`, 'u');

  for (const source of [
    'COUNT(',
    'COUNT()',
    'COUNT \t (value)',
    'COALESCE(value, fallback)',
    'ROW_NUMBER() OVER ()',
    'CURRENT_TIMESTAMP ('
  ]) {
    assert.ok(matchesAtStart.test(source), `Expected a function call in ${JSON.stringify(source)}`);
  }

  for (const source of [
    'COUNT',
    'COUNT value',
    'count()',
    'Count()',
    'COUNTED()',
    'COUNT_1()',
    'COUNT$parameter()',
    'COUNT\u00e9()',
    'COUNT\u0301()',
    'COUNT\u0663()',
    'MY_FUNCTION()'
  ]) {
    assert.ok(!matchesAtStart.test(source), `Expected no function call in ${JSON.stringify(source)}`);
  }
});

test('keeps all four generated injection begins synchronized with the builder', () => {
  const keywordPattern = buildSqlKeywordPattern(getSqlKeywords(sqlGrammar));
  const functionCallPattern = buildSqlFunctionCallPattern(getSqlFunctions(sqlGrammar));
  const starterPattern = String.raw`(?:\([\t ]*)*(?:${keywordPattern}|${functionCallPattern})`;
  const expectedBegins = new Map([
    ['sql-double-quoted-inline', String.raw`(")[\t ]*(?=${starterPattern})`],
    ['sql-single-quoted-inline', String.raw`(')[\t ]*(?=${starterPattern})`],
    ['sql-after-leading-newlines-double', String.raw`^[\t ]*(?=${starterPattern})`],
    ['sql-after-leading-newlines-single', String.raw`^[\t ]*(?=${starterPattern})`]
  ]);

  for (const [ruleName, expectedBegin] of expectedBegins) {
    const rule = injectionGrammar.repository[ruleName];
    assert.ok(rule, `The injection grammar should contain ${ruleName}`);
    assert.equal(rule.begin, expectedBegin, `${ruleName} should use the generated starter pattern`);
  }
});
