let utils = {
	normalizeContext: (context) => {

		context.access = context.access != null ? context.access : {};
		context.operation = context.operation != null ? context.operation : {};
		context.filters = context.filters != null ? context.filters : [];

		return context;
	},
	normalizeValue: (value) => {

		value = JSON.parse("" + value);

		if(typeof value == "string") {

			if(value.startsWith("\"") && value.endsWith("\""))
				value = value.substring(1, value.length - 1);
		}

		return value;
	}
};

module.exports = [
	{
		process: (context, args) => {

			if(context.local.operator != "access")
				return null;

			return JSON.stringify(utils.normalizeContext({
				access: {
					url: utils.normalizeValue(args[0]),
					options: args[1] != null ?
						JSON.parse("" + args[1]) :
						null
				},
				operation: {
					type: "read"
				}
			}));
		},
		tags: ["oql", "access"]
	},
	{
		process: (context, args) => {

			if(context.local.operator != "append")
				return null;

			if(!args[0].startsWith("{"))
				return null; // STUB

			let data = utils.normalizeContext(JSON.parse(args[0]));

			data.operation.type = "create"
			data.operation.data = args.slice(1).map(item => JSON.parse(item));

			return JSON.stringify(data);
		},
		tags: ["oql", "append"]
	},
	{
		process: (context, args) => {

			if(context.local.operator != "at")
				return null;

			if(!args[0].startsWith("{"))
				return `${args[0]}[${args[1]}]`;

			let data = utils.normalizeContext(JSON.parse(args[0]));

			args.slice(1).forEach(item => {

				data.filters.push({
					type: "at",
					options: {
						value: utils.normalizeValue(item)
					}
				});
			});

			return JSON.stringify(data);
		},
		tags: ["oql", "at"]
	},
	{
		process: (context, args) => {

			if(context.local.operator != "filter")
				return null;

			let data = utils.normalizeContext(JSON.parse(args[0]));

			data.filters.push({
				type: "filter",
				options: {
					value: context.local.list[2]
				}
			});

			return JSON.stringify(data);
		},
		tags: ["oql", "filter"]
	},
	{
		process: (context, args) => {

			if(context.local.operator != "remove")
				return null;

			if(!args[0].startsWith("{"))
				return null; // STUB

			let data = utils.normalizeContext(JSON.parse(args[0]));
			data.operation.type = "delete"

			return JSON.stringify(data);
		},
		tags: ["oql", "remove"]
	},
	{
		process: (context, args) => {

			if(context.local.operator != "set")
				return null;

			if(!args[0].startsWith("{")) {

				return context.state[args[0]] != null ?
					`${args[0]}=context.state[${args[0]}];` :
					`${
						args[0]
					}=${
						args[1]
					},context.state["${
						args[0]
					}"]=${
						args[0]
					};`
			}

			let data = utils.normalizeContext(JSON.parse(args[0]));

			data.operation.type = "update"
			data.operation.data = args.slice(1).map(item => JSON.parse(item));

			return JSON.stringify(data);
		},
		tags: ["oql", "set"]
	},
	{
		process: (context, args) => {

			if(context.local.operator != "sort")
				return null;

			let data = utils.normalizeContext(JSON.parse(args[0]));

			data.filters.push({
				type: "sort",
				options: {
					value: JSON.parse(args[1])
				}
			});

			return JSON.stringify(data);
		},
		tags: ["oql", "sort"]
	},
	{
		process: (context, args) => {

			if(context.local.operator != "query")
				return null;

			return `(use("telos-oql/omniQuery.js").query(${args[0]}))\n`;
		},
		tags: ["oql", "query"]
	}
];