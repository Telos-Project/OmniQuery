# OmniQuery

## 1 - Abstract

***The State of Union.***

OmniQuery (OQ, or OmniQuery Language - OQL / "Ockle") is a LISP dialect for database-agnostic
querying.

## 2 - Contents

### 2.1 - Language

#### 2.1.1 - Conventions

##### 2.1.1.1 - Dynamic LISP

Dynamic LISP is a LISP convention which allows values in lists to have keys.

A value with a key in a dynamic LISP list shall itself be nested as the third value in a sublist
added in its place to the list to which it belongs, where the first value or operator of said
sublist is a colon and the second value is the key.

By default, value keys should be strings.

For example:

    (value1 (: "key" value2))

In the context of dynamic LISP, keyed values can be called dynamic values, and lists featuring
dynamic values can be called dynamic lists. These concepts may be applied beyond dynamic LISP.

Dynamic list values, be they dynamic or not, may be indexed by index or key.

###### 2.1.1.1.1 - Cross Dialect Usage

If added to other LISP dialects, dynamic lists can be injected using the dynamic operator, which
resolves to everything following itself and all content nested therein in the form of a dynamic
list.

For example:

	(op arg1 (dynamic value1 (: "key" value2)) arg3)

###### 2.1.1.1.2 - Dynamic Paths

A dynamic path is a list of strings and numeric atoms which dictate a path from a root dynamic list
to a value nested therein.

Each element in the path selects a descendant of the value identified by the previous element, save
for the first element, which identifies a descendant of the root list. A string element selects by
key and a numeric element selects by index.

Dynamic paths may either be applied in child mode or descendant mode. In the former, elements may
only select from the immediate children of the values they are applied to. In the latter, they may
select the nearest matching descendant as located using a breadth first traversal.

###### 2.1.1.1.3 - Dynamic Metadata

Dynamic metadata is a dynamic list convention regarding meta dynamic lists. A meta dynamic list is
a dynamic list used for assigning properties to another dynamic list, referred to as the content
list, without embedding said properties into the content list itself.

A meta dynamic list has two values, one with the key "content", containing the content list, and
one with the key "metadata", containing a list of property lists. Property lists are dynamic lists
which have two values, one with the key "selector", containing a dynamic path to a value within the
aforementioned content, and one with the key "properties", containing a miscellaneous value to
associate with the selected value.

As with ordinary dynamic lists, if added to other LISP dialects, meta dynamic lists can be injected
using the meta-dynamic operator, which resolves to everything following itself and all content
nested therein in the form of a dynamic list.

For example:

	(op
		arg1
		(meta-dynamic
			(: "content" (value1 (: "key" value2)))
			(: "metadata" (
				(
					(: "selector" ("key"))
					(: "properties" (prop1 prop2))
				)
			))
		)
		arg3
	)

###### 2.1.1.1.4 - JSON Conversion

When converting a dynamic list to JSON, a dynamic list with no dynamic values shall become a JSON
list, and a dynamic list with dynamic values shall become a JSON object, with the order of the
elements of said list preserved in the resulting object, and with non-dynamic values in said list
receiving the stringified form of their index as their key.

Ordinary lists within dynamic lists shall become JSON lists, non-stringified JSON compatible
primitive atoms or LISP style equivalents (nil = null, etc), shall become JSON primitives, and all
other atoms shall become JSON strings.

JSON content may also be converted to dynamic lists.

##### 2.1.1.2 - Data

###### 2.1.1.2.1 - State

OmniQuery is, in and of itself, stateless.

###### 2.1.1.2.2 - Contexts

OmniQuery contexts are objects which act as cursors which point to specific databases and sets of
data therein.

###### 2.1.1.2.3 - Dynamic Mapping

OmniQuery represents any database it interacts with, and the contexts it uses to interact with
them, as dynamic lists. The resulting mapping is referred to as a dynamic mapped database (DMDB).

