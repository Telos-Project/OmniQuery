/*

	OmniQuery engine.

	Consumes the context object emitted by the OQL Fusion-LISP dialect (oql.js):

		{
			access:    { url: "...", options: { ... } },
			operation: { type: "read"|"create"|"update"|"delete"|"properties",
			             data: [ { ... }, ... ] },
			filters:   [ { type: "...", options: { value: ... } }, ... ]
		}

	Filter types produced by oql.js and handled here:

		at      -> table / (db, collection) addressing.        value: string|number
		focus   -> projected columns (SELECT list).            value: [ "col", ... ]
		filter  -> WHERE clause. value is a RAW LISP list,      value: [ "equals", "age", 30 ]
		           e.g. ["and", ["gte","age",18], ...].         (operands classified below)
		crop    -> LIMIT / OFFSET.                              value: [ limit ] | [ limit, offset ]
		sort    -> ORDER BY.                                    value: { col: bool } | [ [col, bool] ]
		merge / merge-inner / merge-lateral -> JOIN.           value: [ rightContext, rawJoinConditionList ]

	Security model:

		- Every *value* is bound as a driver parameter, never string-interpolated.
		- Every *identifier* (table/column) is validated against a strict regex and
		  quoted with the dialect's identifier quoting. Anything that fails validation
		  throws before a query is built.
		- filter / join-condition operands are classified: a token that JSON-parses to a
		  number/boolean/string/null is a literal (-> bound parameter); anything else is
		  an identifier (-> validated + quoted). This mirrors OQL's own quoted-literal vs
		  bare-atom convention and the resolver's data-vs-operator split.

	Backends: mongo, postgres, mysql, mariadb, oracle, mssql, sqlite. JSON is a STUB.

 */

// ---------------------------------------------------------------------------
// Driver loading (lazy: a missing Oracle driver must not break a Postgres user)
// ---------------------------------------------------------------------------

var driverCache = {};

function loadDriver(name) {

	if(driverCache[name] != null)
		return driverCache[name];

	try {
		return driverCache[name] = require(name);
	}

	catch(error) {

		throw new Error(
			`OmniQuery: backend driver '${name}' is required but not installed. ` +
			`Install it with: npm install ${name.split("/")[0]}`
		);
	}
}

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

function makeQuoteId(openChar, closeChar) {

	return (name) =>
		String(name).split(".").map(part => {

			if(!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))
				throw new Error(`OmniQuery: invalid identifier '${part}'.`);

			return openChar +
				part.split(closeChar).join(closeChar + closeChar) +
				closeChar;
		}).join(".");
}

// CREATE TABLE existence-guard differs by dialect. Standard dialects support
// IF NOT EXISTS directly; Oracle and SQL Server do not and need a guard.
var createIfNotExists = (t, defs) =>
	`CREATE TABLE IF NOT EXISTS ${t} (${defs})`;

