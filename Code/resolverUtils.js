var fusionLISP = require("fusion-lisp/fusionLISP.js");

var resolverUtils = {
	whitelist: [
		"add",
		"and",
		"append",
		"arguments",
		"at",
		"crop",
		"divide",
		"equals",
		"filter",
		"focus",
		"greater",
		"less",
		"merge",
		"merge-inner",
		"merge-lateral",
		"modulus",
		"multiply",
		"not",
		"or",
		"properties",
		"remove",
		"set",
		"size",
		"sort",
		"subtract",
		"xor"
	],
	resolve: (packet, context, options) => {

		let operation = fusionLISP.parse(packet);

		let whitelist = resolverUtils.whitelist.filter(item =>
			!(
				options?.blacklist != null ?
					options?.blacklist.map(op => op.toLowerCase()) : []
			).includes(item)
		).concat(
			options?.whitelist != null ? options?.whitelist : []
		).map(op => op.toLowerCase());

		let operations = [...new Set(
			operation.flat(Infinity).map(item => item.toLowerCase())
		)].filter(
			item => {

				try {

					JSON.parse(item);

					return false;
				}

				catch(error) {
					return true;
				}
			}
		);

		if(operations.filter(item => !whitelist.includes(item)).length > 0)
			return { response: { status: 400 } };

		return new Promise((resolve, reject) => {

			try {

				fusionLISP.run(
					[
						["use", "\"fusion-lisp\"", "\"telos-oql\""],
						["return", ["query", operation]]
					],
					[
						fusionLISP.run([
							["use", "\"fusion-lisp\"", "\"telos-oql\""],
							["return", fusionLISP.parse(context)]
						])
					]
				).then((data) => {

					resolve({
						body: JSON.stringify(data)
					});
				});
			}

			catch(error) {

				resolve({
					response: { status: 400 }
				});
			}
		});
	}
};

if(typeof module == "object")
	module.exports = resolverUtils;