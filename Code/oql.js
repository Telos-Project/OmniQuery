let utils = {
	left: /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:".*?"|'.*?'|\d+|[A-Za-z_$][\w$]*)\])*$/,
	normalizeContext: (context) => {

		context.access = context.access != null ? context.access : {};
		context.operation = context.operation != null ? context.operation : {};
		context.filters = context.filters != null ? context.filters : [];

		context.operation.type =
			context.operation.type != null ? context.operation.type : "read";

		context.operation.data =
			context.operation.data != null ? context.operation.data : [];

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

			return context.local.operator == "access" ?
				JSON.stringify(utils.normalizeContext({
					access: {
						url: utils.normalizeValue(args[0]),
						options: args[1] != null ?
							JSON.parse("" + args[1]) :
							null
					}
				})) :
				null;
		},
		tags: ["oql", "access"]
	},
	{
		process: (context, args) => {

			return context.local.operator == "append" ?
				`(Array.isArray(${
					args[0]
				})?([${
					args.slice(1).map(item => `(${item})`).join(",")
				}].forEach(item=>{(${
					args[0]
				}).push(item);}):((context)=>{
					context.operation.type="create";
				${
					args.slice(1).map(
						item => `context.operation.data.push(${item});`
					).join("")
				}return context;})(${
					args[0]
				}))` :
				null;
		},
		tags: ["oql", "append"]
	},
	{
		process: (context, args) => {

			return context.local.operator == "at" ?
				`(Array.isArray(${
					args[0]
				})?((${
					args[0]
				})${
					args.slice(1).map(item => `[${item}]`).join("")
				}):((context)=>{${
					args.slice(1).map(item =>
						`context.filters.push({type:"at",options:{value:(${
							item
						})}});`
					).join("")
				}return context;})(${
					args[0]
				}))` :
				null;
		},
		tags: ["oql", "at"]
	},
	{
		process: (context, args) => {

			return context.local.operator == "filter" ?
				`(((context)=>{context.filters.push(
					{type:"filter",options:{value:(
				${
					JSON.stringify(context.local.list[2])
				})}});return context;})(${args[0]}))` :
				null;
		},
		tags: ["oql", "filter"]
	},
	{
		process: (context, args) => {

			return context.local.operator == "remove" ?
				`(Array.isArray(${
					args[0]
				})?((${args[0]}).splice(${args[1], 1}))${
					args.slice(1).map(item => `[${item}]`).join("")
				}):(((context)=>{
					context.operation.type="delete";return context;
				})(${
					args[0]
				})))` :
				null;
		},
		tags: ["oql", "remove"]
	},
	{
		process: (context, args) => {

			return context.local.operator == "set" ?
				`((((item)=>{
					if(item==null)return true;
					return !(typeof item =="object"&&!Array.isArray(item));
				})(typeof (${
					args[0]
				})=="undefined"?null:(${
					args[0]
				})))?(()=>{${
					context.state[args[0]] != null ?
						`${args[0]}=context.state[${args[0]}];` :
						""
				}(1, eval)(${
					JSON.stringify(
						context.state[args[0]] == null ?
							`${
								args[0]
							}=${
								args[1]
							};` :
							""
					)
				});${
					/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(args[0]) ?
						`context.state["${
							args[0]
						}"]=${
							args[0]
						};` :
						""
				}})():((context)=>{
					context.operation.type="update";
				${
					args.slice(1).map(
						item => `context.operation.data.push(${item});`
					).join("")
				}return context;})(${
					args[0]
				}))\n` :
				null;
		},
		tags: ["oql", "set"]
	},
	{
		process: (context, args) => {

			return context.local.operator == "sort" ?
				`(Array.isArray(${
					args[0]
				})?((${args[0]}).sort()):(((context)=>{
					context.filters.push({type:"at",options:{value:(${
						args[1]
					})}});return context;
				})(${
					args[0]
				})))` :
				null;
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