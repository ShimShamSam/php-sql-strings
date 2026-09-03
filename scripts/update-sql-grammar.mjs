import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getSqlFunctionInventory,
  getSqlKeywordInventory
} from './sql-keywords.mjs';

const VSCODE_MSSQL_REPOSITORY = 'microsoft/vscode-mssql';
const VSCODE_MSSQL_SQL_GRAMMAR_PATH = 'extensions/mssql/syntaxes/SQL.plist';
export const VSCODE_MSSQL_SQL_GRAMMAR_URL =
  `https://raw.githubusercontent.com/${VSCODE_MSSQL_REPOSITORY}/main/${VSCODE_MSSQL_SQL_GRAMMAR_PATH}`;
export const VSCODE_MSSQL_SQL_GRAMMAR_SOURCE_URL =
  `https://github.com/${VSCODE_MSSQL_REPOSITORY}/blob/main/${VSCODE_MSSQL_SQL_GRAMMAR_PATH}`;

const REQUEST_TIMEOUT_MS = 30_000;
const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultFixturePath = join(projectDirectory, 'test', 'fixtures', 'sql.tmLanguage.json');

const contributorInformation = [
  `This file has been converted from ${VSCODE_MSSQL_SQL_GRAMMAR_SOURCE_URL}`,
  'If you want to provide a fix or improvement, please create a pull request against the original repository.',
  'Once accepted there, we are happy to receive an update request.'
];

function decodeXmlText(encodedText) {
  let decodedText = '';
  let previousIndex = 0;

  for (const match of encodedText.matchAll(/&([^;]+);/g)) {
    const precedingText = encodedText.slice(previousIndex, match.index);
    if (precedingText.includes('&')) {
      throw new Error('Malformed XML entity in plist text');
    }

    decodedText += precedingText;
    const entity = match[1];
    switch (entity) {
      case 'amp':
        decodedText += '&';
        break;
      case 'apos':
        decodedText += "'";
        break;
      case 'gt':
        decodedText += '>';
        break;
      case 'lt':
        decodedText += '<';
        break;
      case 'quot':
        decodedText += '"';
        break;
      default: {
        const decimal = /^#([0-9]+)$/.exec(entity);
        const hexadecimal = /^#x([0-9a-f]+)$/i.exec(entity);
        const codePointText = decimal?.[1] ?? hexadecimal?.[1];
        if (codePointText === undefined) {
          throw new Error(`Unsupported XML entity &${entity}; in plist text`);
        }

        const radix = decimal ? 10 : 16;
        const codePoint = Number.parseInt(codePointText, radix);
        try {
          decodedText += String.fromCodePoint(codePoint);
        } catch {
          throw new Error(`Invalid XML character reference &${entity}; in plist text`);
        }
      }
    }

    previousIndex = match.index + match[0].length;
  }

  const remainingText = encodedText.slice(previousIndex);
  if (remainingText.includes('&')) {
    throw new Error('Malformed XML entity in plist text');
  }

  return decodedText + remainingText;
}

function stripXmlPreamble(xml) {
  return xml
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[\s\S]*?\?>/, '')
    .replace(/^\s*<!DOCTYPE[\s\S]*?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/**
 * Parse the deliberately small Apple plist subset used by vscode-mssql's SQL
 * TextMate grammar. Unsupported value types fail loudly if upstream changes.
 */
export function parsePlist(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new Error('Cannot parse an empty plist');
  }

  const source = stripXmlPreamble(xml);
  let index = 0;

  function skipWhitespace() {
    const whitespace = /^\s+/.exec(source.slice(index));
    if (whitespace) {
      index += whitespace[0].length;
    }
  }

  function consume(pattern, description) {
    skipWhitespace();
    const match = pattern.exec(source.slice(index));
    if (!match) {
      throw new Error(`Expected ${description} at plist offset ${index}`);
    }
    index += match[0].length;
  }

  function atClosingTag(name) {
    skipWhitespace();
    return new RegExp(`^<\\/${name}\\s*>`).test(source.slice(index));
  }

  function readTextElement(name) {
    consume(new RegExp(`^<${name}\\s*>`), `<${name}>`);
    const closingTag = `</${name}>`;
    const closingIndex = source.indexOf(closingTag, index);
    if (closingIndex === -1) {
      throw new Error(`Missing ${closingTag} in plist`);
    }

    const encodedText = source.slice(index, closingIndex);
    if (encodedText.includes('<')) {
      throw new Error(`Unexpected nested markup inside <${name}>`);
    }

    index = closingIndex + closingTag.length;
    return decodeXmlText(encodedText);
  }

  function readValue() {
    skipWhitespace();
    const remainingSource = source.slice(index);

    if (/^<dict\s*>/.test(remainingSource)) {
      consume(/^<dict\s*>/, '<dict>');
      const value = {};
      while (!atClosingTag('dict')) {
        const key = readTextElement('key');
        if (Object.hasOwn(value, key)) {
          throw new Error(`Duplicate plist dictionary key: ${key}`);
        }
        Object.defineProperty(value, key, {
          configurable: true,
          enumerable: true,
          value: readValue(),
          writable: true
        });
      }
      consume(/^<\/dict\s*>/, '</dict>');
      return value;
    }

    if (/^<array\s*>/.test(remainingSource)) {
      consume(/^<array\s*>/, '<array>');
      const value = [];
      while (!atClosingTag('array')) {
        value.push(readValue());
      }
      consume(/^<\/array\s*>/, '</array>');
      return value;
    }

    if (/^<string\s*>/.test(remainingSource)) {
      return readTextElement('string');
    }

    if (/^<integer\s*>/.test(remainingSource)) {
      const encodedInteger = readTextElement('integer').trim();
      if (!/^-?\d+$/.test(encodedInteger)) {
        throw new Error(`Invalid plist integer: ${encodedInteger}`);
      }
      const value = Number(encodedInteger);
      if (!Number.isSafeInteger(value)) {
        throw new Error(`Plist integer is outside JavaScript's safe range: ${encodedInteger}`);
      }
      return value;
    }

    const tag = /^<\/?([A-Za-z][A-Za-z0-9_-]*)/.exec(remainingSource)?.[1] ?? 'text';
    throw new Error(`Unsupported plist value type <${tag}> at offset ${index}`);
  }

  consume(/^<plist(?:\s+[^>]*)?>/, '<plist>');
  const value = readValue();
  consume(/^<\/plist\s*>/, '</plist>');
  skipWhitespace();
  if (index !== source.length) {
    throw new Error(`Unexpected content after </plist> at offset ${index}`);
  }

  return value;
}