var dialects = {
	postgres: {
		name: "postgres",
		quoteId: makeQuoteId('"', '"'),
		param: (i) => `$${i}`,
		limitStyle: "limit",
		fullOuter: true,
		requiresOrderForPaging: false,
		types: { string: "TEXT", number: "DOUBLE PRECISION", boolean: "BOOLEAN" },
		encodeParam: (v) => v === undefined ? null : v,
		createTable: createIfNotExists
	},
	mysql: {
		name: "mysql",
		quoteId: makeQuoteId("`", "`"),
		param: () => "?",
		limitStyle: "limit",
		fullOuter: false, // emulated via LEFT UNION RIGHT
		requiresOrderForPaging: false,
		types: { string: "TEXT", number: "DOUBLE", boolean: "TINYINT(1)" },
		encodeParam: (v) =>
			v === undefined ? null : (typeof v === "boolean" ? (v ? 1 : 0) : v),
		createTable: createIfNotExists
	},
	sqlite: {
		name: "sqlite",
		quoteId: makeQuoteId('"', '"'),
		param: () => "?",
		limitStyle: "limit",
		fullOuter: true, // SQLite >= 3.39
		requiresOrderForPaging: false,
		types: { string: "TEXT", number: "REAL", boolean: "INTEGER" },
		encodeParam: (v) =>
			v === undefined ? null : (typeof v === "boolean" ? (v ? 1 : 0) : v),
		createTable: createIfNotExists
	},
	oracle: {
		name: "oracle",
		quoteId: makeQuoteId('"', '"'),
		param: (i) => `:${i}`,
		limitStyle: "fetch",
		fullOuter: true,
		requiresOrderForPaging: false,
		types: { string: "VARCHAR2(4000)", number: "NUMBER", boolean: "NUMBER(1)" },
		encodeParam: (v) =>
			v === undefined ? null : (typeof v === "boolean" ? (v ? 1 : 0) : v),
		// ORA-00955 = "name already used by an existing object" -> swallow it.
		createTable: (t, defs) =>
			`BEGIN EXECUTE IMMEDIATE 'CREATE TABLE ${t} (${defs})'; ` +
			`EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END;`
	},
	mssql: {
		name: "mssql",
		quoteId: makeQuoteId("[", "]"),
		param: (i) => `@p${i}`,
		limitStyle: "fetch",
		fullOuter: true,
		requiresOrderForPaging: true, // OFFSET/FETCH needs ORDER BY
		types: { string: "NVARCHAR(MAX)", number: "FLOAT", boolean: "BIT" },
		encodeParam: (v) => v === undefined ? null : v,
		createTable: (t, defs, raw) =>
			`IF OBJECT_ID(N'${raw}', N'U') IS NULL CREATE TABLE ${t} (${defs})`
	}
};

dialects.mariadb = Object.assign({}, dialects.mysql, { name: "mariadb" });

// ---------------------------------------------------------------------------
// SQL construction utilities
// ---------------------------------------------------------------------------

function getFilterTypes(filters) {

	let types = {};

	(filters || []).forEach(item => {

		let type = String(item.type).toLowerCase().trim();

		types[type] = types[type] != null ? types[type] : [];
		types[type].push(item.options);
	});

	return types;
}

// Ordered parameter collector. add(value) records the value and returns the
// dialect placeholder for its position, guaranteeing text/params alignment.
function makeParams(dialect) {

	let values = [];

	return {
		add: (v) => {
			values.push(dialect.encodeParam(v));
			return dialect.param(values.length);
		},
		values: () => values
	};
}

// Classify a filter operand as literal (bound value) or identifier (column).
function classifyOperand(x) {

	if(x === null || x === undefined)
		return { literal: true, value: null };

	if(typeof x === "number" || typeof x === "boolean")
		return { literal: true, value: x };

	if(typeof x === "string") {

		try {

			let parsed = JSON.parse(x);

			if(parsed === null ||
				typeof parsed === "number" ||
				typeof parsed === "boolean" ||
				typeof parsed === "string"
			)
				return { literal: true, value: parsed };
		}

		catch(error) { /* not JSON -> identifier */ }

		return { literal: false, name: x };
	}

	return { literal: true, value: x };
}

var SQL_COMPARATORS = {
	equals: "=", less: "<", greater: ">", gte: ">=", lte: "<="
};

// Build a boolean expression (WHERE clause / JOIN condition) from a raw LISP list.
function buildCondition(expr, dialect, params) {

	if(!Array.isArray(expr))
		throw new Error("OmniQuery: filter expression must be a list.");

	let op = String(expr[0]).toLowerCase().trim();

	let operand = (x) => {

		if(Array.isArray(x))
			return "(" + buildCondition(x, dialect, params) + ")";

		let c = classifyOperand(x);

		return c.literal ? params.add(c.value) : dialect.quoteId(c.name);
	};

	if(op === "and" || op === "or") {

		let joiner = op === "and" ? " AND " : " OR ";

		return expr.slice(1)
			.map(child => "(" + buildCondition(child, dialect, params) + ")")
			.join(joiner);
	}

	if(op === "not") {

		return expr.slice(1)
			.map(child => "NOT (" + buildCondition(child, dialect, params) + ")")
			.join(" AND ");
	}

	if(SQL_COMPARATORS[op] != null) {

		let sqlOp = SQL_COMPARATORS[op];
		let parts = [];

		for(let i = 1; i < expr.length - 1; i++)
			parts.push(`${operand(expr[i])} ${sqlOp} ${operand(expr[i + 1])}`);

		return parts.length > 0 ? parts.join(" AND ") : "1 = 1";
	}

	throw new Error(`OmniQuery: unsupported filter operator '${op}'.`);
}

