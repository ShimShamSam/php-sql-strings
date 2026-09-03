import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import oniguruma from 'vscode-oniguruma';
import textmate from 'vscode-textmate';

import { getSqlFunctions, getSqlKeywords } from '../scripts/sql-keywords.mjs';

const { loadWASM, OnigScanner, OnigString } = oniguruma;
const { INITIAL, Registry } = textmate;
const require = createRequire(import.meta.url);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(testDirectory, '..');

const wasmBuffer = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
const wasmArrayBuffer = wasmBuffer.buffer.slice(
  wasmBuffer.byteOffset,
  wasmBuffer.byteOffset + wasmBuffer.byteLength
);
await loadWASM(wasmArrayBuffer);

function readGrammar(relativePath) {
  return JSON.parse(readFileSync(join(projectDirectory, relativePath), 'utf8'));
}

const extensionManifest = readGrammar('package.json');
const grammarContributions = extensionManifest.contributes.grammars;
const sqlGrammarFixture = readGrammar('test/fixtures/sql.tmLanguage.json');
const sqlKeywordStarters = getSqlKeywords(sqlGrammarFixture);
const sqlFunctionStarters = getSqlFunctions(sqlGrammarFixture);
const rawGrammars = new Map([
  ['text.html.php', readGrammar('test/fixtures/html-php.tmLanguage.json')],
  ['source.php', readGrammar('test/fixtures/php.tmLanguage.json')],
  ['source.sql', sqlGrammarFixture]
]);

for (const contribution of grammarContributions) {
  rawGrammars.set(contribution.scopeName, readGrammar(contribution.path));
}

const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns) => new OnigScanner(patterns),
    createOnigString: (value) => new OnigString(value)
  }),
  loadGrammar: async (scopeName) => rawGrammars.get(scopeName) ?? null,
  getInjections: (scopeName) => grammarContributions
    .filter(({ injectTo = [] }) => injectTo.includes(scopeName))
    .map(({ scopeName: injectionScope }) => injectionScope)
});

const grammar = await registry.loadGrammar('text.html.php');
assert.ok(grammar, 'The HTML/PHP fixture grammar should load');
const directPhpGrammar = await registry.loadGrammar('source.php');
assert.ok(directPhpGrammar, 'The direct PHP fixture grammar should load');

function tokenize(source, selectedGrammar = grammar) {
  const lines = source.split(/\r?\n/);
  let ruleStack = INITIAL;

  return lines.map((line) => {
    const result = selectedGrammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;
    return { line, tokens: result.tokens };
  });
}

function tokenContaining(tokenized, lineNumber, text) {
  const { line, tokens } = tokenized[lineNumber];
  const character = line.indexOf(text);
  assert.notEqual(character, -1, `Expected line ${lineNumber + 1} to contain ${JSON.stringify(text)}`);

  const token = tokens.find(
    ({ startIndex, endIndex }) => startIndex <= character && character < endIndex
  );
  assert.ok(token, `Expected a token at line ${lineNumber + 1}, column ${character + 1}`);
  return token;
}

function scopesFor(tokenized, lineNumber, text) {
  return tokenContaining(tokenized, lineNumber, text).scopes;
}

function assertEmbeddedSqlContent(tokenized, lineNumber, text) {
  const token = tokenContaining(tokenized, lineNumber, text);
  assert.ok(
    token.scopes.includes('source.sql.embedded.php'),
    `${JSON.stringify(text)} should be embedded SQL; scopes were ${token.scopes.join(' ')}`
  );

  return token;
}

function assertEmbeddedSql(tokenized, lineNumber, text) {
  const token = assertEmbeddedSqlContent(tokenized, lineNumber, text);
  assert.ok(
    token.scopes.some((scope) => /^keyword\..*\.sql$/.test(scope)),
    `${JSON.stringify(text)} should have a SQL keyword scope; scopes were ${token.scopes.join(' ')}`
  );

  return token;
}

function assertEmbeddedSqlFunction(tokenized, lineNumber, text, expectedScope = null) {
  const token = assertEmbeddedSqlContent(tokenized, lineNumber, text);
  const functionScopes = token.scopes.filter((scope) => /^support\.function\..*\.sql$/.test(scope));
  assert.ok(
    functionScopes.length > 0,
    `${JSON.stringify(text)} should have a SQL function scope; scopes were ${token.scopes.join(' ')}`
  );

  if (expectedScope) {
    assert.ok(
      functionScopes.includes(expectedScope),
      `${JSON.stringify(text)} should have ${expectedScope}; scopes were ${token.scopes.join(' ')}`
    );
  }

  return token;
}

function assertNotEmbeddedSql(tokenized, lineNumber, text) {
  const token = tokenContaining(tokenized, lineNumber, text);
  assert.ok(
    !token.scopes.includes('source.sql.embedded.php'),
    `${JSON.stringify(text)} should remain PHP string content; scopes were ${token.scopes.join(' ')}`
  );
}

test('retains stock same-line SQL detection', () => {
  const result = tokenize('<?php\n$query = "  SELECT id FROM users";');
  assertEmbeddedSql(result, 1, 'SELECT');
});