As such, when a context is returned to an external environment, its contents are returned as a
dynamic list. Usually, the returned contents are in the form JSON.

A relational database may be mapped to a dynamic list, where each table in the database is
represented as a list dynamic value in said dynamic list, the key of the value being the name of
the table and the value itself being the contents of the table.

Each element of said list shall be a dynamic list representing a row in said table, with each value
of said list being a dynamic value and representing a column in said table, the key of the value
being the name of the column, and the value itself being the value of the column, converted to a
JSON compatible types.

###### 2.1.1.2.4 - Type LISP

Type LISP is a LISP convention where a value may be assigned metadata using a list where the
operator is "type", where said value is the first argument, and where the second argument is a
dynamic list containing said metadata.

Codified conventions for the content or application of such metadata are referred to as type LISP
conventions.

##### 2.1.1.3 - Standard Fusion LISP

OmniQuery borrows the logic and arithmetic operators of
[Standard Fusion LISP](https://github.com/Telos-Project/Fusion-LISP?tab=readme-ov-file#222---standard-fusion-lisp).

Additionally, it also borrows the return operator, and uses modified versions of certain
list-related operators.

##### 2.1.1.4 - Usage

###### 2.1.1.4.1 - Selectors

An OmniQuery script which returns data but does not edit data may be treated as a selector for the
returned data.

###### 2.1.1.4.2 - Subscriptions

OmniQuery subscriptions event handlers tied to specific values within a DMDB which trigger events
when said values are altered, ideally with the previous and new values being passed to said event.

OmniQuery subscriptions may be specified with OmniQuery selectors.

###### 2.1.1.4.3 - Entanglement

OmniQuery entanglement is when rules for two values in separate DMDBs are enforced to keep them
aligned, if not identical, when one of them is altered.

OmniQuery entanglements may be specified with OmniQuery selectors, handled by OmniQuery
subscriptions, and declared and unidirectional or bidirectional.

###### 2.1.1.4.4 - Resolvers

An OmniQuery resolver is an API endpoint which transforms an incoming query to the API into a query
to a database according to its content.

###### 2.1.1.4.5 - Streams

An OmniQuery stream is a sustained connection between data in a DMDB and an external system.

###### 2.1.1.4.6 - Agnostic Scripts

Agnostic scripts are scripts for a system which may be written in any language. As such, rather
than interacting with said system through environmental variables and functions, the scripts,
written as function bodies, return an OmniQuery script as a LISP string, which executes upon the
state of said system (said state itself represented as a DMDB), the results of which are then
passed to the same script as a dynamic list encoded in a JSON string upon its next execution.

##### 2.1.1.5 - Meta Models

Meta models are models which contextualize a disparate set of records and databases by serializing
them within, or referencing them from, a hierarchical structure.

###### 2.1.1.5.1 - Dynamic Meta Models

A dynamic list, referred to as a model list, may be used to encode the structure of a meta model,
and metadata may be assigned to a model list by embedding it in a meta dynamic list referred to as
a meta model list.

The model list should only serialize the hierarchical structure and data content of the meta model
to which it maps. A model list is not required to serialize the entirety of the meta model to which
it, though one which does is referred to as a complete model list, and one which does not is
referred to as incomplete.

The property lists assigned to values within model lists may have a value with the key "context",
which contains an OQL query which returns a context that the value corresponding to the property
list in question acts as an alias to, with any descendant of said corresponding value being nested
within said context; and may have a value with the key "properties", said value being a dynamic
list by default, which specifies the system and type properties assigned to the value corresponding
to the property list in question.

###### 2.1.1.5.2 - Dynamic OQL Queries

A dynamic OQL query is submitted as a meta model list where the property lists thereof may have an
additional value with the key "query", containing an OQL query to execute upon the resource to
which the value, corresponding to the property list in question, maps.

When executed, it shall not only execute said OQL queries, but shall also create and update the
resources to which it maps according to the structure and content declaratively specified in its
model list and property list properties. It shall then resolve to and return itself with the data
said OQL queries resolved to embedded in its model list and property list properties.

#### 2.1.2 - Operators

##### 2.1.2.1 - arguments

The arguments atom, if used in the main scope of the script, resolves to a context passed in by the
process executing the script, and if used in the scope of an isolated expression, resolves to the
value passed to said expression when said expression is invoked.

##### 2.1.2.2 - at

###### 2.1.2.2.1 - As Context

The at operator takes a context object as its first argument, with each subsequent argument being a
number or string.

For each subsequent argument, it shall be treated as an identifier for a value in the dynamic list
selected corresponding to the previous argument, with strings being keys and numbers being indices.

It shall return a context object corresponding to the dynamic list selected by the last argument.

###### 2.1.2.2.2 - As Field

If used in an expression applied to other values as part of a selection or transformation process,
the at operator shall operate largely as described above, but with the arguments atom as the first
argument, representing the value to which the expression is applied, and with the operator
returning the raw value selected by its last argument rather than a context.

##### 2.1.2.3 - access

The access operator takes a string as its first argument, and may optionally take a dynamic list as
its second argument.

The string shall specify the address of a database to be accessed, and the dynamic list, if
present, shall specify credentials for accessing said database if necessary.

It shall return a context object representing the accessed database.

##### 2.1.2.4 - append

The append operator takes a context object as its first argument, with each subsequent argument
being a dynamic list.

It shall create a value in the database, and at the location therein, corresponding to the context,
from each dynamic list.

##### 2.1.2.5 - crop

The crop operator takes a context argument as its first argument, and a number as its second.

It shall return the context modified such that its contents are trimmed to no more than the length
specified by the number.

##### 2.1.2.6 - focus

The focus operator takes a context argument as its first argument, with each subsequent argument
being a string.

It shall return the context modified such that all values nested within it only contain values
keyed by the specified strings.

##### 2.1.2.7 - filter

The filter operator takes a context argument as its first argument, with an expression that
evaluates to a boolean as its second argument.

It shall return the context modified such that any value nested within it is removed if the
expression, when applied to it, resolves to false.

##### 2.1.2.8 - merge

The merge operator takes two context objects, which should correspond to tables, as its first two
arguments, the first one being referred to as the left context and the second being referred to as
the right context, and an expression which resolves to a boolean as its third argument.

It returns a new context generated by performing a full outer join on the two contexts with the
expression as the join condition.

###### 2.1.2.8.1 - merge-inner

The merge-inner operator behaves similarly to the merge operator, but performs an inner join
instead of a full outer join.

###### 2.1.2.8.2 - merge-lateral

The merge-lateral operator behaves similarly to the merge operator, but performs a left outer join
instead of a full outer join.

##### 2.1.2.9 - properties

The properties operator takes a context as its only argument, and returns a context containing the
system metadata corresponding to the original context.

##### 2.1.2.10 - query

The query operator takes a list containing an OQL query as its only argument, executes the query,
and returns the contents of any context object the query returns as a dynamic list.

It may be used to embed OQL in other LISP dialects.

###### 2.1.2.10.1 - query-meta

The query-meta operator behaves similarly to the query operator, but instead takes a dynamic list
containing a dynamic OQL query as its only argument, executes the query, and returns the resulting
meta model the query resolves to as a dynamic list.

##### 2.1.2.11 - remove

The remove operator takes a context object as its only argument, and removes all values which
correspond to the context from the database which contains them.

##### 2.1.2.12 - set

The set operator takes a context object as its first argument, and an arbitrary expression as its
second argument.

It shall transform all values which correspond to the context to the value generated by passing
them to the expression.

##### 2.1.2.13 - sort

The sort operator takes a context object as its first argument, and a dynamic list consisting of
dynamic values where every such value is a boolean as its second argument.

It shall sort contents of the context and return it, where every key in the dynamic list specifies
the key of a field to sort the contents by, with the order of the values determining sorting
priority. A value of true means ascending order and a value of false means descending order.