function qualifiedTable(types, dialect) {

	let at = types["at"] || [];

	if(at.length === 0)
		throw new Error("OmniQuery: no table specified (missing 'at').");

	return at.map(a => dialect.quoteId(a.value)).join(".");
}

function toNonNegativeInt(x, label) {

	let n = Number(x);

	if(!Number.isInteger(n) || n < 0)
		throw new Error(`OmniQuery: ${label} must be a non-negative integer.`);

	return n; // safe to inline: validated integer, never user text
}

function buildOrderBy(types, dialect) {

	if(types["sort"] == null)
		return "";

	let spec = types["sort"][0].value;
	let pairs = [];

	let pushPair = (key, asc) =>
		pairs.push(`${dialect.quoteId(key)} ${(
			asc === false || asc === "false" ? "DESC" : "ASC"
		)}`);

	if(Array.isArray(spec))
		spec.forEach(item => {

			if(Array.isArray(item))
				pushPair(item[0], item[1]);

			else if(item != null && typeof item === "object")
				Object.entries(item).forEach(([k, v]) => pushPair(k, v));
		});

	else if(spec != null && typeof spec === "object")
		Object.entries(spec).forEach(([k, v]) => pushPair(k, v));

	return pairs.length > 0 ? ` ORDER BY ${pairs.join(", ")}` : "";
}

function buildLimit(types, dialect) {

	if(types["crop"] == null)
		return "";

	let raw = types["crop"][0].value;
	let arr = Array.isArray(raw) ? raw : [raw];

	let limit = toNonNegativeInt(arr[0], "crop length");
	let offset = arr.length > 1 ? toNonNegativeInt(arr[1], "crop offset") : null;

	if(dialect.limitStyle === "limit")
		return ` LIMIT ${limit}${offset != null ? ` OFFSET ${offset}` : ""}`;

	// fetch style (oracle, mssql)
	return ` OFFSET ${offset != null ? offset : 0} ROWS` +
		` FETCH NEXT ${limit} ROWS ONLY`;
}

function joinKeyword(mergeType, dialect) {

	let t = String(mergeType).toLowerCase().trim();

	if(t === "merge-inner")   return { kw: "INNER JOIN", emulateFull: false };
	if(t === "merge-lateral") return { kw: "LEFT OUTER JOIN", emulateFull: false };

	// "merge" -> full outer join
	return dialect.fullOuter ?
		{ kw: "FULL OUTER JOIN", emulateFull: false } :
		{ kw: "LEFT OUTER JOIN", emulateFull: true };
}

function renderSelect(data, dialect, opts) {

	opts = opts || {};

	let types = getFilterTypes(data.filters);
	let params = makeParams(dialect);
	let table = qualifiedTable(types, dialect);

	let cols = types["focus"] != null ?
		types["focus"][0].value.map(c => dialect.quoteId(c)).join(", ") :
		"*";

	let joinSQL = "";

	(data.filters || [])
		.filter(f => ["merge", "merge-inner", "merge-lateral"]
			.includes(String(f.type).toLowerCase().trim()))
		.forEach(m => {

			let rightCtx = m.options.value[0] || {};
			let condition = m.options.value[1];
			let rightTypes = getFilterTypes(rightCtx.filters || []);
			let rightTable = qualifiedTable(rightTypes, dialect);

			let kw = opts.forceJoin != null ?
				opts.forceJoin :
				joinKeyword(m.type, dialect).kw;

			joinSQL += ` ${kw} ${rightTable} ON ` +
				buildCondition(condition, dialect, params);
		});

	let where = "";

	if(types["filter"] != null)
		where = " WHERE " + types["filter"]
			.map(f => buildCondition(f.value, dialect, params))
			.join(" AND ");

	let order = buildOrderBy(types, dialect);
	let limit = buildLimit(types, dialect);

	// OFFSET/FETCH paging requires an ORDER BY on SQL Server.
	if(limit !== "" && order === "" && dialect.requiresOrderForPaging)
		order = " ORDER BY (SELECT NULL)";

	return {
		text: `SELECT ${cols} FROM ${table}${joinSQL}${where}${order}${limit}`,
		params: params.values()
	};
}

