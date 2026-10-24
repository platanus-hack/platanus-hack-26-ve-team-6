import ts from 'typescript';
import { CUSTOMER_MAX_SOURCE_FILE_BYTES } from '@gotchu/contracts';

export const HELMET_CSP_GATE_VERSION = 'helmet-csp-ast-gate-v1';
export const HELMET_CSP_TYPESCRIPT_VERSION = ts.version;

const candidateRuleIds = new Set([
  'gotchu.javascript.helmet-csp-disabled',
  'profile.gotchu.javascript.helmet-csp-disabled',
]);

export function isHelmetCspCandidateRule(ruleId: string): boolean {
  return candidateRuleIds.has(ruleId);
}

interface SourceFileInput {
  path: string;
  content: string;
}

interface ParsedHelmetFile {
  calls: Array<{ offset: number; line: number; column: number; linePrefix: string }>;
}

function scriptKind(path: string): ts.ScriptKind {
  return /\.tsx$/i.test(path) ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX
      : /\.[cm]?ts$/i.test(path) ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function declarationBindsName(node: ts.Node, name: string): boolean {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
    return bindingNames(node.name).includes(name);
  }
  if (ts.isImportClause(node)) return node.name?.text === name;
  if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)
    || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isClassDeclaration(node) || ts.isClassExpression(node)
    || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)
    || ts.isTypeParameterDeclaration(node)) {
    return node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name;
  }
  return false;
}

function isBindingConflictOrMutation(sourceFile: ts.SourceFile, importedName: string, importClause: ts.ImportClause): boolean {
  let conflict = false;

  const targetReferencesImportedName = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === importedName;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return targetReferencesImportedName(node.expression);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
      return targetReferencesImportedName(node.expression);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.some(element => !ts.isOmittedExpression(element) && targetReferencesImportedName(element));
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some(property => {
        if (ts.isShorthandPropertyAssignment(property)) return property.name.text === importedName;
        if (ts.isPropertyAssignment(property)) return targetReferencesImportedName(property.initializer);
        if (ts.isSpreadAssignment(property)) return targetReferencesImportedName(property.expression);
        return false;
      });
    }
    if (ts.isSpreadElement(node)) return targetReferencesImportedName(node.expression);
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (declarationBindsName(node, importedName) && node !== importClause) conflict = true;
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && targetReferencesImportedName(node.left)) conflict = true;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && targetReferencesImportedName(node.operand)) conflict = true;
    if (ts.isDeleteExpression(node) && targetReferencesImportedName(node.expression)) conflict = true;
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && targetReferencesImportedName(node.initializer)) conflict = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return conflict;
}

function isCandidateBoundary(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isBlock(node)
    || ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node)
    || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
    || ts.isSwitchStatement(node) || ts.isTryStatement(node) || ts.isWithStatement(node);
}

function hasOnlyDisabledCspOption(call: ts.CallExpression): boolean {
  if (call.questionDotToken || call.typeArguments?.length || call.arguments.length !== 1) return false;
  const argument = call.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument) || argument.properties.length !== 1) return false;
  const [property] = argument.properties;
  return property !== undefined
    && ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    && property.name.text === 'contentSecurityPolicy'
    && property.initializer.kind === ts.SyntaxKind.FalseKeyword;
}

function hasParseErrors(sourceFile: ts.SourceFile): boolean {
  // The runtime SourceFile includes parser diagnostics although the public type omits the field.
  if (!('parseDiagnostics' in sourceFile)) return true;
  const diagnostics: unknown = sourceFile.parseDiagnostics;
  if (!Array.isArray(diagnostics)) return true;
  return diagnostics.some((diagnostic: unknown) => {
    if (typeof diagnostic !== 'object' || diagnostic === null || !('category' in diagnostic)
      || typeof diagnostic.category !== 'number') return true;
    return diagnostic.category === ts.DiagnosticCategory.Error;
  });
}

function parseHelmetFile(file: SourceFileInput): ParsedHelmetFile | undefined {
  if (Buffer.byteLength(file.content, 'utf8') > CUSTOMER_MAX_SOURCE_FILE_BYTES) return undefined;
  const sourceFile = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind(file.path));
  if (hasParseErrors(sourceFile)) return undefined;

  const helmetDefaultImports = sourceFile.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'helmet' || !statement.importClause?.name) return [];
    return [{ clause: statement.importClause, name: statement.importClause.name.text }];
  });
  if (helmetDefaultImports.length !== 1) return undefined;
  const imported = helmetDefaultImports[0];
  if (!imported || imported.clause.isTypeOnly || isBindingConflictOrMutation(sourceFile, imported.name, imported.clause)) return undefined;

  const calls: ParsedHelmetFile['calls'] = [];
  const visitExpression = (node: ts.Node): void => {
    if (isCandidateBoundary(node)) return;
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === imported.name
      && hasOnlyDisabledCspOption(node)) {
      const start = node.getStart(sourceFile);
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      const lineStart = sourceFile.getPositionOfLineAndCharacter(position.line, 0);
      calls.push({
        offset: Buffer.byteLength(file.content.slice(0, start), 'utf8'),
        line: position.line + 1,
        column: position.character + 1,
        linePrefix: file.content.slice(lineStart, start),
      });
    }
    ts.forEachChild(node, visitExpression);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement)) visitExpression(statement.expression);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer) visitExpression(declaration.initializer);
      }
    }
  }
  return { calls };
}

/** Caches one bounded parse per source path for a single internal assessment. */
export function createHelmetCspGate(files: readonly SourceFileInput[]) {
  const byPath = new Map(files.map(file => [file.path, file]));
  const parsedByPath = new Map<string, ParsedHelmetFile | null>();

  return (path: string, semgrepByteOffset: number | undefined, semgrepLine: number, semgrepColumn?: number): boolean => {
    if (!Number.isSafeInteger(semgrepByteOffset) || semgrepByteOffset === undefined || semgrepByteOffset < 0) return false;
    const file = byPath.get(path);
    if (!file) return false;
    if (!parsedByPath.has(path)) parsedByPath.set(path, parseHelmetFile(file) ?? null);
    const parsed = parsedByPath.get(path);
    if (!parsed) return false;
    const matches = parsed.calls.filter(call => call.offset === semgrepByteOffset);
    if (matches.length !== 1) return false;
    const call = matches[0];
    if (!call || call.line !== semgrepLine) return false;
    if (semgrepColumn !== undefined) {
      if (/[^\x00-\x7f]/.test(call.linePrefix) || call.column !== semgrepColumn) return false;
    }
    return true;
  };
}
