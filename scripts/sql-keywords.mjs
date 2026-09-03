// Additional dialect keywords that are useful as fragment starters.
export const SUPPLEMENTAL_DIALECT_KEYWORDS = `
  ANALYZE CONFLICT DELIMITER DESCRIBE DO EXPLAIN ILIKE LATERAL LOCK MATCH_RECOGNIZE
  MATERIALIZED MINUS NOTHING OFFSET ONLY OPTIMIZE PIVOT PRAGMA QUALIFY REINDEX
  RENAME RETURNING SHOW SIMILAR STRUCT TEMP TEMPORARY UNNEST UNPIVOT UPSERT VACUUM
`.trim().split(/\s+/);

const KEYWORD_SCOPE_PATTERN = /^keyword(?:\.[A-Za-z0-9_-]+)*\.sql$/;
const FUNCTION_SCOPE_PATTERN = /^support\.function(?:\.[A-Za-z0-9_-]+)*\.sql$/;
const GLOBAL_VARIABLE_FUNCTION_SCOPE = 'support.function.globalvar.sql';
const ORDINARY_FUNCTION_PREFIX = String.raw`(?i)\b(`;
const GLOBAL_VARIABLE_FUNCTION_PREFIX = String.raw`(?<!@)@@(?i)\b(`;
const FUNCTION_SUFFIX = String.raw`)\b\s*\(`;
const KEYWORD_TOKEN_SEPARATOR = '\u0000';
const MAX_KEYWORD_PATTERN_VARIANTS = 10_000;
const BROKEN_CREATE_ALTERNATIVE = String.raw`create(\\s+or\\s+alter)?`;

function sortCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function keywordPatternError(scopes, message, index = null) {
  const offset = index === null ? '' : ` at offset ${index}`;
  return new Error(`Unsupported SQL keyword rule ${scopes.join(', ')}${offset}: ${message}`);
}

function joinKeywordVariants(left, right, scopes) {
  if (left === null || right === null) {
    return null;
  }

  const variants = new Set();
  for (const leftVariant of left) {
    for (const rightVariant of right) {
      variants.add(`${leftVariant}${rightVariant}`.replace(/\u0000+/g, KEYWORD_TOKEN_SEPARATOR));
      if (variants.size > MAX_KEYWORD_PATTERN_VARIANTS) {
        throw keywordPatternError(scopes, `expanded to more than ${MAX_KEYWORD_PATTERN_VARIANTS} variants`);
      }
    }
  }
  return variants;
}

function mergeKeywordVariants(alternatives, scopes) {
  if (alternatives.some((alternative) => alternative === null)) {
    return null;
  }

  const variants = new Set(alternatives.flatMap((alternative) => [...alternative]));
  if (variants.size > MAX_KEYWORD_PATTERN_VARIANTS) {
    throw keywordPatternError(scopes, `expanded to more than ${MAX_KEYWORD_PATTERN_VARIANTS} variants`);
  }
  return variants;
}

/**
 * Parse only the small, finite regex subset used by vscode-mssql's current
 * keyword rules. A null variant set means the expression consumes dynamic
 * text; that is permitted outside keyword captures but rejected when selected.
 */