function buildSelect(data, dialect) {

	let merges = (data.filters || [])
		.filter(f => ["merge", "merge-inner", "merge-lateral"]
			.includes(String(f.type).toLowerCase().trim()));

	let needsEmulation = merges.some(m => joinKeyword(m.type, dialect).emulateFull);

	if(needsEmulation) {

		if(merges.length > 1)
			throw new Error(
				"OmniQuery: FULL OUTER JOIN emulation on MySQL/MariaDB " +
				"supports only a single merge."
			);

		// FULL OUTER == (LEFT JOIN) UNION (RIGHT JOIN)
		let left = renderSelect(data, dialect, { forceJoin: "LEFT OUTER JOIN" });
		let right = renderSelect(data, dialect, { forceJoin: "RIGHT OUTER JOIN" });

		return {
			statements: [{
				text: `(${left.text}) UNION (${right.text})`,
				params: left.params.concat(right.params)
			}],
			returns: "rows"
		};
	}

	let r = renderSelect(data, dialect, {});

	return { statements: [{ text: r.text, params: r.params }], returns: "rows" };
}

function inferColumnType(rows, column, dialect) {

	for(let row of rows)
		if(row[column] != null)
			return dialect.types[typeof row[column]] || dialect.types.string;

	return dialect.types.string;
}

function buildInsert(data, dialect) {

	let types = getFilterTypes(data.filters);
	let table = qualifiedTable(types, dialect);

	let rows = data.operation.data;

	if(Array.isArray(rows[0]) && rows.length === 1)
		rows = rows[0];

	if(rows.length === 0)
		throw new Error("OmniQuery: append/create requires at least one row.");

	let columns = [...new Set(rows.flatMap(r => Object.keys(r)))];

	let rawTable = (types["at"] || []).map(a => a.value).join(".");

	let createText = dialect.createTable(
		table,
		columns.map(c =>
			`${dialect.quoteId(c)} ${inferColumnType(rows, c, dialect)}`
		).join(", "),
		rawTable
	);

	let quotedColumns = columns.map(c => dialect.quoteId(c)).join(", ");

	// Oracle has no multi-row VALUES list; the driver uses executeMany instead.
	if(dialect.name === "oracle") {

		let placeholders = columns.map((c, i) => `:${i + 1}`).join(", ");

		return {
			statements: [
				{ text: createText, params: [] },
				{
					text: `INSERT INTO ${table} (${quotedColumns}) ` +
						`VALUES (${placeholders})`,
					manyBinds: rows.map(r =>
						columns.map(c =>
							dialect.encodeParam(r[c] !== undefined ? r[c] : null)
						)
					)
				}
			],
			returns: "none"
		};
	}

	let params = makeParams(dialect);

	let valuesSQL = rows.map(r =>
		`(${columns.map(c => params.add(r[c] !== undefined ? r[c] : null)).join(", ")})`
	).join(", ");

	return {
		statements: [
			{ text: createText, params: [] },
			{
				text: `INSERT INTO ${table} (${quotedColumns}) VALUES ${valuesSQL}`,
				params: params.values()
			}
		],
		returns: "none"
	};
}