const exhaustiveStarterLayouts = [
  {
    name: 'inline double-quoted',
    render: (keyword) => ({
      source: `<?php\n$fragment = "${keyword} fragment_body";`,
      lineNumber: 1
    })
  },
  {
    name: 'inline single-quoted',
    render: (keyword) => ({
      source: `<?php\n$fragment = '${keyword} fragment_body';`,
      lineNumber: 1
    })
  },
  {
    name: 'multiline double-quoted',
    render: (keyword) => ({
      source: `<?php\n$fragment = "\n  ${keyword} fragment_body\n";`,
      lineNumber: 2
    })
  },
  {
    name: 'multiline single-quoted',
    render: (keyword) => ({
      source: `<?php\n$fragment = '\n  ${keyword} fragment_body\n';`,
      lineNumber: 2
    })
  }
];

test('detects every generated SQL keyword starter in every quoted-string layout', () => {
  assert.ok(sqlKeywordStarters.length > 900, 'Expected the full VS Code and dialect keyword set');
  assert.ok(sqlKeywordStarters.includes('ALL'), 'Expected SELECT ALL to contribute ALL');
  assert.ok(sqlKeywordStarters.includes('WORK'), 'Expected transaction phrases to contribute WORK');

  for (const keyword of sqlKeywordStarters) {
    for (const layout of exhaustiveStarterLayouts) {
      const { source, lineNumber } = layout.render(keyword);
      const token = tokenContaining(tokenize(source), lineNumber, keyword);
      assert.ok(
        token.scopes.includes('source.sql.embedded.php'),
        `${keyword} should start SQL in the ${layout.name} layout; scopes were ${token.scopes.join(' ')}`
      );
    }
  }
});

const exhaustiveFunctionLayouts = [
  {
    name: 'inline double-quoted',
    render: (functionName) => ({
      source: `<?php\n$expression = "${functionName}()";`,
      lineNumber: 1
    })
  },
  {
    name: 'inline single-quoted',
    render: (functionName) => ({
      source: `<?php\n$expression = '${functionName}()';`,
      lineNumber: 1
    })
  },
  {
    name: 'multiline double-quoted',
    render: (functionName) => ({
      source: `<?php\n$expression = "\n  ${functionName}()\n";`,
      lineNumber: 2
    })
  },
  {
    name: 'multiline single-quoted',
    render: (functionName) => ({
      source: `<?php\n$expression = '\n  ${functionName}()\n';`,
      lineNumber: 2
    })
  }
];

test('detects every generated SQL function starter in every quoted-string layout', () => {
  assert.ok(sqlFunctionStarters.length >= 250, 'Expected the full upstream function inventory');

  for (const functionName of sqlFunctionStarters) {
    for (const layout of exhaustiveFunctionLayouts) {
      const { source, lineNumber } = layout.render(functionName);
      const token = assertEmbeddedSqlContent(tokenize(source), lineNumber, functionName);
      assert.ok(
        token.scopes.includes('source.sql.embedded.php'),
        `${functionName} should start SQL in the ${layout.name} layout`
      );
    }
  }
});

test('detects representative partial fragments and preserves their SQL keyword scopes', () => {
  const fragments = [
    { source: 'FROM accounts', probe: 'FROM', scope: 'keyword.other.DML.sql' },
    { source: 'NULL', probe: 'NULL', scope: 'keyword.other.DDL.create.II.sql' },
    { source: 'VALUES (1)', probe: 'VALUES', scope: 'keyword.other.DML.II.sql' },
    { source: 'COMMIT WORK', probe: 'COMMIT', scope: 'keyword.other.LUW.sql' },
    { source: 'GRANT SELECT ON accounts TO app', probe: 'GRANT', scope: 'keyword.other.authorization.sql' },
    { source: 'IN (1, 2)', probe: 'IN', scope: 'keyword.other.data-integrity.sql' },
    {
      source: 'COMMENT ON TABLE accounts IS description',
      probe: 'COMMENT',
      // VS Code anchors this scope to column zero, so an embedded grammar does
      // not assign its object-comment scope even though the fragment is SQL.
      scope: null
    },
    { source: 'AS account_id', probe: 'AS', scope: 'keyword.other.alias.sql' },
    { source: 'DESC', probe: 'DESC', scope: 'keyword.other.order.sql' },
    { source: 'WHEN enabled = 1 THEN 2', probe: 'WHEN', scope: 'keyword.other.sql' },
    // Anchored CREATE metadata cannot match after the enclosing string rule has
    // consumed indentation, but the general keyword rule still applies.
    { source: 'CREATE TABLE audit_log', probe: 'CREATE', scope: 'keyword.other.sql' }
  ];

  for (const fragment of fragments) {
    const result = tokenize(`<?php\n$query = "\n  ${fragment.source}\n";`);
    const token = assertEmbeddedSqlContent(result, 2, fragment.probe);
    if (fragment.scope) {
      assert.ok(
        token.scopes.includes(fragment.scope),
        `${fragment.probe} should receive ${fragment.scope}; scopes were ${token.scopes.join(' ')}`
      );
    }
  }
});