function parseKeywordPattern(pattern, scopes) {
  if (typeof pattern !== 'string') {
    throw new Error(`SQL keyword rule ${scopes.join(', ')} has no match pattern`);
  }

  let index = 0;
  let captureCount = 0;
  const captures = new Map();
  const empty = () => new Set(['']);
  const separator = () => new Set([KEYWORD_TOKEN_SEPARATOR]);

  function readCharacter() {
    const character = String.fromCodePoint(pattern.codePointAt(index));
    index += character.length;
    return character;
  }

  function rejectNonAsciiCharacter(character, offset, context = 'keyword pattern') {
    if (character.codePointAt(0) > 0x7f) {
      throw keywordPatternError(
        scopes,
        `non-ASCII character ${JSON.stringify(character)} in ${context}`,
        offset
      );
    }
  }

  function parseAlternation(terminator = null) {
    const alternatives = [parseSequence(terminator)];
    while (pattern[index] === '|') {
      index += 1;
      alternatives.push(parseSequence(terminator));
    }
    return mergeKeywordVariants(alternatives, scopes);
  }

  function parseSequence(terminator) {
    let variants = empty();
    while (index < pattern.length
        && pattern[index] !== '|'
        && (terminator === null || pattern[index] !== terminator)) {
      if (pattern[index] === ')') {
        throw keywordPatternError(scopes, 'unmatched closing parenthesis', index);
      }
      variants = joinKeywordVariants(variants, parseQuantifiedAtom(), scopes);
    }
    return variants;
  }

  function parseQuantifiedAtom() {
    const atom = parseAtom();
    const quantifier = pattern[index];
    if (!['?', '*', '+'].includes(quantifier)) {
      if (quantifier === '{') {
        throw keywordPatternError(scopes, 'bounded quantifiers are not supported', index);
      }
      return atom;
    }

    index += 1;
    if (pattern[index] === '?' || pattern[index] === '+') {
      throw keywordPatternError(scopes, 'lazy and possessive quantifiers are not supported', index);
    }
    if (atom === null) {
      return null;
    }

    const hasWordCharacters = [...atom].some((variant) => /[A-Za-z0-9_]/.test(variant));
    if (quantifier === '?') {
      return mergeKeywordVariants([empty(), atom], scopes);
    }
    if (hasWordCharacters) {
      return null;
    }

    const repetitions = new Set();
    if (quantifier === '*' || atom.has('')) {
      repetitions.add('');
    }
    if ([...atom].some((variant) => variant.includes(KEYWORD_TOKEN_SEPARATOR))) {
      repetitions.add(KEYWORD_TOKEN_SEPARATOR);
    }
    return repetitions;
  }

  function parseGroup() {
    const groupOffset = index++;
    let captureNumber = null;

    if (pattern[index] !== '?') {
      captureNumber = ++captureCount;
    } else if (pattern.startsWith('?:', index)) {
      index += 2;
    } else if (pattern.startsWith('?i:', index)) {
      index += 3;
    } else if (pattern.startsWith('?i)', index)) {
      index += 3;
      return empty();
    } else {
      throw keywordPatternError(scopes, 'unsupported group construct', groupOffset);
    }

    const variants = parseAlternation(')');
    if (pattern[index] !== ')') {
      throw keywordPatternError(scopes, 'unterminated group', groupOffset);
    }
    index += 1;
    if (captureNumber !== null) {
      captures.set(captureNumber, variants);
    }
    return variants;
  }

  function parseCharacterClass() {
    const classOffset = index++;
    let canConsumeWordCharacter = pattern[index] === '^';
    if (pattern[index] === '^') {
      index += 1;
    }
    if (pattern[index] === ']') {
      index += 1;
    }

    while (index < pattern.length && pattern[index] !== ']') {
      const characterOffset = index;
      let character = readCharacter();
      rejectNonAsciiCharacter(character, characterOffset, 'character class');
      if (character === '\\') {
        if (index === pattern.length) {
          throw keywordPatternError(scopes, 'trailing escape in character class', classOffset);
        }
        const escapedCharacterOffset = index;
        character = readCharacter();
        rejectNonAsciiCharacter(character, escapedCharacterOffset, 'character class');
        canConsumeWordCharacter ||= !/[^A-Za-z0-9_]/.test(character);
      } else {
        canConsumeWordCharacter ||= character === '-' || /[A-Za-z0-9_]/.test(character);
      }
    }
    if (pattern[index] !== ']') {
      throw keywordPatternError(scopes, 'unterminated character class', classOffset);
    }
    index += 1;
    return canConsumeWordCharacter ? null : separator();
  }

  function parseEscape() {
    const escapeOffset = index++;
    if (index === pattern.length) {
      throw keywordPatternError(scopes, 'trailing escape', escapeOffset);
    }

    const escapedCharacterOffset = index;
    const escaped = readCharacter();
    rejectNonAsciiCharacter(escaped, escapedCharacterOffset);
    if (/\d/.test(escaped)) {
      while (/\d/.test(pattern[index] ?? '')) {
        index += 1;
      }
      return null;
    }
    if (escaped === 's') {
      return separator();
    }
    if (escaped === 'b') {
      return empty();
    }
    if (escaped === 'w') {
      return null;
    }
    if (/[^A-Za-z0-9_]/.test(escaped)) {
      return separator();
    }
    throw keywordPatternError(scopes, `unsupported escape \\${escaped}`, escapeOffset);
  }

  function parseAtom() {
    const characterOffset = index;
    const character = String.fromCodePoint(pattern.codePointAt(index));
    if (character === '(') {
      return parseGroup();
    }
    if (character === '[') {
      return parseCharacterClass();
    }
    if (character === '\\') {
      return parseEscape();
    }
    if (character === '^' || character === '$') {
      index += 1;
      return empty();
    }
    if (character === '.') {
      index += 1;
      return null;
    }
    if (character === '?' || character === '*' || character === '+' || character === '{') {
      throw keywordPatternError(scopes, `quantifier ${character} has no target`, index);
    }

    index += character.length;
    if (/[A-Za-z0-9_]/.test(character)) {
      return new Set([character]);
    }
    rejectNonAsciiCharacter(character, characterOffset);
    return separator();
  }

  const expression = parseAlternation();
  if (index !== pattern.length) {
    throw keywordPatternError(scopes, 'unexpected trailing pattern content', index);
  }
  return { captures, expression };
}