function buildUpdate(data, dialect) {

	let types = getFilterTypes(data.filters);
	let table = qualifiedTable(types, dialect);
	let params = makeParams(dialect);

	let values = Array.isArray(data.operation.data) ?
		data.operation.data[0] : data.operation.data;

	if(values == null || typeof values !== "object")
		throw new Error("OmniQuery: update requires an object of column values.");

	let assignments = Object.keys(values)
		.map(c => `${dialect.quoteId(c)} = ${params.add(values[c])}`)
		.join(", ");

	// No filter -> update ALL rows (NOT drop-and-recreate as in the original).
	let where = types["filter"] != null ?
		" WHERE " + types["filter"]
			.map(f => buildCondition(f.value, dialect, params))
			.join(" AND ") :
		"";

	return {
		statements: [{
			text: `UPDATE ${table} SET ${assignments}${where}`,
			params: params.values()
		}],
		returns: "none"
	};
}

function buildDelete(data, dialect) {

	let types = getFilterTypes(data.filters);
	let table = qualifiedTable(types, dialect);
	let params = makeParams(dialect);

	// No filter -> delete ALL rows (NOT drop table as in the original).
	let where = types["filter"] != null ?
		" WHERE " + types["filter"]
			.map(f => buildCondition(f.value, dialect, params))
			.join(" AND ") :
		"";

	return {
		statements: [{
			text: `DELETE FROM ${table}${where}`,
			params: params.values()
		}],
		returns: "none"
	};
}

function buildProperties(data, dialect) {

	let types = getFilterTypes(data.filters);
	let table = qualifiedTable(types, dialect);
	let params = makeParams(dialect);

	let where = types["filter"] != null ?
		" WHERE " + types["filter"]
			.map(f => buildCondition(f.value, dialect, params))
			.join(" AND ") :
		"";

	return {
		statements: [{
			text: `SELECT COUNT(*) AS ${dialect.quoteId("count")} FROM ${table}${where}`,
			params: params.values()
		}],
		returns: "rows"
	};
}

function buildStatements(data, dialect) {

	if(typeof dialect === "string")
		dialect = dialects[dialect];

	if(dialect == null)
		throw new Error("OmniQuery: unknown SQL dialect.");

	switch(String(data.operation.type).toLowerCase().trim()) {

		case "read":       return buildSelect(data, dialect);
		case "create":     return buildInsert(data, dialect);
		case "update":     return buildUpdate(data, dialect);
		case "delete":     return buildDelete(data, dialect);
		case "properties": return buildProperties(data, dialect);

		default:
			throw new Error(
				`OmniQuery: unsupported operation '${data.operation.type}'.`
			);
	}
}

// ---------------------------------------------------------------------------
// Mongo translation
// ---------------------------------------------------------------------------

var MONGO_COMPARATORS = {
	equals: "$eq", less: "$lt", greater: "$gt", gte: "$gte", lte: "$lte"
};

function buildMongoCondition(expr) {

	if(!Array.isArray(expr))
		throw new Error("OmniQuery: filter expression must be a list.");

	let op = String(expr[0]).toLowerCase().trim();

	if(op === "and") return { $and: expr.slice(1).map(buildMongoCondition) };
	if(op === "or")  return { $or:  expr.slice(1).map(buildMongoCondition) };
	if(op === "not") return { $nor: expr.slice(1).map(buildMongoCondition) };

	if(MONGO_COMPARATORS[op] != null) {

		let conditions = [];

		for(let i = 1; i < expr.length - 1; i++) {

			let left = classifyOperand(expr[i]);
			let right = classifyOperand(expr[i + 1]);

			// field <op> literal -> { field: { $op: value } }
			if(!left.literal && right.literal)
				conditions.push({
					[left.name]: { [MONGO_COMPARATORS[op]]: right.value }
				});

			// field <op> field (or literal on the left) -> $expr comparison
			else
				conditions.push({
					$expr: {
						[MONGO_COMPARATORS[op]]: [
							left.literal ? left.value : `$${left.name}`,
							right.literal ? right.value : `$${right.name}`
						]
					}
				});
		}

		return conditions.length === 1 ? conditions[0] : { $and: conditions };
	}

	throw new Error(`OmniQuery: unsupported filter operator '${op}'.`);
}

function buildMongoFilter(types) {

	if(types["filter"] == null)
		return {};

	let conditions = types["filter"].map(f => buildMongoCondition(f.value));

	return conditions.length === 0 ? {} :
		conditions.length === 1 ? conditions[0] : { $and: conditions };
}

