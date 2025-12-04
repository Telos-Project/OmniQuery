var autoCORS = require("telos-autocors");
var Database = require('better-sqlite3');
var { MongoClient } = require("mongodb");
var pg = require("pg");
var sqlite3 = require('sqlite3').verbose();

// STUB: Selector Format Conversions?

/*

	FORMAT:

	{
		access: {
			url: "...",
			options: { ... },
			type?: "..." / ["...", ...]
		},
		operation: {
			type: "...",
			data: { ... },
			options: { ... }
		},
		filters: [
			{
				type: "...",
				options: { ... }
			}
		]
	}

 */

var omniQuery = {
	entangle: (source, target, mutual) => {
		// STUB
	},
	intervals: [],
	middleware: [
		// STUB: Postgres, Mongo, JSON | File / Storage / Memory / Server
		{ // MONGO
			match: (data) => {
				return data.access.url.startsWith("mongodb://") ||
					data.access.url.startsWith("mongodb+srv://");
			},
			query: (data, options) => {

				return new Promise((resolve, reject) => {

					(async () => {

						let client = new MongoClient(data.access.url);
						let contents = null;

						try {

							let operation =
								data.operation.type.toLowerCase().trim();

							let types = omniQuery.utils.general.getFilterTypes(
								data.filters
							);

							await client.connect();

							let db = client.db(types["at"][0].value);

							let collection =
								db.collection(types["at"][1].value);

							if(operation == "read") {

								contents =
									await collection.find({ }).toArray();
							}

							if(operation == "create") {
								
								contents =
									await collection.insertMany(
										data.operation.data
									);
							}
						}
						
						catch(error) {
							console.error(error);
						}
						
						await client.close();

						resolve(contents);
					})();
				});
			}
		},
		{ // POSTGRES
			match: (data) => {
				return data.access.url.startsWith("postgres://") ||
					data.access.url.startsWith("postgresql://");
			},
			query: (data, options) => {

				return new Promise((resolve, reject) => {

					(async () => {
							
						let client = new pg.Client({
							connectionString: data.access.url
						});

						try {

							await client.connect();

							let result = await client.query(
								omniQuery.utils.sql.constructSQL(data)
							);

							await client.end();

							resolve(result.rows);
						}

						catch(error) {

							console.error(error);
							client.end();

							resolve(null);
						}
					})();
				});
			}
		},
		{ // SQLITE
			match: (data) => {
				return !data.access.url.includes("://");
			},
			query: (data, options) => {

				let operation = data.operation.type.toLowerCase().trim();
				let query = omniQuery.utils.sql.constructSQL(data);

				let db = options.sync ?
					new Database(data.access.url) :
					new sqlite3.Database(data.access.url);

				try {

					if(operation == "read") {

						if(!options.sync) {

							return new Promise((resolve, reject) => {

								db.all(query, (error, rows) => {

									db.close();

									if(error) {

										console.error(error);

										resolve(null);
									}

									resolve(rows);
								});
							});
						}

						else {

							let rows = db.prepare(query).all();
							db.close();

							return rows;
						}
					}

					else {

						if(!options.sync) {

							return new Promise((resolve, reject) => {

								db.exec(query, (error) => {

									db.close();

									if(error)
										console.error(error);

									resolve(null);
								});
							});
						}

						else
							db.exec(query);
					}
				}

				catch(error) {
					console.error(error);
				}

				db.close();

				return null;
			}
		},
		{ // STUB: JSON - READ / WRITE -- HTTP
			match: (data) => {

			},
			query: (data, options) => {

			}
		}
	],
	query: (data, options) => {

		options = options != null ? options : { };

		try {

			return (
				options.middleware != null ?
					options.middleware : omniQuery.middleware
			).filter(item => {

				try {
					return item.match(data);
				}

				catch(error) {
					return false;
				}
			})[0].query(data, options);
		}

		catch(error) {

			console.log(error.stack);

			return null;
		}
	},
	subscribe: (target, selector) => {
		// STUB
	},
	utils: {
		general: {
			getFilterTypes: (filters) => {

				let types = {};

				filters.forEach(item => {

					let type = item.type.toLowerCase().trim();

					types[type] = types[type] != null ? types[type] : [];
					types[type].push(item.options);
				});

				return types
			}
		},
		sql: {
			constructSQL: (data) => { // STUB: PREVENT INJECTION

				let types = omniQuery.utils.general.getFilterTypes(
					data.filters
				);

				if(data.operation.type.toLowerCase().trim() == "read") {
					
					return `SELECT ${
						types["focus"] == null ?
							"*" : types["focus"][0].value.join(",")
					} FROM ${types["at"][0].value}${
						types["filter"] != null ?
							` WHERE ${
								types["filter"].map(
									item =>
										omniQuery.utils.sql.constructSQLFilter(
											item.value
										)
								).join(" AND ")
							}` :
							""
					}${
						types["crop"] != null ?
							` LIMIT ${types["crop"][0].value}` :
							""
					};`;
				}

				if(data.operation.type.toLowerCase().trim() == "create") {

					let columns = { };

					data.operation.data.forEach(item => {
						columns = Object.assign(columns, item);
					});
					
					return `CREATE TABLE IF NOT EXISTS ${
						types["at"][0].value
					} (${
						Object.keys(columns).map(column =>
							`${
								column
							} ${
								{
									"string": "TEXT",
									"number": "DECIMAL",
									"boolean": "BOOLEAN"
								}[typeof columns[column]]
							}`
						).join(",")
					}); INSERT INTO ${
						types["at"][0].value
					} (${
						Object.keys(columns).join(",")
					}) VALUES ${
						data.operation.data.map(item => {
							return `(${Object.keys(columns).map(
								(column) => {
									
									if(typeof item[column] == "string")
										return `'${item[column]}'`;
									
									if(typeof item[column] == "boolean")
										return `${item[column]}`.toUpperCase();
									
									if(typeof item[column] == "number") {

										return `${
											item[column]
										}${
											item[column] % 1 == 0 ? ".0" : ""
										}`;
									}

									return `${item[column]}`;
								}
							).join(",")})`
						}).join(",")
					};`;
				}
			},
			constructSQLFilter: (filter) => {
				
				filter = filter.map(
					item => Array.isArray(item) ?
						omniQuery.utils.sql.constructSQLFilter(item) : item
				);

				switch(filter[0].toLowerCase().trim()) {

					case "and": return filter.slice(1).join(" AND ");
					case "or": return filter.slice(1).join(" OR ");

					case "equals": return filter.map((item, index) => {
						return `${item} = ${filter[index + 1]}`;
					}).slice(1, filter.length - 1).join(" AND ");

					case "less": return filter.map((item, index) => {
						return `${item} < ${filter[index + 1]}`;
					}).slice(1, filter.length - 1).join(" AND ");

					case "greater": return filter.map((item, index) => {
						return `${item} > ${filter[index + 1]}`;
					}).slice(1, filter.length - 1).join(" AND ");

					case "gte": return filter.map((item, index) => {
						return `${item} >= ${filter[index + 1]}`;
					}).slice(1, filter.length - 1).join(" AND ");

					case "lte": return filter.map((item, index) => {
						return `${item} <= ${filter[index + 1]}`;
					}).slice(1, filter.length - 1).join(" AND ");

					default: return "";
				}
			},
		}
	}
};

if(typeof module == "object")
	module.exports = omniQuery;