function validateSqlGrammar(grammar) {
  if (grammar?.name !== 'SQL') {
    throw new Error(`Expected the upstream grammar name to be SQL; received ${grammar?.name ?? 'nothing'}`);
  }
  if (grammar.scopeName !== 'source.sql') {
    throw new Error(
      `Expected the upstream grammar scopeName to be source.sql; received ${grammar.scopeName ?? 'nothing'}`
    );
  }
  if (!Array.isArray(grammar.patterns) || grammar.patterns.length === 0) {
    throw new Error('Expected the upstream SQL grammar to contain patterns');
  }

  let keywordInventory;
  let functionInventory;
  try {
    keywordInventory = getSqlKeywordInventory(grammar);
    functionInventory = getSqlFunctionInventory(grammar);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The upstream SQL grammar is incompatible with the starter generator: ${detail}`, {
      cause: error
    });
  }

  if (keywordInventory.counts.broad < 900) {
    throw new Error(
      `The upstream SQL grammar yielded only ${keywordInventory.counts.broad} broad keywords; expected at least 900`
    );
  }
  if (keywordInventory.vscodeKeywords.length < 950) {
    throw new Error(
      `The upstream SQL grammar yielded only ${keywordInventory.vscodeKeywords.length} total keywords; expected at least 950`
    );
  }
  if (functionInventory.functions.length < 250) {
    throw new Error(
      `The upstream SQL grammar yielded only ${functionInventory.functions.length} functions; expected at least 250`
    );
  }

  const keywordSet = new Set(keywordInventory.keywords);
  for (const keyword of ['CASE', 'SELECT', 'WHERE', 'WITH']) {
    if (!keywordSet.has(keyword)) {
      throw new Error(`The upstream SQL grammar is missing the expected ${keyword} keyword`);
    }
  }

  const functionSet = new Set(functionInventory.functions);
  for (const functionName of ['COALESCE', 'COUNT', 'ROW_NUMBER']) {
    if (!functionSet.has(functionName)) {
      throw new Error(`The upstream SQL grammar is missing the expected ${functionName} function`);
    }
  }
}

export function createSqlGrammarFixture(plistSource) {
  const grammar = parsePlist(plistSource);
  validateSqlGrammar(grammar);

  if (Object.hasOwn(grammar, 'information_for_contributors') || Object.hasOwn(grammar, 'version')) {
    throw new Error('The upstream plist unexpectedly defines generated provenance fields');
  }

  // These TextMate bundle fields are intentionally omitted by VS Code's own
  // converted grammar and are not part of the grammar consumed by this project.
  const omittedBundleFields = new Set(['fileTypes', 'keyEquivalent', 'uuid']);
  const convertedGrammar = Object.fromEntries(
    Object.entries(grammar).filter(([key]) => !omittedBundleFields.has(key))
  );

  return {
    information_for_contributors: contributorInformation,
    version: VSCODE_MSSQL_SQL_GRAMMAR_SOURCE_URL,
    ...convertedGrammar
  };
}

async function fetchText(url, fetchImplementation) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  let response;
  let responseText;
  try {
    response = await fetchImplementation(url, {
      headers: { 'User-Agent': 'php-sql-strings-build' },
      signal: abortController.signal
    });
    responseText = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fetch ${url}: ${detail}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = responseText.trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(
      `GitHub returned ${response.status} ${response.statusText} for ${url}`
        + (detail ? `: ${detail}` : '')
    );
  }

  return responseText;
}

export async function fetchSqlGrammarFixture({ fetchImplementation = globalThis.fetch } = {}) {
  if (typeof fetchImplementation !== 'function') {
    throw new Error('This build requires Node.js 18 or newer so it can fetch the upstream grammar');
  }
  const plistSource = await fetchText(VSCODE_MSSQL_SQL_GRAMMAR_URL, fetchImplementation);
  return createSqlGrammarFixture(plistSource);
}

export async function updateSqlGrammar({
  destinationPath = defaultFixturePath,
  fetchImplementation = globalThis.fetch
} = {}) {
  const fixture = await fetchSqlGrammarFixture({ fetchImplementation });
  const serializedFixture = `${JSON.stringify(fixture, null, 2)}\n`;
  let existingFixture = null;
  try {
    existingFixture = await readFile(destinationPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const changed = existingFixture !== serializedFixture;
  if (changed) {
    await mkdir(dirname(destinationPath), { recursive: true });
    const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serializedFixture, 'utf8');
      await rename(temporaryPath, destinationPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  return { changed, destinationPath };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const result = await updateSqlGrammar();
    const action = result.changed ? 'Updated' : 'Already current:';
    console.log(`${action} ${result.destinationPath}`);
    console.log(`vscode-mssql SQL grammar: ${VSCODE_MSSQL_SQL_GRAMMAR_URL}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
