import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelative = 'packages/diana-core/src/core/eventTypes.ts';
const sourcePath = resolve(root, sourceRelative);
const outputDirectory = resolve(root, 'contracts/diana-event');
const jsonPath = resolve(outputDirectory, 'contract.json');
const declarationPath = resolve(outputDirectory, 'index.d.ts');
const check = process.argv.includes('--check');

const source = readFileSync(sourcePath, 'utf8');
const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
);

function exportedVariable(name) {
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const exported = statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        );
        if (!exported) continue;
        const declaration = statement.declarationList.declarations.find(
            (candidate) =>
                ts.isIdentifier(candidate.name) && candidate.name.text === name
        );
        if (declaration) return declaration.initializer;
    }
    throw new Error(`Could not find exported ${name} in ${sourceRelative}`);
}

function unwrapConstAssertion(expression) {
    return ts.isAsExpression(expression) ? expression.expression : expression;
}

const versionExpression = unwrapConstAssertion(
    exportedVariable('DIANA_EVENT_SCHEMA_VERSION')
);
if (!ts.isNumericLiteral(versionExpression)) {
    throw new Error('DIANA_EVENT_SCHEMA_VERSION must be a numeric literal');
}
const schemaVersion = Number(versionExpression.text);

const typesExpression = unwrapConstAssertion(exportedVariable('DIANA_EVENT_TYPES'));
if (!ts.isArrayLiteralExpression(typesExpression)) {
    throw new Error('DIANA_EVENT_TYPES must be an array literal');
}
const eventTypes = typesExpression.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
        throw new Error('DIANA_EVENT_TYPES may contain only string literals');
    }
    return element.text;
});

if (eventTypes.length === 0 || new Set(eventTypes).size !== eventTypes.length) {
    throw new Error('DIANA_EVENT_TYPES must be non-empty and unique');
}

const sourceSha256 = createHash('sha256').update(source).digest('hex');
const prettierConfig = (await prettier.resolveConfig(jsonPath)) ?? {};
const contract = await prettier.format(
    JSON.stringify({
        schemaVersion,
        eventTypes,
        source: sourceRelative,
        sourceSha256,
    }),
    { ...prettierConfig, parser: 'json' }
);

const configPath = resolve(root, 'packages/diana-core/tsconfig.json');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
}
const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    {
        declaration: true,
        declarationMap: false,
        emitDeclarationOnly: true,
        composite: false,
        noEmit: false,
    },
    configPath
);
const program = ts.createProgram([sourcePath], parsed.options);
let declaration = null;
const emit = program.emit(undefined, (fileName, data) => {
    if (fileName.endsWith('eventTypes.d.ts')) declaration = data;
});
const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emit.diagnostics)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (diagnostics.length > 0) {
    throw new Error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: (fileName) => fileName,
            getCurrentDirectory: () => root,
            getNewLine: () => '\n',
        })
    );
}
if (declaration === null) {
    throw new Error('TypeScript did not emit the Diana event declaration');
}
declaration = `// Generated from ${sourceRelative}; do not edit.\n// Source SHA-256: ${sourceSha256}\n${declaration}`;
declaration = await prettier.format(declaration, {
    ...prettierConfig,
    parser: 'typescript',
});

function update(path, expected) {
    if (check) {
        let actual = '';
        try {
            actual = readFileSync(path, 'utf8');
        } catch {
            throw new Error(`${path} is missing; run npm run contract:generate`);
        }
        if (actual !== expected) {
            throw new Error(`${path} is stale; run npm run contract:generate`);
        }
        return;
    }
    writeFileSync(path, expected);
}

update(jsonPath, contract);
update(declarationPath, declaration);

console.log(
    check
        ? `Diana event contract v${schemaVersion} is fresh.`
        : `Generated Diana event contract v${schemaVersion}.`
);