function getLiteralKeywordAtoms(rule) {
  const scopes = [
    rule?.name,
    ...Object.values(rule?.captures ?? {}).map((capture) => capture?.name)
  ].filter((scope) => KEYWORD_SCOPE_PATTERN.test(scope ?? ''));
  if (scopes.length === 0) {
    return [];
  }

  const parsed = parseKeywordPattern(rule.match, scopes);
  const selectedVariants = [];
  if (KEYWORD_SCOPE_PATTERN.test(rule.name ?? '')) {
    selectedVariants.push(parsed.expression);
  }

  for (const [captureKey, capture] of Object.entries(rule.captures ?? {})) {
    if (!KEYWORD_SCOPE_PATTERN.test(capture?.name ?? '')) {
      continue;
    }
    if (!/^(?:0|[1-9]\d*)$/.test(captureKey)) {
      throw keywordPatternError(scopes, `invalid keyword capture number ${captureKey}`);
    }
    const captureNumber = Number(captureKey);
    const variants = captureNumber === 0 ? parsed.expression : parsed.captures.get(captureNumber);
    if (variants === undefined) {
      throw keywordPatternError(scopes, `keyword capture ${captureNumber} is missing from the pattern`);
    }
    selectedVariants.push(variants);
  }

  const keywords = new Set();
  for (const variants of selectedVariants) {
    if (variants === null) {
      throw keywordPatternError(scopes, 'keyword scope contains dynamic or unbounded text');
    }
    for (const variant of variants) {
      for (const keyword of variant.split(KEYWORD_TOKEN_SEPARATOR).filter(Boolean)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(keyword)) {
          throw keywordPatternError(scopes, `invalid literal keyword ${JSON.stringify(keyword)}`);
        }
        keywords.add(keyword.toUpperCase());
      }
    }
  }
  return keywords;
}

function getLeadingLiteralKeywords(pattern, scope) {
  // Upstream currently double-escapes the whitespace in this optional suffix,
  // so it cannot affect the only part needed here: the leading CREATE token.
  const normalizedPattern = pattern.replace(BROKEN_CREATE_ALTERNATIVE, 'create');
  const { expression } = parseKeywordPattern(normalizedPattern, [scope]);
  if (expression === null) {
    throw keywordPatternError([scope], 'contains dynamic or unbounded text');
  }

  const keywords = new Set();
  for (const variant of expression) {
    const [keyword] = variant.split(KEYWORD_TOKEN_SEPARATOR).filter(Boolean);
    if (!keyword || !/^[A-Za-z][A-Za-z0-9_]*$/.test(keyword)) {
      throw keywordPatternError([scope], `invalid leading keyword in ${JSON.stringify(variant)}`);
    }
    keywords.add(keyword.toUpperCase());
  }
  return keywords;
}

