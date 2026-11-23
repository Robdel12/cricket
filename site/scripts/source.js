import { relative, resolve } from 'node:path';
import ts from 'typescript';

function commentText(raw) {
  return raw.slice(3, -2).split('\n')
    .map(line => line.replace(/^\s*\* ?/, '')).join('\n').trim();
}

export function sourceGuides(files) {
  let guides = new Map();
  for (let [path, text] of files) {
    let source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    let seen = new Set();
    function visit(node) {
      for (let { pos, end } of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
        if (seen.has(pos)) continue;
        seen.add(pos);
        let raw = text.slice(pos, end);
        if (!raw.startsWith('/**')) continue;
        let [header, ...lines] = commentText(raw).split('\n');
        if (!header.startsWith('@guide ')) continue;
        let match = header.match(/^@guide ([a-z]+(?:-[a-z]+)*) (.+)$/);
        let body = lines.join('\n').trim();
        if (!match || !body) throw new Error(`Expected @guide slug Title and prose in ${path}.`);
        let [, key, title] = match;
        if (guides.has(key)) throw new Error(`Duplicate @guide ${key} in ${path}.`);
        guides.set(key, { title, body });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return guides;
}

function documentation(declaration) {
  let docs = ts.getJSDocCommentsAndTags(declaration).filter(ts.isJSDoc);
  return ts.getTextOfJSDocComment(docs.at(-1)?.comment)?.trim();
}

function describe(symbol, checker) {
  let name = symbol.name;
  let specifier = symbol.declarations?.find(ts.isExportSpecifier);
  let exportStatement = specifier?.parent.parent;
  let exportedFrom = exportStatement?.moduleSpecifier;
  if (exportedFrom && !exportedFrom.text.startsWith('.'))
    return { name, description: documentation(exportStatement), source: specifier, dependency: exportedFrom.text };

  let target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  let declaration = target.valueDeclaration;
  if (!declaration) throw new Error(`Could not find the JavaScript declaration for ${name}.`);
  let owner = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
  let description = documentation(owner);

  let callable = ts.isFunctionDeclaration(declaration) ? declaration : declaration.initializer;
  let parameters = callable && (ts.isFunctionLike(callable) || ts.isArrowFunction(callable))
    ? callable.parameters.map(parameter => parameter.getText())
    : undefined;
  let tags = ts.getJSDocTags(owner).filter(ts.isJSDocParameterTag);
  let options = tags.map(tag => ({
    name: tag.name.getText(),
    optional: tag.isBracketed,
    description: ts.getTextOfJSDocComment(tag.comment)?.replace(/^[-–] /, '')
  })).filter(tag => tag.description);

  return { name, description, source: declaration, parameters, options };
}

export function publicApi(root, exports) {
  let entries = Object.entries(exports).map(([key, path]) => [key, resolve(root, path)]);
  let program = ts.createProgram(entries.map(([, path]) => path), {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    noEmit: true,
    types: []
  });
  let checker = program.getTypeChecker();
  let modules = entries.map(([key, path]) => {
    let source = program.getSourceFile(path);
    let module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`Could not read public entry point ${key} at ${path}.`);
    return [key, checker.getExportsOfModule(module)
      .map(symbol => describe(symbol, checker))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))];
  });
  let missing = new Set();
  for (let [, entries] of modules)
    for (let { name, description, source } of entries)
      if (!description) missing.add(`Document ${name} in ${relative(root, source.getSourceFile().fileName)}.`);
  if (missing.size) throw new Error([...missing].join('\n'));
  return modules;
}
