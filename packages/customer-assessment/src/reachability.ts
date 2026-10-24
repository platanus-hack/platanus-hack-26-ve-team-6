import ts from 'typescript';
import type { DependencyComponent, DependencyReachability, CustomerRunInput } from '@gotchu/contracts';
import type { LockedPackage } from './lockfiles.js';

type SourceFile = NonNullable<CustomerRunInput['source']>['files'][number];
type ImportKind = DependencyReachability['importEvidence'][number]['kind'];
interface ImportBinding { local: string; exported: string; namespace: boolean; position: number }
interface ParsedSource { file: SourceFile; ast: ts.SourceFile; bindings: Map<string, ImportBinding[]>; imports: Map<string, DependencyReachability['importEvidence'][number][]>; requireAliases: Set<string>; parseFailed: boolean; dynamicResolution: boolean }

const codePath = /\.(?:[cm]?[jt]sx?)$/i;
const limitations = [
  'Static TypeScript parser evidence only; no customer code or package code ran.',
  'No static match does not prove unreachability. Computed runtime loading, framework auto-loading and bundler aliases may be unresolved.',
];

function packageNameFromSpecifier(specifier: string) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null : parts[0] ?? null;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineAt(file: ts.SourceFile, node: ts.Node) {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function stringArgument(call: ts.CallExpression) {
  const argument = call.arguments[0];
  return argument && ts.isStringLiteral(argument) ? argument.text : null;
}

function recordBinding(bindings: Map<string, ImportBinding[]>, packageName: string, binding: ImportBinding) {
  const values = bindings.get(packageName) ?? [];
  values.push(binding);
  bindings.set(packageName, values);
}

function isRequireExpression(expression: ts.Expression, aliases: ReadonlySet<string>) {
  return ts.isIdentifier(expression) && (expression.text === 'require' || aliases.has(expression.text))
    || ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
      && expression.expression.text === 'module' && expression.name.text === 'require';
}

function parseSources(files: readonly SourceFile[], packageNames: ReadonlySet<string>): ParsedSource[] {
  const codeFiles = files.filter(file => codePath.test(file.path));
  return codeFiles.map(file => {
    const ast = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind(file.path));
    const bindings = new Map<string, ImportBinding[]>();
    const imports = new Map<string, DependencyReachability['importEvidence'][number][]>();
    const requireAliases = new Set<string>();
    let dynamicResolution = false;
    const addImport = (specifier: string, node: ts.Node, kind: ImportKind) => {
      const packageName = packageNameFromSpecifier(specifier);
      if (!packageName || !packageNames.has(packageName)) return;
      const evidence = { file: file.path, line: lineAt(ast, node), specifier, kind };
      const existing = imports.get(packageName) ?? [];
      if (!existing.some(item => item.line === evidence.line && item.specifier === specifier && item.kind === kind)) existing.push(evidence);
      imports.set(packageName, existing);
    };
    const addDestructuredBindings = (name: ts.BindingName, packageName: string, position: number) => {
      if (ts.isIdentifier(name)) recordBinding(bindings, packageName, { local: name.text, exported: '', namespace: true, position });
      else if (ts.isObjectBindingPattern(name)) for (const element of name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const exported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
        recordBinding(bindings, packageName, { local: element.name.text, exported, namespace: false, position });
      }
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const packageName = packageNameFromSpecifier(specifier);
        addImport(specifier, node.moduleSpecifier, 'import');
        const clause = node.importClause;
        if (packageName && packageNames.has(packageName) && clause) {
          if (clause.name) recordBinding(bindings, packageName, { local: clause.name.text, exported: 'default', namespace: false, position: node.end });
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) recordBinding(bindings, packageName, { local: clause.namedBindings.name.text, exported: '', namespace: true, position: node.end });
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) {
            recordBinding(bindings, packageName, { local: item.name.text, exported: item.propertyName?.text ?? item.name.text, namespace: false, position: node.end });
          }
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
        const specifier = node.moduleReference.expression.text;
        const packageName = packageNameFromSpecifier(specifier);
        addImport(specifier, node.moduleReference.expression, 'require');
        if (packageName && packageNames.has(packageName)) recordBinding(bindings, packageName, {
          local: node.name.text, exported: '', namespace: true, position: node.end,
        });
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const packageName = packageNameFromSpecifier(specifier);
        addImport(specifier, node.moduleSpecifier, 're_export');
        if (packageName && packageNames.has(packageName) && node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const item of node.exportClause.elements) recordBinding(bindings, packageName, { local: '', exported: item.propertyName?.text ?? item.name.text, namespace: false, position: node.end });
        } else if (packageName && packageNames.has(packageName) && node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          recordBinding(bindings, packageName, { local: node.exportClause.name.text, exported: '', namespace: true, position: node.end });
        }
      } else if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = isRequireExpression(node.expression, requireAliases);
        if (isDynamicImport || isRequire) {
          const specifier = stringArgument(node);
          if (specifier !== null) addImport(specifier, node.arguments[0] ?? node, isDynamicImport ? 'dynamic_import' : 'require');
          else dynamicResolution = true;
        }
        if (ts.isIdentifier(node.expression) && /createRequire$/i.test(node.expression.text)
          || ts.isPropertyAccessExpression(node.expression) && /createRequire$/i.test(node.expression.name.text)) dynamicResolution = true;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === 'require') requireAliases.add(node.name.text);
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
        const importedValue = ts.isCallExpression(initializer) ? initializer : ts.isPropertyAccessExpression(initializer) && ts.isCallExpression(initializer.expression) ? initializer.expression : null;
        if (!importedValue) { ts.forEachChild(node, visit); return; }
        const isDynamicImport = importedValue.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = isRequireExpression(importedValue.expression, requireAliases);
        const specifier = isDynamicImport || isRequire ? stringArgument(importedValue) : null;
        const packageName = specifier === null ? null : packageNameFromSpecifier(specifier);
        if (packageName && packageNames.has(packageName)) {
          if (ts.isPropertyAccessExpression(initializer)) {
            const imported = initializer.name.text;
            if (ts.isIdentifier(node.name)) recordBinding(bindings, packageName, { local: node.name.text, exported: imported, namespace: false, position: node.end });
          } else addDestructuredBindings(node.name, packageName, node.end);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const syntaxDiagnostics = ts.transpileModule(file.content, {
      fileName: file.path,
      reportDiagnostics: true,
      compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest },
    }).diagnostics ?? [];
    return { file, ast, bindings, imports, requireAliases, parseFailed: syntaxDiagnostics.some(item => item.category === ts.DiagnosticCategory.Error), dynamicResolution };
  });
}

