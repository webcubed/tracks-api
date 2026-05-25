/** @type {import("xo").FlatXoConfig} */
const xoConfig = {
	prettier: true,
	semicolon: true,
	ignores: [
		"next-env.d.ts",
		".next/**",
		"**/next-env.d.ts",
		"eslint.config.mjs",
	],
	rules: {
		"import-x/order": "off",
		"import-x/newline-after-import": "off",
		"import-x/no-duplicates": "off",
		"new-cap": "off",
		"@typescript-eslint/triple-slash-reference": "off",
		"@typescript-eslint/naming-convention": [
			"error",
			{
				selector: "variable",
				format: ["camelCase", "PascalCase"],
			},
		],
		"unicorn/filename-case": "off",
		"import-x/extensions": "off",
		"unicorn/prefer-node-protocol": "off",
		"n/prefer-global/process": "off",
	},
};

export default xoConfig;
