var fusionLISP = require("fusion-lisp/fusionLISP.js");

var resolverUtils = {
	getUser: (db, session, policies) => {

	},
	getSession: (db, username, password) => {

	},
	whitelist: [
		// STUB - PREVENT INJECTION
	],
	resolve: (packet, context, options) => {

		return new Promise((resolve, reject) => {

			try {

				fusionLISP.run(
					[
						["use", "\"fusion-lisp\"", "\"telos-oql\""],
						["return", ["query", fusionLISP.parse(packet)]]
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