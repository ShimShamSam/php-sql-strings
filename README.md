# PHP SQL Strings

Better syntax highlighting for SQL statements, fragments, subqueries, and expressions inside PHP strings.

PHP SQL Strings extends VS Code's built-in PHP highlighting so embedded SQL remains easy to scan and edit, including complete statements, query fragments, subqueries, and standalone expressions.

## Features

- Highlights complete SQL statements.
- Highlights query fragments such as `WHERE`, `CASE`, `JOIN`, `ORDER BY`, and `RETURNING`.
- Highlights standalone SQL function expressions such as `ROW_NUMBER() OVER (...)`, `COUNT(...)`, and `COALESCE(...)`.
- Uses more lenient leading-whitespace detection, including blank lines and indentation before a recognized SQL keyword or function.
- Supports wrapping parentheses for subqueries and expression fragments, including parentheses placed before the first recognized SQL token or on their own lines.
- Makes `SQL` and `DQL` heredocs/nowdocs styling match their string counterparts.
- Recognizes a broad set of keywords and built-in functions from VS Code's SQL grammar, plus common SQL dialect keywords.

## Examples

```php
<?php

$query = "
	SELECT
		id,
		email
	FROM
		users
";

$subquery = "
	(
		WITH
			active AS (
				SELECT
					id
				FROM
					users
			)

		SELECT * FROM active
	)
";

$case = "
	CASE
		WHEN paid < total
		THEN 'Unpaid'

		ELSE 'Paid'
	END
";

$join = "
	LEFT JOIN
		accounts ON TRUE
		AND accounts.id = users.account_id
		AND accounts.deleted IS NULL
";

$where     = "WHERE status = 'active'";
$ordering  = "(ORDER BY created_at DESC)";
$ranking   = "ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at)";
$aggregate = "COUNT(DISTINCT user_id)";
$distinct  = "DISTINCT user_id";
```

## Detection

To avoid treating every PHP string as SQL, detection skips leading whitespace and wrapping opening parentheses, then requires either a recognized uppercase SQL keyword or a recognized uppercase SQL function name followed by `(`. Once detected, the rest of the string is highlighted using VS Code's SQL grammar.

The heredoc override supports uppercase `SQL`, `"SQL"`, `DQL`, and `"DQL"` labels; nowdocs support `'SQL'` and `'DQL'`.

## Development

Install the test dependencies and run the grammar regression suite:

```shell
npm install
npm test
```

Refresh the SQL keyword/function source from
[`microsoft/vscode-mssql`](https://github.com/microsoft/vscode-mssql) and regenerate the detector:

```shell
npm run build
```

The networked update downloads
`extensions/mssql/syntaxes/SQL.plist` directly from vscode-mssql's `main` branch,
validates it, and writes the converted grammar fixture to `test/fixtures`. The
checked-in fixture keeps grammar-only builds and tests offline; refreshing it
intentionally follows the latest upstream `main` content.

Use `npm run update:sql-grammar` to refresh only the fixture, or
`npm run build:grammar` to regenerate from the checked-in fixture without a
network request. The editable injection grammar is the `String.raw` template in
`scripts/grammar-template.mjs`; the JSON file under `syntaxes/` is generated and
should not be edited directly.