function getGrammarRules(grammar) {
  const rules = [];
  const visited = new Set();

  function visitContainer(container) {
    for (const rule of container?.patterns ?? []) {
      visitRule(rule);
    }
    for (const rule of Object.values(container?.repository ?? {})) {
      visitRule(rule);
    }
  }

  function visitRule(rule) {
    if (!rule || typeof rule !== 'object' || visited.has(rule)) {
      return;
    }
    visited.add(rule);
    rules.push(rule);
    visitContainer(rule);
  }

  visitContainer(grammar);
  return rules;
}

function unwrapFunctionAlternatives(pattern, prefix) {
  if (typeof pattern !== 'string'
      || !pattern.startsWith(prefix)
      || !pattern.endsWith(FUNCTION_SUFFIX)) {
    return null;
  }

  return pattern.slice(prefix.length, -FUNCTION_SUFFIX.length);
}

function expandFunctionAlternative(alternative, scope) {
  if (/^[a-z0-9_]+$/.test(alternative)) {
    return [alternative.toUpperCase()];
  }

  const optionalSuffix = /^([a-z0-9_]+)\(([a-z0-9_]+)\)\?$/.exec(alternative);
  if (optionalSuffix) {
    const [, base, suffix] = optionalSuffix;
    return [base.toUpperCase(), `${base}${suffix}`.toUpperCase()];
  }

  throw new Error(`Unexpected SQL function alternative in ${scope}: ${alternative}`);
}

function getFunctionCaptureScope(rule) {
  const functionCaptures = Object.entries(rule?.captures ?? {})
    .filter(([, capture]) => FUNCTION_SCOPE_PATTERN.test(capture?.name ?? ''));

  if (functionCaptures.length === 0) {
    return null;
  }

  if (functionCaptures.length !== 1 || functionCaptures[0][0] !== '1') {
    throw new Error('Expected each SQL function rule to assign its function scope to capture 1');
  }

  return functionCaptures[0][1].name;
}

export function getSqlKeywordInventory(sqlGrammar) {
  if (!Array.isArray(sqlGrammar?.patterns)) {
    throw new Error('The SQL grammar has no patterns array');
  }

  const grammarRules = getGrammarRules(sqlGrammar);
  const broadRules = grammarRules.filter(({ name }) => name === 'keyword.other.sql');
  if (broadRules.length !== 1) {
    throw new Error(`Expected one keyword.other.sql rule; found ${broadRules.length}`);
  }
  const [broadRule] = broadRules;

  const wrapper = /^\\b\(\?i\)\((.*)\)\\b$/s.exec(broadRule.match);
  if (!wrapper) {
    throw new Error('The SQL keyword rule has an unexpected pattern');
  }

  const broadKeywords = getLeadingLiteralKeywords(wrapper[1], broadRule.name);

  const scopedKeywords = new Set();
  for (const rule of grammarRules) {
    if (rule === broadRule) {
      continue;
    }

    for (const keyword of getLiteralKeywordAtoms(rule)) {
      scopedKeywords.add(keyword);
    }
  }

  const vscodeKeywords = new Set([...broadKeywords, ...scopedKeywords]);

  const keywords = new Set(vscodeKeywords);
  let supplementalAdditions = 0;
  for (const keyword of SUPPLEMENTAL_DIALECT_KEYWORDS) {
    if (!keywords.has(keyword)) {
      supplementalAdditions += 1;
    }
    keywords.add(keyword);
  }

  return {
    keywords: [...keywords].sort(sortCodeUnits),
    vscodeKeywords: [...vscodeKeywords].sort(sortCodeUnits),
    counts: {
      broad: broadKeywords.size,
      scoped: scopedKeywords.size,
      vscode: vscodeKeywords.size,
      supplemental: SUPPLEMENTAL_DIALECT_KEYWORDS.length,
      supplementalAdditions,
      total: keywords.size
    }
  };
}