function expressionPath(node: ts.Expression): { root: string; properties: string[] } | null {
  if (ts.isIdentifier(node)) return { root: node.text, properties: [] };
  if (ts.isPropertyAccessExpression(node)) {
    const parent = expressionPath(node.expression);
    return parent ? { root: parent.root, properties: [...parent.properties, node.name.text] } : null;
  }
  return null;
}

function packageCallPath(node: ts.Expression, requireAliases: ReadonlySet<string>) {
  const properties: string[] = [];
  let current = node;
  while (ts.isPropertyAccessExpression(current)) { properties.unshift(current.name.text); current = current.expression; }
  if (!ts.isCallExpression(current)) return null;
  const isDynamicImport = current.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = isRequireExpression(current.expression, requireAliases);
  if (!isDynamicImport && !isRequire) return null;
  const specifier = stringArgument(current);
  return specifier === null ? null : { packageName: packageNameFromSpecifier(specifier), properties };
}

function isDeclarationName(node: ts.Identifier) {
  const parent = node.parent;
  return ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent)
    || ts.isVariableDeclaration(parent) && parent.name === node || ts.isBindingElement(parent) && parent.name === node
    || ts.isParameter(parent) && parent.name === node || ts.isFunctionDeclaration(parent) && parent.name === node
    || ts.isClassDeclaration(parent) && parent.name === node;
}

function symbolMatches(symbol: string, exported: string) {
  return symbol === exported || symbol.split('.').at(-1) === exported;
}

