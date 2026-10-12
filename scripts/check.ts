import * as ts from "typescript";

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
if (!configPath) throw new Error("tsconfig.json is missing. Restore it from the repository.");
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, process.cwd(), { noEmit: true });
const program = ts.createProgram(config.fileNames, config.options);
const diagnostics = [loaded.error, ...config.errors, ...ts.getPreEmitDiagnostics(program)].filter((item): item is ts.Diagnostic => item !== undefined);
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: filename => filename,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else console.log("Type check passed.");