export function getSqlKeywords(sqlGrammar) {
  return getSqlKeywordInventory(sqlGrammar).keywords;
}

export function getSqlFunctionInventory(sqlGrammar) {
  if (!Array.isArray(sqlGrammar?.patterns)) {
    throw new Error('The SQL grammar has no patterns array');
  }

  const functions = new Set();
  const excludedGlobalVariables = new Set();
  let rules = 0;
  let ordinaryRules = 0;
  let excludedGlobalVariableRules = 0;
  let rawAlternatives = 0;
  let expandedOccurrences = 0;
  let excludedGlobalVariableAlternatives = 0;

  for (const rule of getGrammarRules(sqlGrammar)) {
    const scope = getFunctionCaptureScope(rule);
    if (!scope) {
      continue;
    }

    rules += 1;
    if (scope === GLOBAL_VARIABLE_FUNCTION_SCOPE) {
      const body = unwrapFunctionAlternatives(rule.match, GLOBAL_VARIABLE_FUNCTION_PREFIX);
      if (body === null) {
        throw new Error(`${GLOBAL_VARIABLE_FUNCTION_SCOPE} has an unexpected pattern`);
      }

      excludedGlobalVariableRules += 1;
      const alternatives = body.split('|');
      excludedGlobalVariableAlternatives += alternatives.length;
      for (const alternative of alternatives) {
        for (const name of expandFunctionAlternative(alternative, scope)) {
          excludedGlobalVariables.add(name);
        }
      }
      continue;
    }

    const body = unwrapFunctionAlternatives(rule.match, ORDINARY_FUNCTION_PREFIX);
    if (body === null) {
      throw new Error(`${scope} has an unexpected pattern`);
    }

    ordinaryRules += 1;
    const alternatives = body.split('|');
    rawAlternatives += alternatives.length;
    for (const alternative of alternatives) {
      const expanded = expandFunctionAlternative(alternative, scope);
      expandedOccurrences += expanded.length;
      for (const name of expanded) {
        functions.add(name);
      }
    }
  }

  if (excludedGlobalVariableRules !== 1) {
    throw new Error(
      `Expected exactly one ${GLOBAL_VARIABLE_FUNCTION_SCOPE} rule; found ${excludedGlobalVariableRules}`
    );
  }

  return {
    functions: [...functions].sort(sortCodeUnits),
    excludedGlobalVariables: [...excludedGlobalVariables].sort(sortCodeUnits),
    counts: {
      rules,
      ordinaryRules,
      excludedGlobalVariableRules,
      rawAlternatives,
      expandedOccurrences,
      total: functions.size,
      excludedGlobalVariableAlternatives
    }
  };
}

export function getSqlFunctions(sqlGrammar) {
  return getSqlFunctionInventory(sqlGrammar).functions;
}

function buildSqlNameAlternation(names, emptyErrorMessage) {
  const alternatives = [...names]
    .sort((left, right) => right.length - left.length || sortCodeUnits(left, right))
    .map((name) => name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));

  if (alternatives.length === 0) {
    throw new Error(emptyErrorMessage);
  }

  return alternatives.join('|');
}

export function buildSqlKeywordPattern(keywords) {
  const alternatives = buildSqlNameAlternation(
    keywords,
    'Cannot build a SQL keyword pattern without keywords'
  );

  return String.raw`(?:${alternatives})(?![\p{L}\p{M}\p{N}_$])`;
}

export function buildSqlFunctionCallPattern(functions) {
  const alternatives = buildSqlNameAlternation(
    functions,
    'Cannot build a SQL function-call pattern without functions'
  );

  return String.raw`(?:${alternatives})(?![\p{L}\p{M}\p{N}_$])[\t ]*\(`;
}