test('detects common partial clauses and supplemental dialect fragments', () => {
  const fragments = [
    'WHERE active = 1',
    'SET active = 1',
    'GROUP BY account_id',
    'ORDER BY created_at',
    'HAVING COUNT(*) > 1',
    'UNION ALL SELECT id FROM archived_accounts',
    'ON accounts.id = users.account_id',
    'ELSE 0',
    'END',
    'RETURN 1',
    'QUALIFY rank_value = 1',
    'RETURNING id',
    'PRAGMA table_info(users)',
    'UNNEST(values_array)'
  ];

  for (const fragment of fragments) {
    const probe = fragment.split(/[ (]/, 1)[0];
    const result = tokenize(`<?php\n$fragment = "\n  ${fragment}\n";`);
    assertEmbeddedSqlContent(result, 2, probe);
  }
});

test('treats keyword atoms from SQL phrases as valid standalone starters', () => {
  for (const keyword of [
    'ALL',
    'WORK',
    'GROUP',
    'ORDER',
    'COMMENT',
    'START',
    'LEFT',
    'TABLE',
    'USER',
    'VIEW'
  ]) {
    const result = tokenize(`<?php\n$fragment = "${keyword} arbitrary_fragment";`);
    assertEmbeddedSqlContent(result, 1, keyword);
  }
});

test('preserves the SQL grammar function category for standalone expressions', () => {
  for (const { expression, functionName, scope } of [
    {
      expression: 'ROW_NUMBER() OVER ()',
      functionName: 'ROW_NUMBER',
      scope: 'support.function.ranking.sql'
    },
    {
      expression: 'COUNT(*)',
      functionName: 'COUNT',
      scope: 'support.function.aggregate.sql'
    },
    {
      expression: 'COALESCE(account_id, 0)',
      functionName: 'COALESCE',
      scope: 'support.function.expression.sql'
    }
  ]) {
    const result = tokenize(`<?php\n$expression = "${expression}";`);
    assertEmbeddedSqlFunction(result, 1, functionName, scope);
  }
});

test('highlights a standalone window-function expression with exact SQL scopes', () => {
  const result = tokenize(
    '<?php\n$expression = "ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at)";'
  );

  assert.deepEqual(scopesFor(result, 1, 'ROW_NUMBER'), [
    'text.html.php',
    'source.php',
    'string.quoted.double.sql.php',
    'source.sql.embedded.php',
    'support.function.ranking.sql'
  ]);
  assert.deepEqual(scopesFor(result, 1, 'OVER'), [
    'text.html.php',
    'source.php',
    'string.quoted.double.sql.php',
    'source.sql.embedded.php',
    'keyword.other.sql'
  ]);
});

test('highlights COUNT DISTINCT and a standalone DISTINCT fragment', () => {
  const aggregate = tokenize('<?php\n$expression = "COUNT(DISTINCT account_id)";');
  assert.deepEqual(scopesFor(aggregate, 1, 'COUNT'), [
    'text.html.php',
    'source.php',
    'string.quoted.double.sql.php',
    'source.sql.embedded.php',
    'support.function.aggregate.sql'
  ]);
  assert.deepEqual(scopesFor(aggregate, 1, 'DISTINCT'), [
    'text.html.php',
    'source.php',
    'string.quoted.double.sql.php',
    'source.sql.embedded.php',
    'keyword.other.sql'
  ]);

  const fragment = tokenize("<?php\n$fragment = 'DISTINCT account_id';");
  assertEmbeddedSql(fragment, 1, 'DISTINCT');
});

test('allows horizontal whitespace before a standalone function call parenthesis', () => {
  for (const expression of [
    'ROW_NUMBER () OVER ()',
    'COUNT\t(*)',
    'COALESCE \t (account_id, 0)'
  ]) {
    const functionName = expression.match(/^[A-Z_]+/)[0];
    const result = tokenize(`<?php\n$expression = "${expression}";`);
    assertEmbeddedSqlFunction(result, 1, functionName);
  }
});

test('detects a function expression through wrapping parentheses and leading lines', () => {
  const result = tokenize(`<?php
$expression = "
  (
    (
      ROW_NUMBER() OVER ()
    )
  )
";`);

  assertEmbeddedSqlFunction(result, 4, 'ROW_NUMBER', 'support.function.ranking.sql');
  assert.ok(scopesFor(result, 5, ')').includes('source.sql.embedded.php'));
});

test('loads a wrapped standalone function when source.php is the root grammar', () => {
  const result = tokenize('$expression = "((COALESCE(account_id, 0)))";', directPhpGrammar);
  assertEmbeddedSqlFunction(result, 0, 'COALESCE', 'support.function.expression.sql');
  assert.ok(scopesFor(result, 0, '(').includes('source.sql.embedded.php'));
});

test('detects keyword spellings that the SQL grammar styles as data types', () => {
  for (const source of ['BIGINT', 'VARCHAR(20)']) {
    const probe = source.match(/[A-Z]+/)[0];
    const result = tokenize(`<?php\n$fragment = "${source}";`);
    const token = assertEmbeddedSqlContent(result, 1, probe);
    assert.ok(
      token.scopes.includes('storage.type.sql'),
      `${probe} should retain its SQL data-type scope; scopes were ${token.scopes.join(' ')}`
    );
  }
});

test('does not use type-only, custom-function, or symbolic SQL tokens as starters', () => {
  const unsupportedStarters = [
    { source: 'BIGSERIAL', probe: 'BIGSERIAL' },
    { source: 'BYTEA', probe: 'BYTEA' },
    { source: 'CIDR', probe: 'CIDR' },
    { source: 'MY_FUNCTION(value)', probe: 'MY_FUNCTION' },
    { source: '* value', probe: '*' },
    { source: '= value', probe: '=' }
  ];

  for (const { source, probe } of unsupportedStarters) {
    const result = tokenize(`<?php\n$fragment = "\n  ${source}\n";`);
    assertNotEmbeddedSql(result, 2, probe);
  }
});

test('gives inline and multiline double-quoted SQL identical content scopes', () => {
  const inline = tokenize(`<?php
$query = "SELECT tmp, 42, 'label_value' FROM users WHERE id = $userId";`);
  const multiline = tokenize(`<?php
$query = "
  SELECT tmp, 42, 'label_value' FROM users WHERE id = $userId
";`);

  for (const text of ['SELECT', 'tmp', '42', 'label_value', '$userId']) {
    assert.deepEqual(
      scopesFor(multiline, 2, text),
      scopesFor(inline, 1, text),
      `${JSON.stringify(text)} should have the same scopes after a leading newline`
    );
  }

  assert.deepEqual(scopesFor(multiline, 2, 'tmp'), [
    'text.html.php',
    'source.php',
    'string.quoted.double.sql.php',
    'source.sql.embedded.php'
  ]);
  assert.ok(scopesFor(multiline, 2, '$userId').includes('variable.other.php'));
});

test('gives inline and multiline single-quoted SQL identical content scopes', () => {
  const inline = tokenize("<?php\n$query = 'SELECT tmp, 42 FROM users';");
  const multiline = tokenize(`<?php
$query = '
  SELECT tmp, 42 FROM users
';`);

  for (const text of ['SELECT', 'tmp', '42', 'FROM']) {
    assert.deepEqual(
      scopesFor(multiline, 2, text),
      scopesFor(inline, 1, text),
      `${JSON.stringify(text)} should have the same scopes after a leading newline`
    );
  }

  assert.deepEqual(scopesFor(multiline, 2, 'tmp'), [
    'text.html.php',
    'source.php',
    'string.quoted.single.sql.php',
    'source.sql.embedded.php'
  ]);
});

test('gives inline and multiline partial clauses identical content scopes', () => {
  const doubleInline = tokenize('<?php\n$query = "WHERE record_id IN (42)";');
  const doubleMultiline = tokenize(`<?php
$query = "
  WHERE record_id IN (42)
";`);

  for (const text of ['WHERE', 'record_id', 'IN', '42']) {
    assert.deepEqual(
      scopesFor(doubleMultiline, 2, text),
      scopesFor(doubleInline, 1, text),
      `${JSON.stringify(text)} should have the same partial-clause scopes after a leading newline`
    );
  }

  const singleInline = tokenize("<?php\n$expression = 'WHEN enabled = 1 THEN 2';");
  const singleMultiline = tokenize(`<?php
$expression = '
  WHEN enabled = 1 THEN 2
';`);

  for (const text of ['WHEN', 'enabled', 'THEN', '2']) {
    assert.deepEqual(
      scopesFor(singleMultiline, 2, text),
      scopesFor(singleInline, 1, text),
      `${JSON.stringify(text)} should have the same expression-fragment scopes after a leading newline`
    );
  }
});

test('gives inline and multiline standalone functions identical SQL scopes', () => {
  const doubleInline = tokenize(
    '<?php\n$expression = "ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at)";'
  );
  const doubleMultiline = tokenize(`<?php
$expression = "
  ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at)
";`);

  for (const text of ['ROW_NUMBER', 'OVER', 'PARTITION', 'BY', 'ORDER']) {
    assert.deepEqual(
      scopesFor(doubleMultiline, 2, text),
      scopesFor(doubleInline, 1, text),
      `${text} should have the same function-expression scopes after a leading newline`
    );
  }

  const singleInline = tokenize("<?php\n$expression = 'COUNT(DISTINCT account_id)';");
  const singleMultiline = tokenize(`<?php
$expression = '
  COUNT(DISTINCT account_id)
';`);

  for (const text of ['COUNT', 'DISTINCT', 'account_id']) {
    assert.deepEqual(
      scopesFor(singleMultiline, 2, text),
      scopesFor(singleInline, 1, text),
      `${text} should have the same aggregate-expression scopes after a leading newline`
    );
  }
});

test('detects new partial-clause starters through wrapping parentheses', () => {
  const inline = tokenize('<?php\n$filter = "(( WHERE enabled = 1 ))";');
  assertEmbeddedSql(inline, 1, 'WHERE');
  assert.ok(scopesFor(inline, 1, '(').includes('source.sql.embedded.php'));

  const multiline = tokenize(`<?php
$ordering = "(
  (
    ORDER BY created_at
  )
  )";`);
  assertEmbeddedSql(multiline, 3, 'ORDER');
  assert.ok(scopesFor(multiline, 4, ')').includes('source.sql.embedded.php'));
});

test('detects an inline parenthesized WITH query with unchanged SQL scopes', () => {
  const unwrapped = tokenize(`<?php
$query = "WITH cte AS (SELECT 41) SELECT 73 WHERE id = $userId";`);
  const wrapped = tokenize(`<?php
$query = " (WITH cte AS (SELECT 41) SELECT 73 WHERE id = $userId)";`);

  for (const text of ['WITH', 'cte', 'SELECT', '41', '73', '$userId']) {
    assert.deepEqual(
      scopesFor(wrapped, 1, text),
      scopesFor(unwrapped, 1, text),
      `${JSON.stringify(text)} should keep its SQL scopes inside wrapping parentheses`
    );
  }

  assert.ok(scopesFor(wrapped, 1, '(').includes('source.sql.embedded.php'));
});

test('detects nested wrapping parentheses in a single-quoted string', () => {
  const unwrapped = tokenize("<?php\n$query = 'SELECT 41 FROM users';");
  const wrapped = tokenize("<?php\n$query = '((  SELECT 41 FROM users))';");

  for (const text of ['SELECT', '41', 'FROM']) {
    assert.deepEqual(scopesFor(wrapped, 1, text), scopesFor(unwrapped, 1, text));
  }
  assert.ok(scopesFor(wrapped, 1, '(').includes('source.sql.embedded.php'));
});

test('detects wrapping parentheses before a multiline SQL starter', () => {
  const result = tokenize(`<?php
$query = "
  ( ( WITH cte AS (SELECT 1)
      SELECT * FROM cte
  )
";`);

  assertEmbeddedSql(result, 2, 'WITH');
  assertEmbeddedSql(result, 3, 'SELECT');
  assert.ok(scopesFor(result, 2, '(').includes('source.sql.embedded.php'));
});

test('detects a SQL starter on the line after an opening parenthesis', () => {
  const result = tokenize(`<?php
$query = "(
  WITH cte AS (SELECT 1)
  SELECT * FROM cte
)";
$after = 1;`);

  assertEmbeddedSql(result, 2, 'WITH');
  assertEmbeddedSql(result, 3, 'SELECT');
  assert.deepEqual(scopesFor(result, 1, '('), scopesFor(result, 4, ')'));
  assert.ok(scopesFor(result, 4, ')').includes('source.sql.embedded.php'));
  assertNotEmbeddedSql(result, 5, '$after');
});

test('gives a parenthesis-only prefix the same SQL scopes as its closing parenthesis', () => {
  const result = tokenize(`<?php
$subquery = "
(
  WITH active AS (
    SELECT id FROM users
  )
  SELECT * FROM active
)
";`);

  assert.deepEqual(scopesFor(result, 2, '('), scopesFor(result, 7, ')'));
});

test('allows parenthesis-only prefix lines before the SQL starter', () => {
  const result = tokenize('<?php\r\n$query = "\r\n\t(\r\n\t\t(\r\n\t\t\tSELECT 1\r\n\t\t)\r\n\t)\r\n";\r\n$after = 1;');

  assertEmbeddedSql(result, 4, 'SELECT');
  assertNotEmbeddedSql(result, 8, '$after');
});

test('detects an extended JOIN starter through wrapping parentheses', () => {
  const result = tokenize('<?php\n$fragment = "(( LEFT OUTER JOIN accounts ON accounts.id = users.account_id ))";');
  assertEmbeddedSql(result, 1, 'LEFT');
  assertEmbeddedSql(result, 1, 'JOIN');
});

test('loads a parenthesized query when source.php is the root grammar', () => {
  const result = tokenize('$query = "((WITH cte AS (SELECT 1) SELECT * FROM cte))";', directPhpGrammar);
  assertEmbeddedSql(result, 0, 'WITH');
  assert.ok(scopesFor(result, 0, '(').includes('source.sql.embedded.php'));
});

for (const { source, probe } of [
  { source: '(WITHHOLD value)', probe: 'WITHHOLD' },
  { source: '((CASEY value))', probe: 'CASEY' },
  { source: '((select value))', probe: 'select' },
  { source: '() SELECT value', probe: 'SELECT' },
  { source: '() ROW_NUMBER()', probe: 'ROW_NUMBER' },
  { source: ')SELECT value', probe: 'SELECT' },
  { source: '(ordinary prose)', probe: 'ordinary' }
]) {
  test(`does not treat ${source} as a parenthesized SQL starter`, () => {
    const result = tokenize(`<?php\n$message = "${source}";`);
    assertNotEmbeddedSql(result, 1, probe);
  });
}

test('parenthesis-only prefix lines still let prose block a later SELECT', () => {
  const result = tokenize(`<?php
$message = "(
  (
  ordinary prose
  SELECT is mentioned later
)";`);

  assertNotEmbeddedSql(result, 4, 'SELECT');
  assert.ok(scopesFor(result, 3, 'ordinary').includes('string.quoted.double.php'));
});

test('an unmatched parenthesis-only prefix does not trap following PHP', () => {
  const result = tokenize(`<?php
$message = "(
  (
";
$after = 1;`);

  assert.deepEqual(scopesFor(result, 4, '$after'), [
    'text.html.php',
    'source.php',
    'variable.other.php'
  ]);
});

test('gives SQL heredocs the same content scopes as double-quoted SQL', () => {
  const inline = tokenize(`<?php
$query = "SELECT tmp, 42, 'label_value' FROM users WHERE id = $userId";`);
  const heredoc = tokenize(`<?php
$query = <<<SQL
  SELECT tmp, 42, 'label_value' FROM users WHERE id = $userId
SQL;`);

  for (const text of ['SELECT', 'tmp', '42', 'label_value', '$userId']) {
    assert.deepEqual(
      scopesFor(heredoc, 2, text),
      scopesFor(inline, 1, text),
      `${JSON.stringify(text)} should have matching double-quoted and heredoc scopes`
    );
  }

  assert.deepEqual(scopesFor(heredoc, 2, 'tmp'), [
    'text.html.php',
    'source.php',
    'string.quoted.double.sql.php',
    'source.sql.embedded.php'
  ]);
  assert.ok(scopesFor(heredoc, 2, '$userId').includes('variable.other.php'));
  assert.ok(scopesFor(heredoc, 1, 'SQL').includes('keyword.operator.heredoc.php'));
  assert.ok(scopesFor(heredoc, 3, 'SQL').includes('keyword.operator.heredoc.php'));
});

test('gives SQL nowdocs the same content scopes as single-quoted SQL', () => {
  const inline = tokenize("<?php\n$query = 'SELECT tmp, 42 FROM users WHERE id = $userId';");
  const nowdoc = tokenize(`<?php
$query = <<<'SQL'
  SELECT tmp, 42 FROM users WHERE id = $userId
SQL;`);

  for (const text of ['SELECT', 'tmp', '42', 'FROM', '$userId']) {
    assert.deepEqual(
      scopesFor(nowdoc, 2, text),
      scopesFor(inline, 1, text),
      `${JSON.stringify(text)} should have matching single-quoted and nowdoc scopes`
    );
  }

  assert.deepEqual(scopesFor(nowdoc, 2, 'tmp'), [
    'text.html.php',
    'source.php',
    'string.quoted.single.sql.php',
    'source.sql.embedded.php'
  ]);
  assert.ok(!scopesFor(nowdoc, 2, '$userId').includes('variable.other.php'));
  assert.ok(scopesFor(nowdoc, 1, 'SQL').includes('keyword.operator.nowdoc.php'));
});

for (const opener of ['SQL', '"SQL"', 'DQL', '"DQL"']) {
  test(`supports the stock ${opener} heredoc label`, () => {
    const terminator = opener.replaceAll('"', '');
    const result = tokenize(`<?php
$query = <<<${opener}
    SELECT "display_name"
    FROM users
    ${terminator};
$after = 1;`);

    assertEmbeddedSql(result, 2, 'SELECT');
    assertEmbeddedSql(result, 3, 'FROM');
    assertNotEmbeddedSql(result, 5, '$after');
  });
}

test('supports the stock DQL nowdoc label', () => {
  const result = tokenize(`<?php
$query = <<<'DQL'
  SELECT id FROM users
DQL;
$after = 1;`);

  assertEmbeddedSql(result, 2, 'SELECT');
  assert.ok(!scopesFor(result, 2, 'id').includes('variable.other.php'));
  assertNotEmbeddedSql(result, 4, '$after');
});

test('does not close a SQL heredoc on a longer identifier', () => {
  const result = tokenize(`<?php
$query = <<<SQL
  SELECT id
SQL_SUFFIX
  FROM users
SQL;
$after = 1;`);

  assertEmbeddedSql(result, 2, 'SELECT');
  assertEmbeddedSql(result, 4, 'FROM');
  assert.deepEqual(scopesFor(result, 6, '$after'), [
    'text.html.php',
    'source.php',
    'variable.other.php'
  ]);
});

for (const { opener, terminator, normalScope } of [
  { opener: 'TEXT', terminator: 'TEXT', normalScope: 'string.unquoted.heredoc.php' },
  { opener: '"TEXT"', terminator: 'TEXT', normalScope: 'string.unquoted.heredoc.php' },
  { opener: "'TEXT'", terminator: 'TEXT', normalScope: 'string.unquoted.nowdoc.php' },
  { opener: 'sql', terminator: 'sql', normalScope: 'string.unquoted.heredoc.php' },
  { opener: "'sql'", terminator: 'sql', normalScope: 'string.unquoted.nowdoc.php' }
]) {
  test(`does not override the ${opener} non-SQL label`, () => {
    const result = tokenize(`<?php
$value = <<<${opener}
  SELECT is ordinary content
${terminator};`);

    assertNotEmbeddedSql(result, 2, 'SELECT');
    assert.ok(scopesFor(result, 2, 'SELECT').includes(normalScope));
  });
}

test('loads the injection when source.php is the root grammar', () => {
  const result = tokenize('$query = "\n  SELECT id FROM users\n";', directPhpGrammar);
  assertEmbeddedSql(result, 1, 'SELECT');
});

test('loads the heredoc override when source.php is the root grammar', () => {
  const result = tokenize(`$query = <<<SQL
  SELECT id FROM users
SQL;`, directPhpGrammar);

  assertEmbeddedSql(result, 1, 'SELECT');
  assert.deepEqual(scopesFor(result, 1, 'id'), [
    'source.php',
    'string.quoted.double.sql.php',
    'source.sql.embedded.php'
  ]);
});

test('detects SQL after a newline and horizontal indentation', () => {
  const result = tokenize(`<?php
$query = "   
    SELECT id
    FROM users
";
$after = 1;`);

  assertEmbeddedSql(result, 2, 'SELECT');
  assertEmbeddedSql(result, 3, 'FROM');
  assertNotEmbeddedSql(result, 5, '$after');
});

test('allows multiple leading blank lines and tabs with CRLF input', () => {
  const result = tokenize('<?php\r\n$query = "\r\n\r\n\tSELECT 1\r\n";');
  assertEmbeddedSql(result, 3, 'SELECT');
});

test('supports multiline single-quoted PHP strings', () => {
  const result = tokenize(`<?php
$query = '
  CASE WHEN enabled = 1 THEN 1 ELSE 0 END
';`);
  assertEmbeddedSql(result, 2, 'CASE');
});

test('keeps escaped quotes and PHP interpolation inside double-quoted SQL', () => {
  const result = tokenize(`<?php
$query = "
  SELECT \\\"display_name\\\"
  FROM users
  WHERE id = $userId
";
$after = 1;`);

  assertEmbeddedSql(result, 2, 'SELECT');
  assertEmbeddedSql(result, 3, 'FROM');
  assertEmbeddedSql(result, 4, 'WHERE');
  assert.ok(tokenContaining(result, 4, '$userId').scopes.includes('variable.other.php'));
  assertNotEmbeddedSql(result, 6, '$after');
});

test('keeps escaped apostrophes inside single-quoted SQL', () => {
  const result = tokenize(`<?php
$query = '
  SELECT id
  FROM users
  WHERE name = \\'Ada\\'
';
$after = 1;`);

  assertEmbeddedSql(result, 2, 'SELECT');
  assertEmbeddedSql(result, 3, 'FROM');
  assertEmbeddedSql(result, 4, 'WHERE');
  assertNotEmbeddedSql(result, 6, '$after');
});

const joinStarters = [
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN',
  'FULL JOIN',
  'FULL OUTER JOIN',
  'CROSS JOIN',
  'NATURAL JOIN',
  'NATURAL LEFT OUTER JOIN',
  'STRAIGHT_JOIN'
];

for (const starter of joinStarters) {
  test(`detects ${starter} as the first SQL phrase`, () => {
    const result = tokenize(`<?php
$fragment = "
  ${starter} accounts ON accounts.id = users.account_id
";`);
    assertEmbeddedSql(result, 2, starter.split(' ')[0]);
  });
}

test('detects CASE on the opening-quote line', () => {
  const result = tokenize('<?php\n$expression = "CASE WHEN active = 1 THEN 1 END";');
  assertEmbeddedSql(result, 1, 'CASE');
});

test('preserves SQL backtick-quoted identifiers in the rendered grammar', () => {
  const result = tokenize('<?php\n$query = "SELECT `column_name` FROM `table_name`";');

  assertEmbeddedSql(result, 1, 'SELECT');
  assert.ok(scopesFor(result, 1, 'column_name').includes('string.quoted.other.backtick.sql'));
  assert.ok(scopesFor(result, 1, 'table_name').includes('string.quoted.other.backtick.sql'));
});

test('detects a join phrase on the opening-quote line in a single-quoted string', () => {
  const result = tokenize("<?php\n$fragment = 'LEFT OUTER JOIN accounts ON accounts.id = users.account_id';");
  assertEmbeddedSql(result, 1, 'LEFT');
});

test('does not promote a prose string when SQL-looking text appears later', () => {
  const result = tokenize(`<?php
$message = "
  This is ordinary prose for $name.
  SELECT is mentioned later.
";`);
  assertNotEmbeddedSql(result, 3, 'SELECT');
  assert.ok(scopesFor(result, 2, 'ordinary').includes('string.quoted.double.php'));
  assert.ok(scopesFor(result, 2, '$name').includes('variable.other.php'));
});

test('keeps multiline single-quoted prose in an ordinary PHP string', () => {
  const result = tokenize(`<?php
$message = '
  It\\'s ordinary prose.
  CASE is mentioned later.
';`);

  assertNotEmbeddedSql(result, 3, 'CASE');
  assert.ok(scopesFor(result, 2, 'ordinary').includes('string.quoted.single.php'));
  assert.ok(scopesFor(result, 2, "\\'").includes('constant.character.escape.php'));
});

test('escaped quotes do not defeat the non-SQL blocker state', () => {
  const result = tokenize(`<?php
$message = "
  Ordinary prose with an escaped quote: \\\"still prose\\\".
  SELECT is mentioned later.
";
$after = 1;`);

  assertNotEmbeddedSql(result, 3, 'SELECT');
  assertNotEmbeddedSql(result, 5, '$after');
});

test('non-ASCII whitespace before prose blocks a later SQL-looking line', () => {
  const result = tokenize(`<?php
$message = "
\u00a0ordinary prose
  SELECT is mentioned later.
";`);

  assertNotEmbeddedSql(result, 3, 'SELECT');
  assert.ok(scopesFor(result, 2, 'ordinary').includes('string.quoted.double.php'));
});

test('empty pending strings close without trapping following PHP', () => {
  const result = tokenize(`<?php
$emptyDouble = "
";
$spacesSingle = '
  \t
';
$after = 1;`);

  assertNotEmbeddedSql(result, 6, '$after');
  assert.deepEqual(scopesFor(result, 6, '$after'), [
    'text.html.php',
    'source.php',
    'variable.other.php'
  ]);
});

for (const nonStarter of [
  'SELECTED',
  'CASEY',
  'JOINED',
  'WHEREVER',
  'USERLAND',
  'STRAIGHT_JOINED',
  'WHERE_1',
  'WHERE$parameter',
  'WHERE\u{00E9}',
  'WHERE\u0301',
  'WHERE\u{0663}',
  'XWHERE'
]) {
  test(`requires a complete SQL starter: ${nonStarter}`, () => {
    const result = tokenize(`<?php
$message = "
  ${nonStarter}
";`);
    assertNotEmbeddedSql(result, 2, nonStarter.split(' ')[0]);
  });
}

test('allows punctuation immediately after a complete SQL keyword', () => {
  for (const source of [
    'WHERE(value = 1)',
    'WHERE.value',
    'WHERE\u{00A0}value',
    'WHERE\u{2014}value'
  ]) {
    const result = tokenize(`<?php\n$fragment = "${source}";`);
    assertEmbeddedSql(result, 1, 'WHERE');
  }
});

test('accepts the intentional ambiguity of uppercase keyword prose', () => {
  for (const { source, probe } of [
    { source: 'IN MEMORY OF', probe: 'IN' },
    { source: 'USER GUIDE', probe: 'USER' },
    { source: 'LEFT table', probe: 'LEFT' }
  ]) {
    const result = tokenize(`<?php\n$message = "${source}";`);
    assertEmbeddedSqlContent(result, 1, probe);
  }
});

test('does not promote uppercase prose when a SQL keyword appears only later', () => {
  const result = tokenize(`<?php
$message = "
  HELLO FROM users
  WHERE is mentioned later
";`);

  assertNotEmbeddedSql(result, 2, 'HELLO');
  assertNotEmbeddedSql(result, 2, 'FROM');
  assertNotEmbeddedSql(result, 3, 'WHERE');
});

test('does not promote prose when a recognized SQL function appears only later', () => {
  const result = tokenize(`<?php
$message = "
  Ordinary prose comes first.
  ROW_NUMBER() OVER () is mentioned later.
";`);

  assertNotEmbeddedSql(result, 2, 'Ordinary');
  assertNotEmbeddedSql(result, 3, 'ROW_NUMBER');
});

for (const { source, probe } of [
  { source: 'COUNT', probe: 'COUNT' },
  { source: 'COUNT value', probe: 'COUNT' },
  { source: 'COALESCE value', probe: 'COALESCE' },
  { source: 'ROW_NUMBER OVER ()', probe: 'ROW_NUMBER' },
  { source: 'COUNTED()', probe: 'COUNTED' },
  { source: 'ROW_NUMBERED()', probe: 'ROW_NUMBERED' },
  { source: 'COUNT_1()', probe: 'COUNT_1' },
  { source: 'COUNT$parameter()', probe: 'COUNT' },
  { source: 'COUNT\u{00E9}()', probe: 'COUNT' },
  { source: 'COUNT\u0301()', probe: 'COUNT' },
  { source: 'COUNT\u{0663}()', probe: 'COUNT' },
  { source: 'MY_FUNCTION()', probe: 'MY_FUNCTION' }
]) {
  test(`requires a complete recognized SQL function call: ${source}`, () => {
    const result = tokenize(`<?php\n$message = "${source}";`);
    assertNotEmbeddedSql(result, 1, probe);
  });
}

test('preserves the uppercase-only convention for function-call starters', () => {
  for (const starter of [
    'row_number() OVER ()',
    'Row_Number() OVER ()',
    'count(*)',
    'Count(*)',
    'coalesce(account_id, 0)',
    'Coalesce(account_id, 0)'
  ]) {
    const functionName = starter.match(/^[A-Za-z_]+/)[0];
    const result = tokenize(`<?php\n$message = "${starter}";`);
    assertNotEmbeddedSql(result, 1, functionName);
  }
});

test('preserves the stock uppercase-only starter convention', () => {
  for (const starter of ['select', 'where', 'Select', 'Where']) {
    const result = tokenize(`<?php
$message = "
  ${starter} id from users
";`);
    assertNotEmbeddedSql(result, 2, starter);
  }
});

test('lets the case-insensitive SQL grammar color lowercase keywords after detection', () => {
  const result = tokenize('<?php\n$query = "WHERE id in (select id from users)";');
  assertEmbeddedSql(result, 1, 'WHERE');

  for (const keyword of ['in', 'select', 'from']) {
    const scopes = scopesFor(result, 1, keyword);
    assert.ok(scopes.includes('source.sql.embedded.php'));
    assert.ok(
      scopes.some((scope) => /^keyword\..*\.sql$/.test(scope)),
      `${keyword} should be tokenized as a SQL keyword; scopes were ${scopes.join(' ')}`
    );
  }
});
