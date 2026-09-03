function validateRenderArguments(starterPattern, informationForContributors) {
  if (typeof starterPattern !== 'string' || starterPattern.length === 0) {
    throw new TypeError('starterPattern must be a non-empty string');
  }

  if (!Array.isArray(informationForContributors) || informationForContributors.length === 0) {
    throw new TypeError('informationForContributors must be a non-empty array of strings');
  }

  for (const information of informationForContributors) {
    if (typeof information !== 'string' || information.length === 0) {
      throw new TypeError('informationForContributors must be a non-empty array of strings');
    }
  }
}

export function renderGrammar({ starterPattern, informationForContributors } = {}) {
  validateRenderArguments(starterPattern, informationForContributors);

  const doubleQuotedInlineBegin = String.raw`(")[\t ]*(?=${starterPattern})`;
  const singleQuotedInlineBegin = String.raw`(')[\t ]*(?=${starterPattern})`;
  const leadingNewlinesBegin = String.raw`^[\t ]*(?=${starterPattern})`;

  // String.raw preserves static regex backslashes. JSON.stringify makes each
  // dynamic substitution a complete JSON value, including its own escaping.
  const renderedTemplate = String.raw`{
  "$schema": "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  "name": "PHP SQL Strings",
  "scopeName": "php.sql-strings.injection",
  "injectionSelector": "L:source.php -comment -string",
  "patterns": [
    {
      "include": "#sql-heredoc"
    },
    {
      "include": "#sql-nowdoc"
    },
    {
      "include": "#sql-double-quoted-inline"
    },
    {
      "include": "#sql-single-quoted-inline"
    },
    {
      "include": "#possible-sql-double-quoted-multiline"
    },
    {
      "include": "#possible-sql-single-quoted-multiline"
    }
  ],
  "repository": {
    "sql-heredoc": {
      "comment": "Override VS Code's SQL/DQL heredoc wrapper so its content has the same ancestor scopes as double-quoted SQL while preserving heredoc interpolation.",
      "begin": "(?=<<<[\\t ]*(\"?)([DS]QL)(\\1)[\\t ]*$)",
      "end": "(?!\\G)",
      "name": "string.quoted.double.sql.php",
      "patterns": [
        {
          "include": "#sql-heredoc-content"
        }
      ]
    },
    "sql-heredoc-content": {
      "begin": "(<<<)[\\t ]*(\"?)([DS]QL)(\\2)([\\t ]*)$",
      "beginCaptures": {
        "0": {
          "name": "punctuation.section.embedded.begin.php"
        },
        "1": {
          "name": "punctuation.definition.string.php"
        },
        "3": {
          "name": "keyword.operator.heredoc.php"
        },
        "5": {
          "name": "invalid.illegal.trailing-whitespace.php"
        }
      },
      "contentName": "source.sql.embedded.php",
      "end": "^[\\t ]*(\\3)(?![A-Za-z0-9_\\x{7f}-\\x{10ffff}])",
      "endCaptures": {
        "0": {
          "name": "punctuation.section.embedded.end.php"
        },
        "1": {
          "name": "keyword.operator.heredoc.php"
        }
      },
      "patterns": [
        {
          "include": "source.php#interpolation"
        },
        {
          "include": "source.sql"
        }
      ]
    },
    "sql-nowdoc": {
      "comment": "SQL/DQL nowdoc counterpart. Nowdocs intentionally omit PHP interpolation, matching VS Code's built-in behavior.",
      "begin": "(?=<<<[\\t ]*'([DS]QL)'[\\t ]*$)",
      "end": "(?!\\G)",
      "name": "string.quoted.single.sql.php",
      "patterns": [
        {
          "include": "#sql-nowdoc-content"
        }
      ]
    },
    "sql-nowdoc-content": {
      "begin": "(<<<)[\\t ]*'([DS]QL)'([\\t ]*)$",
      "beginCaptures": {
        "0": {
          "name": "punctuation.section.embedded.begin.php"
        },
        "1": {
          "name": "punctuation.definition.string.php"
        },
        "2": {
          "name": "keyword.operator.nowdoc.php"
        },
        "3": {
          "name": "invalid.illegal.trailing-whitespace.php"
        }
      },
      "contentName": "source.sql.embedded.php",
      "end": "^[\\t ]*(\\2)(?![A-Za-z0-9_\\x{7f}-\\x{10ffff}])",
      "endCaptures": {
        "0": {
          "name": "punctuation.section.embedded.end.php"
        },
        "1": {
          "name": "keyword.operator.nowdoc.php"
        }
      },
      "patterns": [
        {
          "include": "source.sql"
        }
      ]
    },
    "sql-double-quoted-inline": {
      "comment": "Recognizes complete queries and partial fragments that start with a generated SQL keyword or function call, with optional wrapping parentheses.",
      "begin": ${JSON.stringify(doubleQuotedInlineBegin)},
      "beginCaptures": {
        "1": {
          "name": "punctuation.definition.string.begin.php"
        }
      },
      "contentName": "source.sql.embedded.php",
      "end": "\"",
      "endCaptures": {
        "0": {
          "name": "punctuation.definition.string.end.php"
        }
      },
      "name": "string.quoted.double.sql.php",
      "patterns": [
        {
          "include": "#double-quoted-sql-content"
        }
      ]
    },
    "sql-single-quoted-inline": {
      "comment": "Single-quoted counterpart of the extended inline SQL-string rule.",
      "begin": ${JSON.stringify(singleQuotedInlineBegin)},
      "beginCaptures": {
        "1": {
          "name": "punctuation.definition.string.begin.php"
        }
      },
      "contentName": "source.sql.embedded.php",
      "end": "'",
      "endCaptures": {
        "0": {
          "name": "punctuation.definition.string.end.php"
        }
      },
      "name": "string.quoted.single.sql.php",
      "patterns": [
        {
          "include": "#single-quoted-sql-content"
        }
      ]
    },
    "possible-sql-double-quoted-multiline": {
      "comment": "The nameless outer rule carries tokenizer state across blank lines and parenthesis-only prefix lines. Its child assigns the same SQL-string scope used by the inline rule once the first SQL starter is known.",
      "begin": "(\")[\\t ]*((?:\\([\\t ]*)*)(?=$)",
      "beginCaptures": {
        "1": {
          "name": "punctuation.definition.string.begin.php"
        },
        "2": {
          "name": "string.quoted.double.sql.php source.sql.embedded.php"
        }
      },
      "end": "\"",
      "endCaptures": {
        "0": {
          "name": "punctuation.definition.string.end.php"
        }
      },
      "patterns": [
        {
          "include": "#sql-after-leading-newlines-double"
        },
        {
          "include": "#leading-subquery-parentheses-double"
        },
        {
          "include": "#non-sql-double-quoted-content"
        }
      ]
    },
    "possible-sql-single-quoted-multiline": {
      "comment": "Single-quoted counterpart of the nameless pending state.",
      "begin": "(')[\\t ]*((?:\\([\\t ]*)*)(?=$)",
      "beginCaptures": {
        "1": {
          "name": "punctuation.definition.string.begin.php"
        },
        "2": {
          "name": "string.quoted.single.sql.php source.sql.embedded.php"
        }
      },
      "end": "'",
      "endCaptures": {
        "0": {
          "name": "punctuation.definition.string.end.php"
        }
      },
      "patterns": [
        {
          "include": "#sql-after-leading-newlines-single"
        },
        {
          "include": "#leading-subquery-parentheses-single"
        },
        {
          "include": "#non-sql-single-quoted-content"
        }
      ]
    },
    "sql-after-leading-newlines-double": {
      "begin": ${JSON.stringify(leadingNewlinesBegin)},
      "contentName": "source.sql.embedded.php",
      "end": "(?=\")",
      "name": "string.quoted.double.sql.php",
      "patterns": [
        {
          "include": "#double-quoted-sql-content"
        }
      ]
    },
    "sql-after-leading-newlines-single": {
      "begin": ${JSON.stringify(leadingNewlinesBegin)},
      "contentName": "source.sql.embedded.php",
      "end": "(?=')",
      "name": "string.quoted.single.sql.php",
      "patterns": [
        {
          "include": "#single-quoted-sql-content"
        }
      ]
    },
    "leading-subquery-parentheses-double": {
      "comment": "Keep the multiline detector pending when opening parentheses occupy their own line while giving the speculative prefix the scopes it will have if a later SQL starter confirms the string.",
      "match": "^[\\t ]*(?:\\([\\t ]*)+$",
      "name": "string.quoted.double.sql.php source.sql.embedded.php"
    },
    "leading-subquery-parentheses-single": {
      "comment": "Single-quoted counterpart of the speculative SQL parenthesis rule.",
      "match": "^[\\t ]*(?:\\([\\t ]*)+$",
      "name": "string.quoted.single.sql.php source.sql.embedded.php"
    },
    "non-sql-double-quoted-content": {
      "comment": "Once non-whitespace prose appears first, keep the rest of the value a normal PHP string so a later SQL-looking line cannot cause a false positive.",
      "begin": "(?=[^\\s\"])",
      "end": "(?=\")",
      "name": "string.quoted.double.php",
      "patterns": [
        {
          "include": "source.php#interpolation_double_quoted"
        }
      ]
    },
    "non-sql-single-quoted-content": {
      "begin": "(?=[^\\s'])",
      "end": "(?=')",
      "name": "string.quoted.single.php",
      "patterns": [
        {
          "match": "\\\\[\\\\']",
          "name": "constant.character.escape.php"
        }
      ]
    },
    "double-quoted-sql-content": {
      "patterns": [
        {
          "match": "(#)(\\\\\"|[^\"])*(?=\"|$)",
          "name": "comment.line.number-sign.sql",
          "captures": {
            "1": {
              "name": "punctuation.definition.comment.sql"
            }
          }
        },
        {
          "match": "(--)(\\\\\"|[^\"])*(?=\"|$)",
          "name": "comment.line.double-dash.sql",
          "captures": {
            "1": {
              "name": "punctuation.definition.comment.sql"
            }
          }
        },
        {
          "match": "\\\\[\\\\\"\u0060']",
          "name": "constant.character.escape.php"
        },
        {
          "match": "'(?=((\\\\')|[^'\"])*(\"|$))",
          "name": "string.quoted.single.unclosed.sql"
        },
        {
          "match": "\u0060(?=((\\\\\u0060)|[^\u0060\"])*(\"|$))",
          "name": "string.quoted.other.backtick.unclosed.sql"
        },
        {
          "begin": "'",
          "end": "'",
          "name": "string.quoted.single.sql",
          "patterns": [
            {
              "include": "source.php#interpolation_double_quoted"
            }
          ]
        },
        {
          "begin": "\u0060",
          "end": "\u0060",
          "name": "string.quoted.other.backtick.sql",
          "patterns": [
            {
              "include": "source.php#interpolation_double_quoted"
            }
          ]
        },
        {
          "include": "source.php#interpolation_double_quoted"
        },
        {
          "include": "source.sql"
        }
      ]
    },
    "single-quoted-sql-content": {
      "patterns": [
        {
          "match": "(#)(\\\\'|[^'])*(?='|$)",
          "name": "comment.line.number-sign.sql",
          "captures": {
            "1": {
              "name": "punctuation.definition.comment.sql"
            }
          }
        },
        {
          "match": "(--)(\\\\'|[^'])*(?='|$)",
          "name": "comment.line.double-dash.sql",
          "captures": {
            "1": {
              "name": "punctuation.definition.comment.sql"
            }
          }
        },
        {
          "match": "\\\\[\\\\'\u0060\"]",
          "name": "constant.character.escape.php"
        },
        {
          "match": "N(?=')"
        },
        {
          "match": "\u0060(?=((\\\\\u0060)|[^\u0060'])*('|$))",
          "name": "string.quoted.other.backtick.unclosed.sql"
        },
        {
          "match": "\"(?=((\\\\\")|[^\"'])*('|$))",
          "name": "string.quoted.double.unclosed.sql"
        },
        {
          "include": "source.sql"
        }
      ]
    }
  },
  "information_for_contributors": ${JSON.stringify(informationForContributors)}
}`;

  let grammar;
  try {
    grammar = JSON.parse(renderedTemplate);
  } catch (error) {
    throw new Error('Rendered PHP SQL grammar template is invalid JSON', { cause: error });
  }

  if (grammar === null || typeof grammar !== 'object' || Array.isArray(grammar)) {
    throw new Error('Rendered PHP SQL grammar template must contain a JSON object');
  }

  return `${JSON.stringify(grammar, null, 2)}\n`;
}
