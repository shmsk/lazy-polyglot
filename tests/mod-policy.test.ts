// The plugin directory's mod policy, checked here so a violation fails before submission:
// "Write each call on the capability object as $.noun.method(...), each registration as
// on("event", hook) on a line of its own, and pass $ or the on function only as one whole
// argument to a function declared at the top of the same file."
// The directory also flagged a $-free function whose template literals hold `${` (0.9.16,
// hintText), so `${` stays inside functions that take $ or in helper modules.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");

export function policyViolations(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const out: string[] = [];

  // functions declared at the top of the file, plus the engine helpers imported from claude-code
  const allowed = new Set<string>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) allowed.add(s.name.text);
    if (ts.isImportDeclaration(s) && (s.moduleSpecifier as ts.StringLiteral).text === "claude-code") {
      const named = s.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) allowed.add(el.name.text);
    }
  }

  const takesDollar = (fn: ts.SignatureDeclaration) => fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === "$");
  const isOnHandler = (fn: ts.Node) =>
    ts.isCallExpression(fn.parent) && ts.isIdentifier(fn.parent.expression) && fn.parent.expression.text === "on" && fn.parent.arguments.includes(fn as ts.Expression);

  function visit(node: ts.Node) {
    // a function that takes $ is a top-level function declaration or an on(...) handler
    if (ts.isFunctionLike(node) && takesDollar(node as ts.SignatureDeclaration)) {
      const topLevel = ts.isFunctionDeclaration(node) && node.parent === sf;
      if (!topLevel && !isOnHandler(node)) out.push(`${fileName}:${line(node)} takes $ but is not a function declared at the top of the file`);
    }

    if (ts.isIdentifier(node) && node.text === "$") {
      const p = node.parent;
      if (ts.isParameter(p)) {
        // fine
      } else if (ts.isPropertyAccessExpression(p) && p.expression === node) {
        // $.noun.method(...) or a $.noun.prop read. A property of what the call returns stays:
        // `$.ui.resolve(e).Input` after narrowing e.surface is how the engine types Input and Svg.
        const second = p.parent;
        if (!ts.isPropertyAccessExpression(second) || second.expression !== p) out.push(`${fileName}:${line(node)} $.${p.name.text} is not $.noun.method(...)`);
        else if (ts.isPropertyAccessExpression(second.parent) && second.parent.expression === second)
          out.push(`${fileName}:${line(node)} $.${p.name.text}.${second.name.text} goes deeper than $.noun.method`);
      } else if (ts.isCallExpression(p) && p.arguments.includes(node)) {
        const callee = p.expression;
        if (!ts.isIdentifier(callee) || !allowed.has(callee.text)) out.push(`${fileName}:${line(node)} passes $ to ${callee.getText(sf)}, not a function declared at the top of the file`);
      } else out.push(`${fileName}:${line(node)} uses $ outside a call, a parameter or a whole argument`);
    }

    if (ts.isIdentifier(node) && node.text === "on" && ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const stmt = node.parent.parent;
      const ownLine = ts.isExpressionStatement(stmt) && sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).character === source.split("\n")[line(stmt) - 1]!.search(/\S/);
      if (!ownLine) out.push(`${fileName}:${line(node)} on(...) is not a statement on a line of its own`);
    }

    if (ts.isTemplateExpression(node)) {
      let fn: ts.Node | undefined = node.parent;
      let ok = false;
      for (; fn && fn !== sf; fn = fn.parent) if (ts.isFunctionLike(fn) && takesDollar(fn as ts.SignatureDeclaration)) ok = true;
      if (!ok) out.push(`${fileName}:${line(node)} template literal with \${ outside a function that takes $`);
    }

    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

const mods = readdirSync(join(root, "mods")).filter((m) => existsSync(join(root, "mods", m, "hooks")));
const files = mods.flatMap((m) =>
  readdirSync(join(root, "mods", m, "hooks"))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join("mods", m, "hooks", f)),
);

describe("mod directory policy", () => {
  test("there is a mod hook file to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files)
    test(`${f} uses $ and on only in the shapes the directory reads`, () => {
      expect(policyViolations(f, readFileSync(join(root, f), "utf8"))).toEqual([]);
    });

  test("the check catches the shapes the directory flagged in 0.9.16", () => {
    const bad = [
      "import { update } from 'claude-code'",
      "function plain(h) { return `${h.a} b` }",
      "const refresh = ($) => void cards($)",
      "async function cards($) { return $.ui.resolve(e).x.y }",
      "export const register = on => {",
      "  on('a', async ($, e, next) => next(e)); const x = on('b', h)",
      "}",
    ].join("\n");
    const v = policyViolations("bad.tsx", bad);
    expect(v.some((s) => s.includes(":2 template literal"))).toBe(true);
    expect(v.some((s) => s.includes(":3 takes $"))).toBe(true);
    expect(v.some((s) => s.includes(":4 "))).toBe(false); // a property of a $ call's result is fine
    expect(v.some((s) => s.includes(":6 on(...)"))).toBe(true);
  });
});