function symbolEvidenceForPackage(parsed: ParsedSource, packageName: string, symbols: readonly string[]) {
  const bindings = parsed.bindings.get(packageName) ?? [];
  const found: DependencyReachability['symbolEvidence'] = [];
  const add = (node: ts.Node, symbol: string) => {
    if (!found.some(item => item.file === parsed.file.path && item.line === lineAt(parsed.ast, node) && item.symbol === symbol)) {
      found.push({ file: parsed.file.path, line: lineAt(parsed.ast, node), symbol });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && packageNameFromSpecifier(node.moduleSpecifier.text) === packageName && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const item of node.exportClause.elements) {
        const exported = item.propertyName?.text ?? item.name.text;
        const symbol = symbols.find(candidate => symbolMatches(candidate, exported));
        if (symbol) add(item, symbol);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const path = expressionPath(node);
      if (path) for (const binding of bindings) {
        if (binding.namespace && path.root === binding.local) {
          const used = path.properties.join('.');
          const symbol = symbols.find(item => item === used || item === path.properties.at(-1));
          if (symbol) add(node, symbol);
        }
      }
      const calledPackage = packageCallPath(node, parsed.requireAliases);
      if (calledPackage?.packageName === packageName && calledPackage.properties.length > 0) {
        const used = calledPackage.properties.join('.');
        const symbol = symbols.find(item => item === used || item === calledPackage.properties.at(-1));
        if (symbol) add(node, symbol);
      }
    }
    if (ts.isIdentifier(node) && !isDeclarationName(node)) for (const binding of bindings) {
      if (!binding.namespace && binding.local === node.text && binding.position <= node.getStart(parsed.ast)) {
        const symbol = symbols.find(item => symbolMatches(item, binding.exported));
        if (symbol) add(node, symbol);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.ast);
  return found;
}

function directDependencyPath(target: LockedPackage, inventory: readonly LockedPackage[]) {
  if (target.relationship === 'direct') return [target.purl];
  if (target.relationship !== 'transitive') return null;
  const byPurl = new Map<string, LockedPackage>();
  for (const item of inventory) if (!byPurl.has(item.purl)) byPurl.set(item.purl, item);
  const roots = inventory.filter(item => item.relationship === 'direct');
  const queue = roots.map(item => ({ purl: item.purl, path: [item.purl] }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.purl)) continue;
    seen.add(current.purl);
    if (current.purl === target.purl) return current.path;
    for (const dependency of byPurl.get(current.purl)?.dependencies ?? []) {
      if (!seen.has(dependency) && current.path.length < 20) queue.push({ purl: dependency, path: [...current.path, dependency] });
    }
  }
  return null;
}

function hasUnsupportedResolverConfiguration(files: readonly SourceFile[]) {
  return files.some(file => {
    const name = file.path.split('/').at(-1) ?? '';
    if (/^(?:webpack|vite|next|nuxt|astro|rollup|svelte|jest|babel|postcss|eslint)\.config\.[cm]?[jt]s$/i.test(name)
      || /^(?:angular\.json|nest-cli\.json)$/i.test(name)) return true;
    if (/^tsconfig(?:\.[^/]+)?\.json$/i.test(name)
      && /"paths"\s*:/s.test(file.content)) return true;
    if (/^package\.json$/i.test(name)
      && /"(?:imports|next|nuxt|vite|webpack|astro|@angular\/core|@nestjs\/core)"\s*:/s.test(file.content)) return true;
    return false;
  });
}

export function analyzeDependencyReachability(
  source: NonNullable<CustomerRunInput['source']>,
  inventory: readonly LockedPackage[],
  targets: readonly LockedPackage[],
  symbolsByPackage: ReadonlyMap<string, readonly string[]>,
  graphComplete: boolean,
): Map<string, DependencyReachability> {
  const packageNames = new Set(inventory.map(item => item.name));
  const parsedSources = parseSources(source.files, packageNames);
  const supportedSourceExists = parsedSources.length > 0;
  const hasUnsupportedResolver = hasUnsupportedResolverConfiguration(source.files);
  const result = new Map<string, DependencyReachability>();
  for (const dependency of targets) {
    const imports = parsedSources.flatMap(parsed => parsed.imports.get(dependency.name) ?? []).slice(0, 20);
    const symbols = [...new Set(symbolsByPackage.get(`${dependency.name}\0${dependency.version}`) ?? [])].slice(0, 50);
    const symbolEvidence = parsedSources.flatMap(parsed => symbolEvidenceForPackage(parsed, dependency.name, symbols)).slice(0, 20);
    const path = directDependencyPath(dependency, inventory);
    const parseFailed = parsedSources.some(parsed => parsed.parseFailed);
    const dynamicResolution = parsedSources.some(parsed => parsed.dynamicResolution);
    let state: DependencyReachability['state'];
    if (!supportedSourceExists || parseFailed || imports.length === 0 && (dynamicResolution || hasUnsupportedResolver) || dependency.relationship === 'unknown' && imports.length > 0 || dependency.relationship === 'transitive' && imports.length > 0 && path === null) {
      state = 'unknown';
    } else if (imports.length === 0) state = 'not_found_static';
    else if (symbols.length > 0 && symbolEvidence.length > 0) state = 'reachable';
    else state = 'imported';
    const symbolCoverage: DependencyReachability['symbolCoverage'] = symbols.length === 0 ? 'unknown' : symbolEvidence.length > 0 ? 'available' : 'not_found_static';
    const limitation = [...limitations];
    if (!supportedSourceExists) limitation.push('No supported JavaScript or TypeScript files were present for static import analysis.');
    if (parseFailed) limitation.push('At least one supported JavaScript or TypeScript file could not be parsed; all reachability conclusions remain unknown.');
    if (dynamicResolution && imports.length === 0) limitation.push('A non-literal import() or require() was present, so static package resolution is unknown.');
    if (hasUnsupportedResolver && imports.length === 0) limitation.push('A framework, bundler, TypeScript alias or package import configuration was detected and was not resolved.');
    if (dependency.relationship === 'transitive' && path === null) limitation.push(graphComplete
      ? 'No direct dependency path to this transitive package was present in the parsed lockfile graph.'
      : 'The lockfile dependency graph is incomplete, so a direct path to this transitive package could not be established.');
    if (symbols.length === 0) limitation.push('OSV did not provide a supported affected-symbol field for this npm advisory.');
    result.set(dependency.purl, {
      state,
      symbolCoverage,
      symbols,
      importEvidence: imports,
      symbolEvidence,
      dependencyPath: path,
      limitation: [...new Set(limitation)].slice(0, 10),
    });
  }
  return result;
}
