import assert from 'node:assert/strict';
import test from 'node:test';

import { renderGrammar } from '../scripts/grammar-template.mjs';

function parseRenderedGrammar(starterPattern = 'SQL_STARTER', information = ['generated metadata']) {
  return JSON.parse(renderGrammar({
    starterPattern,
    informationForContributors: information
  }));
}

test('renders dynamic regex and metadata values through JSON without changing them', () => {
  const starterPattern = '(?:WORD\\p{L}|"quoted"|`tick`|${literal})\nNEXT';
  const information = ['quote " slash \\ newline\n backtick ` and ${literal}'];
  const output = renderGrammar({
    starterPattern,
    informationForContributors: information
  });
  const grammar = JSON.parse(output);

  assert.equal(output, `${JSON.stringify(grammar, null, 2)}\n`);
  assert.ok(!output.endsWith('\n\n'));
  assert.deepEqual(grammar.information_for_contributors, information);
  assert.deepEqual(
    {
      doubleInline: grammar.repository['sql-double-quoted-inline'].begin,
      singleInline: grammar.repository['sql-single-quoted-inline'].begin,
      doubleMultiline: grammar.repository['sql-after-leading-newlines-double'].begin,
      singleMultiline: grammar.repository['sql-after-leading-newlines-single'].begin
    },
    {
      doubleInline: String.raw`(")[\t ]*(?=${starterPattern})`,
      singleInline: String.raw`(')[\t ]*(?=${starterPattern})`,
      doubleMultiline: String.raw`^[\t ]*(?=${starterPattern})`,
      singleMultiline: String.raw`^[\t ]*(?=${starterPattern})`
    }
  );
});

test('preserves the template backticks used by SQL quoted identifiers', () => {
  const grammar = parseRenderedGrammar();
  const doubleQuotedPatterns = grammar.repository['double-quoted-sql-content'].patterns;
  const singleQuotedPatterns = grammar.repository['single-quoted-sql-content'].patterns;
  const backtickFields = [
    doubleQuotedPatterns[2].match,
    doubleQuotedPatterns[4].match,
    doubleQuotedPatterns[6].begin,
    doubleQuotedPatterns[6].end,
    singleQuotedPatterns[2].match,
    singleQuotedPatterns[4].match
  ];

  const backtickCount = backtickFields.reduce(
    (count, value) => count + [...value].filter((character) => character === '`').length,
    0
  );
  assert.equal(backtickCount, 10);
});

test('rejects missing or invalid template arguments', () => {
  for (const options of [
    undefined,
    {},
    { starterPattern: '', informationForContributors: ['metadata'] },
    { starterPattern: 'SQL', informationForContributors: [] },
    { starterPattern: 'SQL', informationForContributors: [''] },
    { starterPattern: 'SQL', informationForContributors: [42] }
  ]) {
    assert.throws(() => renderGrammar(options), TypeError);
  }
});
