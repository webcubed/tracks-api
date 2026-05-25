/** @type {import("prettier").Config} */
const config = {
	bracketSpacing: true,
	embeddedLanguageFormatting: "auto",
	endOfLine: "auto",
	semi: true,
	singleQuote: false,
	trailingComma: "es5",
	useTabs: true,
	plugins: ["prettier-plugin-pkgsort", "@ianvs/prettier-plugin-sort-imports"],
	importOrder: [
		"",
		"<TYPES>^(node:)",
		"<TYPES>",
		"<TYPES>^[.]",
		"<BUILTIN_MODULES>",
		"<THIRD_PARTY_MODULES>",
		"^[.]",
		"^(?!.*[.]css$)[./].*$",
		".css$",
	],
};

export default config;
