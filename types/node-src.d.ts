// Only for tsconfig.src.json, which types src/ with @types/node and no Bun types. Under the Bun types (tests,
// scripts) `*.html` is already declared as an HTML bundle; wip imports it as text and casts it.
declare module "*.html" {
  const text: string;
  export default text;
}