function buildMongoSort(types) {

	if(types["sort"] == null)
		return null;

	let spec = types["sort"][0].value;
	let out = {};

	let put = (k, asc) => { out[k] = (asc === false || asc === "false") ? -1 : 1; };

	if(Array.isArray(spec))
		spec.forEach(item => {
			if(Array.isArray(item)) put(item[0], item[1]);
			else if(item != null && typeof item === "object")
				Object.entries(item).forEach(([k, v]) => put(k, v));
		});

	else if(spec != null && typeof spec === "object")
		Object.entries(spec).forEach(([k, v]) => put(k, v));

	return out;
}

// ---------------------------------------------------------------------------
// Backend runners
// ---------------------------------------------------------------------------

async function runSqlStatements(exec, built) {

	let result = null;

	for(let i = 0; i < built.statements.length; i++) {

		let last = i === built.statements.length - 1;
		let rows = await exec(built.statements[i], last);

		if(last)
			result = rows;
	}

	return result;
}

var omniQuery = {

	dialects: dialects,

	entangle: (source, target, mutual) => {
		// STUB: bidirectional/unidirectional value entanglement (README 2.1.1.3.3).
	},

	intervals: [],

	middleware: [

		{ // MONGO
			match: (data) =>
				data.access.url.startsWith("mongodb://") ||
				data.access.url.startsWith("mongodb+srv://"),

			query: async (data, options) => {

				let { MongoClient } = loadDriver("mongodb");
				let client = new MongoClient(data.access.url, data.access.options || {});
				let types = getFilterTypes(data.filters);

				try {

					await client.connect();

					let at = types["at"] || [];
					let db = client.db(at[0] != null ? at[0].value : undefined);
					let collection = db.collection(at[1].value);

					let operation =
						String(data.operation.type).toLowerCase().trim();

					let filter = buildMongoFilter(types);

					if(operation === "read") {

						let merges = (data.filters || []).filter(f =>
							["merge", "merge-inner", "merge-lateral"]
								.includes(String(f.type).toLowerCase().trim()));

						if(merges.length > 0)
							return await mongoJoin(collection, types, merges);

						let projection = types["focus"] != null ?
							Object.fromEntries(
								types["focus"][0].value.map(c => [c, 1])
							) : undefined;

						let cursor = collection.find(filter, { projection });

						let sort = buildMongoSort(types);
						if(sort != null) cursor = cursor.sort(sort);

						if(types["crop"] != null) {
							let arr = types["crop"][0].value;
							arr = Array.isArray(arr) ? arr : [arr];
							if(arr.length > 1) cursor = cursor.skip(Number(arr[1]));
							cursor = cursor.limit(Number(arr[0]));
						}

						return await cursor.toArray();
					}

					if(operation === "create") {

						let rows = data.operation.data;
						if(Array.isArray(rows[0]) && rows.length === 1) rows = rows[0];

						return await collection.insertMany(rows);
					}

					if(operation === "update") {

						let values = Array.isArray(data.operation.data) ?
							data.operation.data[0] : data.operation.data;

						return await collection.updateMany(filter, { $set: values });
					}

					if(operation === "delete")
						return await collection.deleteMany(filter);

					if(operation === "properties")
						return [{ count: await collection.countDocuments(filter) }];

					throw new Error(
						`OmniQuery: unsupported operation '${operation}'.`
					);
				}

				finally {
					await client.close();
				}
			}
		},

		{ // POSTGRES
			match: (data) =>
				data.access.url.startsWith("postgres://") ||
				data.access.url.startsWith("postgresql://"),

			query: async (data, options) => {

				let pg = loadDriver("pg");
				let client = new pg.Client(Object.assign(
					{ connectionString: data.access.url },
					data.access.options || {}
				));

				await client.connect();

				try {

					let built = buildStatements(data, dialects.postgres);

					return await runSqlStatements(async (st, last) => {
						let r = await client.query(st.text, st.params);
						return last && built.returns === "rows" ? r.rows : null;
					}, built);
				}

				finally {
					await client.end();
				}
			}
		},

		{ // MYSQL / MARIADB (both served by mysql2)
			match: (data) =>
				data.access.url.startsWith("mysql://") ||
				data.access.url.startsWith("mariadb://"),

			query: async (data, options) => {

				let mysql = loadDriver("mysql2/promise");
				let dialect = data.access.url.startsWith("mariadb://") ?
					dialects.mariadb : dialects.mysql;

				let uri = data.access.url.replace(/^mariadb:\/\//, "mysql://");
				let conn = await mysql.createConnection(
					Object.assign({ uri }, data.access.options || {})
				);

				try {

					let built = buildStatements(data, dialect);

					return await runSqlStatements(async (st, last) => {
						let [rows] = await conn.query(st.text, st.params);
						return last && built.returns === "rows" ? rows : null;
					}, built);
				}

				finally {
					await conn.end();
				}
			}
		},

		{ // ORACLE
			match: (data) =>
				data.access.url.startsWith("oracle://") ||
				data.access.url.startsWith("oracledb://"),

			query: async (data, options) => {

				let oracledb = loadDriver("oracledb");
				let parsed = new URL(data.access.url);

				let conn = await oracledb.getConnection(Object.assign({
					user: decodeURIComponent(parsed.username),
					password: decodeURIComponent(parsed.password),
					connectString: `${parsed.hostname}:${
						parsed.port || 1521
					}/${parsed.pathname.replace(/^\//, "")}`
				}, data.access.options || {}));

				try {

					let built = buildStatements(data, dialects.oracle);

					return await runSqlStatements(async (st, last) => {

						if(st.manyBinds != null) {
							await conn.executeMany(st.text, st.manyBinds, {
								autoCommit: true
							});
							return null;
						}

						let r = await conn.execute(st.text, st.params || [], {
							autoCommit: true,
							outFormat: oracledb.OUT_FORMAT_OBJECT
						});

						return last && built.returns === "rows" ? r.rows : null;
					}, built);
				}

				finally {
					await conn.close();
				}
			}
		},

		{ // MICROSOFT SQL SERVER
			match: (data) =>
				data.access.url.startsWith("mssql://") ||
				data.access.url.startsWith("sqlserver://"),

			query: async (data, options) => {

				let sql = loadDriver("mssql");
				let pool = await new sql.ConnectionPool(
					data.access.options || data.access.url
				).connect();

				try {

					let built = buildStatements(data, dialects.mssql);

					return await runSqlStatements(async (st, last) => {

						let request = pool.request();

						(st.params || []).forEach((v, i) =>
							request.input(`p${i + 1}`, v));

						let r = await request.query(st.text);

						return last && built.returns === "rows" ?
							r.recordset : null;
					}, built);
				}

				finally {
					await pool.close();
				}
			}
		},

		{ // STUB: JSON - READ / WRITE -- HTTP
			match: (data) => false,
			query: (data, options) => {
				// STUB
			}
		},

		{ // SQLITE (catch-all: bare file paths and sqlite: URLs)
			match: (data) =>
				data.access.url.startsWith("sqlite:") ||
				!data.access.url.includes("://"),

			query: async (data, options) => {

				options = options || {};

				let path = data.access.url
					.replace(/^sqlite:\/\//, "")
					.replace(/^sqlite:/, "");

				let built = buildStatements(data, dialects.sqlite);

				if(options.sync) { // better-sqlite3

					let Database = loadDriver("better-sqlite3");
					let db = new Database(path);

					try {

						return await runSqlStatements(async (st, last) => {

							let stmt = db.prepare(st.text);

							if(last && built.returns === "rows")
								return stmt.all(...(st.params || []));

							stmt.run(...(st.params || []));
							return null;
						}, built);
					}

					finally {
						db.close();
					}
				}

				// node sqlite3 (async)
				let sqlite3 = loadDriver("sqlite3").verbose();
				let db = new sqlite3.Database(path);

				let call = (method, text, params) =>
					new Promise((resolve, reject) =>
						db[method](text, params || [], (error, rows) =>
							error ? reject(error) : resolve(rows)));

				try {

					return await runSqlStatements(async (st, last) =>
						(last && built.returns === "rows") ?
							await call("all", st.text, st.params) :
							(await call("run", st.text, st.params), null)
					, built);
				}

				finally {
					db.close();
				}
			}
		}
	],

	query: async (data, options) => {

		options = options != null ? options : {};

		try {

			data = omniQuery.utils.general.normalizeContext(data);

			let backend = (
				options.middleware != null ?
					options.middleware : omniQuery.middleware
			).filter(item => {
				try { return item.match(data); }
				catch(error) { return false; }
			})[0];

			if(backend == null)
				throw new Error(
					`OmniQuery: no backend matched '${data.access.url}'.`
				);

			return await backend.query(data, options);
		}

		catch(error) {

			console.error(error);

			return null;
		}
	},

	// Dynamic OQL query executor (README 2.1.1.5.2 / 2.1.2.10.1).
	//
	// Best-effort per the loose specification: walks a meta-model list, resolves
	// each node's "context"/"query" OQL against the engine, and embeds the results
	// back into the node ("resolves to and returns itself with the data embedded").
	// The declarative resource *creation* direction is left as a documented partial;
	// see the note in the README section referenced above.
	queryMeta: async (model, options) => {

		let walk = async (node) => {

			if(Array.isArray(node))
				return Promise.all(node.map(walk));

			if(node == null || typeof node !== "object")
				return node;

			let out = Array.isArray(node) ? [] : Object.assign({}, node);

			// A node may carry an OQL query to run against the resource it maps to.
			if(node.query != null) {

				let context = node.context != null ?
					await omniQuery.query(node.context, options) :
					node.query;

				out.data = await omniQuery.query(
					typeof node.query === "string" ?
						JSON.parse(node.query) : node.query,
					options
				);
			}

			if(node.children != null)
				out.children = await walk(node.children);

			return out;
		};

		return await walk(model);
	},

	subscribe: (target, selector) => {
		// STUB: value-change event handlers over a DMDB (README 2.1.1.3.2).
	},

	utils: {
		general: {
			getFilterTypes: getFilterTypes,
			classifyOperand: classifyOperand,
			normalizeContext: (context) => {

				context = context || {};
				context.access = context.access != null ? context.access : {};
				context.operation =
					context.operation != null ? context.operation : {};
				context.filters = context.filters != null ? context.filters : [];
				context.operation.type = context.operation.type != null ?
					context.operation.type : "read";
				context.operation.data = context.operation.data != null ?
					context.operation.data : [];

				return context;
			}
		},
		sql: {
			buildStatements: buildStatements,
			buildCondition: buildCondition,
			dialects: dialects
		},
		mongo: {
			buildFilter: buildMongoFilter,
			buildSort: buildMongoSort,
			buildCondition: buildMongoCondition
		}
	}
};

// Mongo join via aggregation $lookup (best-effort; inner + lateral only).
async function mongoJoin(collection, types, merges) {

	let merge = merges[0];
	let mergeType = String(merge.type).toLowerCase().trim();

	if(mergeType === "merge")
		throw new Error(
			"OmniQuery: full outer join (merge) is not supported for MongoDB; " +
			"use merge-inner or merge-lateral."
		);

	let rightCtx = merge.options.value[0] || {};
	let condition = merge.options.value[1];
	let rightTypes = getFilterTypes(rightCtx.filters || []);
	let rightAt = (rightTypes["at"] || []);

	// Expect a simple equality join: ["equals", "localField", "foreignField"].
	let left = classifyOperand(condition[1]);
	let right = classifyOperand(condition[2]);

	let pipeline = [
		{ $match: buildMongoFilter(types) },
		{
			$lookup: {
				from: rightAt[rightAt.length - 1].value,
				localField: left.name,
				foreignField: right.name,
				as: "_merged"
			}
		}
	];

	// inner join: drop documents with no match.
	if(mergeType === "merge-inner")
		pipeline.push({ $match: { _merged: { $ne: [] } } });

	return await collection.aggregate(pipeline).toArray();
}

if(typeof module == "object")
	module.exports = omniQuery;