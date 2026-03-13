/**
 * CopilotTools - Lean local coding tools for the GitHub Copilot adapter.
 *
 * Provides OpenAI-compatible tool schemas and deterministic filesystem tool
 * execution within the active working directory.
 *
 * @module CopilotTools
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type OpenAIToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

export type CopilotToolExecutionResult = {
  readonly title: string;
  readonly output: string;
  readonly summary: string;
  readonly ok: boolean;
  readonly fileChangePath?: string;
};

type CopilotToolHandler = {
  readonly name: string;
  readonly title: string;
  readonly definition: OpenAIToolDefinition;
  readonly execute: (cwd: string, args: unknown) => Promise<CopilotToolExecutionResult>;
};

type EntryCollectionState = {
  entries: string[];
  truncated: boolean;
};

type GlobCollectionState = {
  matches: string[];
  truncated: boolean;
};

type GrepCollectionState = {
  matches: string[];
  filesScanned: number;
  hitResultLimit: boolean;
  hitScanLimit: boolean;
};

const MAX_FILE_BYTES = 500_000;
const DEFAULT_READ_OFFSET = 1;
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 400;
const MAX_READ_OUTPUT_BYTES = 40_000;
const MAX_DISPLAY_LINE_LENGTH = 400;
const MAX_LIST_ENTRIES = 500;
const MAX_DEPTH = 8;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_FILES = 500;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  "coverage",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".md",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".xml",
  ".svg",
]);

const TEXT_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".prettierignore",
  ".eslintignore",
  "dockerfile",
  "makefile",
  "justfile",
]);

function buildToolDefinition(input: {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
}): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name: input.name,
      description: input.description,
      parameters: {
        type: "object",
        properties: input.properties,
        ...(input.required && input.required.length > 0 ? { required: input.required } : {}),
      },
    },
  };
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function relativePathFrom(baseDir: string, target: string): string {
  const relative = path.relative(path.resolve(baseDir), target);
  return relative === "" ? "." : toPosixPath(relative);
}

function formatDirectorySummaryLabel(relativePath: string): string {
  if (relativePath === ".") {
    return "working directory";
  }
  return relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
}

function toolSuccess(
  title: string,
  output: string,
  summary: string,
  extra?: Pick<CopilotToolExecutionResult, "fileChangePath">,
): CopilotToolExecutionResult {
  return {
    title,
    output,
    summary,
    ok: true,
    ...(extra?.fileChangePath ? { fileChangePath: extra.fileChangePath } : {}),
  };
}

function toolError(title: string, summary: string, output?: string): CopilotToolExecutionResult {
  const formatted = output ?? `Error: ${summary}`;
  return {
    title,
    output: formatted.startsWith("Error:") ? formatted : `Error: ${formatted}`,
    summary,
    ok: false,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateForDisplay(value: string, maxLength = MAX_DISPLAY_LINE_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
): number | CopilotToolExecutionResult {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return toolError("Validation", `${label} must be a positive integer.`);
  }
  return value;
}

function splitFileLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;
  while (true) {
    const nextIndex = content.indexOf(search, startIndex);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    startIndex = nextIndex + search.length;
  }
}

function detectNewlineStyle(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeNewlines(content: string, newlineStyle: "\n" | "\r\n"): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return newlineStyle === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

function isTextLikeFile(filePath: string): boolean {
  const baseName = path.basename(filePath).toLowerCase();
  if (TEXT_BASENAMES.has(baseName)) {
    return true;
  }
  const extension = path.extname(baseName);
  return TEXT_EXTENSIONS.has(extension);
}

function isLikelyTextBuffer(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8_192);
  let suspiciousBytes = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    const value = buffer[index] ?? 0;
    if (value === 0) {
      return false;
    }
    if (
      value < 0x20 &&
      value !== 0x09 &&
      value !== 0x0a &&
      value !== 0x0d &&
      value !== 0x0c
    ) {
      suspiciousBytes += 1;
    }
  }
  return suspiciousBytes / Math.max(sampleSize, 1) < 0.3;
}

async function readTextFile(filePath: string): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`'${path.basename(filePath)}' is not a file.`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `File exceeds ${MAX_FILE_BYTES} byte limit (file size: ${stat.size} bytes).`,
    );
  }

  const buffer = await fs.promises.readFile(filePath);
  if (!isLikelyTextBuffer(buffer)) {
    throw new Error("File does not appear to be text.");
  }
  return buffer.toString("utf-8");
}

function shouldSkipDirectory(dirName: string): boolean {
  return SKIP_DIRS.has(dirName);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function buildGlobRegex(pattern: string): RegExp {
  const normalized = toPosixPath(pattern).replace(/^\.\/+/u, "");
  let regexSource = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";

    if (current === "*" && next === "*") {
      const afterNext = normalized[index + 2] ?? "";
      if (afterNext === "/") {
        regexSource += "(?:.*/)?";
        index += 2;
      } else {
        regexSource += ".*";
        index += 1;
      }
      continue;
    }

    if (current === "*") {
      regexSource += "[^/]*";
      continue;
    }

    if (current === "?") {
      regexSource += "[^/]";
      continue;
    }

    regexSource += escapeRegex(current);
  }

  regexSource += "$";
  return new RegExp(regexSource);
}

function createGlobMatcher(pattern: string) {
  const normalizedPattern = toPosixPath(pattern).trim();
  const matcher = buildGlobRegex(normalizedPattern);
  const matchesPath = normalizedPattern.includes("/");

  return (cwdRelativePath: string, baseRelativePath: string): boolean => {
    if (matchesPath) {
      return matcher.test(cwdRelativePath) || matcher.test(baseRelativePath);
    }
    return matcher.test(path.posix.basename(cwdRelativePath)) || matcher.test(cwdRelativePath);
  };
}

async function collectDirectoryEntries(
  rootDir: string,
  dir: string,
  recursive: boolean,
  depth: number,
  state: EntryCollectionState,
): Promise<void> {
  if (state.truncated || depth > MAX_DEPTH) {
    return;
  }

  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (state.entries.length >= MAX_LIST_ENTRIES) {
      state.truncated = true;
      return;
    }

    if (dirent.isDirectory() && shouldSkipDirectory(dirent.name)) {
      continue;
    }

    const absolutePath = path.join(dir, dirent.name);
    const relativePath = relativePathFrom(rootDir, absolutePath);
    state.entries.push(dirent.isDirectory() ? `${relativePath}/` : relativePath);

    if (recursive && dirent.isDirectory()) {
      await collectDirectoryEntries(rootDir, absolutePath, true, depth + 1, state);
      if (state.truncated) {
        return;
      }
    }
  }
}

async function collectGlobMatches(
  cwd: string,
  basePath: string,
  target: string,
  matcher: (cwdRelativePath: string, baseRelativePath: string) => boolean,
  state: GlobCollectionState,
): Promise<void> {
  if (state.truncated) {
    return;
  }

  const stat = await fs.promises.stat(target);
  if (stat.isFile()) {
    const relativePath = relativePathFrom(cwd, target);
    const relativeToBase = relativePathFrom(basePath, target);
    if (matcher(relativePath, relativeToBase)) {
      state.matches.push(relativePath);
      if (state.matches.length >= MAX_GLOB_RESULTS) {
        state.truncated = true;
      }
    }
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  const dirents = await fs.promises.readdir(target, { withFileTypes: true });
  for (const dirent of dirents) {
    if (state.truncated) {
      return;
    }
    if (dirent.isDirectory() && shouldSkipDirectory(dirent.name)) {
      continue;
    }
    await collectGlobMatches(
      cwd,
      basePath,
      path.join(target, dirent.name),
      matcher,
      state,
    );
  }
}

async function collectGrepMatches(
  cwd: string,
  target: string,
  pattern: string,
  caseSensitive: boolean,
  state: GrepCollectionState,
): Promise<void> {
  if (state.hitResultLimit || state.hitScanLimit) {
    return;
  }

  const stat = await fs.promises.stat(target);
  if (stat.isDirectory()) {
    const dirents = await fs.promises.readdir(target, { withFileTypes: true });
    for (const dirent of dirents) {
      if (state.hitResultLimit || state.hitScanLimit) {
        return;
      }
      if (dirent.isDirectory() && shouldSkipDirectory(dirent.name)) {
        continue;
      }
      await collectGrepMatches(
        cwd,
        path.join(target, dirent.name),
        pattern,
        caseSensitive,
        state,
      );
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  if (state.filesScanned >= MAX_GREP_FILES) {
    state.hitScanLimit = true;
    return;
  }

  state.filesScanned += 1;
  if (!isTextLikeFile(target) || stat.size > MAX_FILE_BYTES) {
    return;
  }

  const buffer = await fs.promises.readFile(target);
  if (!isLikelyTextBuffer(buffer)) {
    return;
  }

  const relativePath = relativePathFrom(cwd, target);
  const content = buffer.toString("utf-8");
  const lines = splitFileLines(content);
  const needle = caseSensitive ? pattern : pattern.toLowerCase();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const haystack = caseSensitive ? line : line.toLowerCase();
    if (!haystack.includes(needle)) {
      continue;
    }

    state.matches.push(
      `${relativePath}:${index + 1}: ${truncateForDisplay(line.trimEnd())}`,
    );
    if (state.matches.length >= MAX_GREP_RESULTS) {
      state.hitResultLimit = true;
      return;
    }
  }
}

async function readFileTool(cwd: string, args: unknown): Promise<CopilotToolExecutionResult> {
  const title = "Read file";
  const input = (args as Record<string, unknown>) ?? {};
  const requestedPath = typeof input.path === "string" ? input.path : null;
  if (!requestedPath) {
    return toolError(title, "Read file failed: 'path' argument is required.");
  }

  const parsedOffset = parsePositiveInteger(input.offset, DEFAULT_READ_OFFSET, "'offset'");
  if (typeof parsedOffset !== "number") {
    return parsedOffset;
  }

  const parsedLimit = parsePositiveInteger(input.limit, DEFAULT_READ_LIMIT, "'limit'");
  if (typeof parsedLimit !== "number") {
    return parsedLimit;
  }

  const safe = safePath(cwd, requestedPath);
  if (!safe) {
    return toolError(
      title,
      `Read file failed: Path '${requestedPath}' is outside the working directory.`,
    );
  }

  const offset = parsedOffset;
  const limit = Math.min(parsedLimit, MAX_READ_LIMIT);
  const relativePath = relativePathFrom(cwd, safe);

  try {
    const content = await readTextFile(safe);
    const lines = splitFileLines(content);
    if (lines.length === 0) {
      return toolSuccess(
        title,
        `<path>${relativePath}</path>\n<content>\n</content>\n(File is empty.)`,
        `Read ${relativePath} (empty)`,
      );
    }

    if (offset > lines.length) {
      return toolError(
        title,
        `Read file failed: offset ${offset} is beyond the end of ${relativePath} (${lines.length} lines).`,
      );
    }

    const requestedEnd = Math.min(lines.length, offset + limit - 1);
    const renderedLines: string[] = [];
    let renderedEnd = offset - 1;
    let bytesUsed = 0;
    let truncatedLineCount = 0;

    for (let lineIndex = offset - 1; lineIndex < requestedEnd; lineIndex += 1) {
      const lineNumber = lineIndex + 1;
      const originalLine = lines[lineIndex] ?? "";
      const renderedLine = truncateForDisplay(originalLine);
      if (renderedLine.length !== originalLine.length) {
        truncatedLineCount += 1;
      }

      const formattedLine = `${lineNumber}: ${renderedLine}`;
      const formattedBytes = Buffer.byteLength(`${formattedLine}\n`, "utf8");
      if (renderedLines.length > 0 && bytesUsed + formattedBytes > MAX_READ_OUTPUT_BYTES) {
        break;
      }

      renderedLines.push(formattedLine);
      bytesUsed += formattedBytes;
      renderedEnd = lineNumber;
    }

    const showingStart = offset;
    const showingEnd = Math.max(renderedEnd, showingStart);
    const continuation =
      renderedEnd < requestedEnd || requestedEnd < lines.length || bytesUsed >= MAX_READ_OUTPUT_BYTES;
    const continuationHint = continuation
      ? `(Showing lines ${showingStart}-${showingEnd} of ${lines.length}. Use offset=${showingEnd + 1} to continue.)`
      : `(Showing lines ${showingStart}-${showingEnd} of ${lines.length}.)`;
    const truncationNote =
      truncatedLineCount > 0
        ? `\n(${truncatedLineCount} line${truncatedLineCount === 1 ? "" : "s"} were truncated to ${MAX_DISPLAY_LINE_LENGTH} characters.)`
        : "";

    return toolSuccess(
      title,
      `<path>${relativePath}</path>\n<content>\n${renderedLines.join("\n")}\n</content>\n${continuationHint}${truncationNote}`,
      `Read ${relativePath} lines ${showingStart}-${showingEnd}`,
    );
  } catch (error) {
    return toolError(title, `Read file failed: ${formatError(error)}`);
  }
}

async function writeFileTool(cwd: string, args: unknown): Promise<CopilotToolExecutionResult> {
  const title = "Write file";
  const input = (args as Record<string, unknown>) ?? {};
  const requestedPath = typeof input.path === "string" ? input.path : null;
  const content = typeof input.content === "string" ? input.content : null;

  if (!requestedPath) {
    return toolError(title, "Write file failed: 'path' argument is required.");
  }
  if (content === null) {
    return toolError(title, "Write file failed: 'content' argument is required.");
  }

  const safe = safePath(cwd, requestedPath);
  if (!safe) {
    return toolError(
      title,
      `Write file failed: Path '${requestedPath}' is outside the working directory.`,
    );
  }

  const relativePath = relativePathFrom(cwd, safe);

  try {
    await fs.promises.mkdir(path.dirname(safe), { recursive: true });
    await fs.promises.writeFile(safe, content, "utf-8");
    return toolSuccess(
      title,
      `<path>${relativePath}</path>\n<bytes>${Buffer.byteLength(content, "utf8")}</bytes>\n<status>wrote</status>`,
      `Wrote ${relativePath}`,
      { fileChangePath: relativePath },
    );
  } catch (error) {
    return toolError(title, `Write file failed: ${formatError(error)}`);
  }
}

async function listDirectoryTool(cwd: string, args: unknown): Promise<CopilotToolExecutionResult> {
  const title = "List directory";
  const input = (args as Record<string, unknown>) ?? {};
  const requestedPath = typeof input.path === "string" ? input.path : ".";
  const recursive = input.recursive === true;

  const safe = safePath(cwd, requestedPath);
  if (!safe) {
    return toolError(
      title,
      `List directory failed: Path '${requestedPath}' is outside the working directory.`,
    );
  }

  const relativeBasePath = relativePathFrom(cwd, safe);

  try {
    const stat = await fs.promises.stat(safe);
    if (!stat.isDirectory()) {
      return toolError(
        title,
        `List directory failed: ${relativeBasePath} is not a directory.`,
      );
    }

    const state: EntryCollectionState = { entries: [], truncated: false };
    await collectDirectoryEntries(safe, safe, recursive, 0, state);
    const summary = `Listed ${state.entries.length} entries in ${formatDirectorySummaryLabel(relativeBasePath)}`;
    const footer = state.truncated
      ? `(Showing first ${state.entries.length} entries. Listing was truncated.)`
      : `(Showing ${state.entries.length} entries.)`;

    return toolSuccess(
      title,
      `<path>${relativeBasePath}</path>\n<entries>\n${state.entries.join("\n")}\n</entries>\n${footer}`,
      summary,
    );
  } catch (error) {
    return toolError(title, `List directory failed: ${formatError(error)}`);
  }
}

async function globFilesTool(cwd: string, args: unknown): Promise<CopilotToolExecutionResult> {
  const title = "Search files";
  const input = (args as Record<string, unknown>) ?? {};
  const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
  const requestedPath = typeof input.path === "string" ? input.path : ".";

  if (pattern.length === 0) {
    return toolError(title, "Search files failed: 'pattern' argument is required.");
  }

  const safe = safePath(cwd, requestedPath);
  if (!safe) {
    return toolError(
      title,
      `Search files failed: Path '${requestedPath}' is outside the working directory.`,
    );
  }

  try {
    const matcher = createGlobMatcher(pattern);
    const state: GlobCollectionState = { matches: [], truncated: false };
    await collectGlobMatches(cwd, safe, safe, matcher, state);

    if (state.matches.length === 0) {
      return toolSuccess(
        title,
        `No files matched pattern "${pattern}".`,
        `Found 0 matching files`,
      );
    }

    const footer = state.truncated
      ? `(Showing first ${state.matches.length} matching files. Results were truncated.)`
      : `(Found ${state.matches.length} matching files.)`;

    return toolSuccess(
      title,
      `<pattern>${pattern}</pattern>\n<matches>\n${state.matches.join("\n")}\n</matches>\n${footer}`,
      `Found ${state.matches.length} matching files`,
    );
  } catch (error) {
    return toolError(title, `Search files failed: ${formatError(error)}`);
  }
}

async function grepContentTool(cwd: string, args: unknown): Promise<CopilotToolExecutionResult> {
  const title = "Search content";
  const input = (args as Record<string, unknown>) ?? {};
  const pattern = typeof input.pattern === "string" ? input.pattern : null;
  const requestedPath = typeof input.path === "string" ? input.path : ".";
  const caseSensitive = input.case_sensitive === true;

  if (!pattern) {
    return toolError(title, "Search content failed: 'pattern' argument is required.");
  }

  const safe = safePath(cwd, requestedPath);
  if (!safe) {
    return toolError(
      title,
      `Search content failed: Path '${requestedPath}' is outside the working directory.`,
    );
  }

  try {
    const state: GrepCollectionState = {
      matches: [],
      filesScanned: 0,
      hitResultLimit: false,
      hitScanLimit: false,
    };

    await collectGrepMatches(cwd, safe, pattern, caseSensitive, state);

    if (state.matches.length === 0) {
      const suffix = state.hitScanLimit ? " Stopped after reaching the file scan limit." : "";
      return toolSuccess(
        title,
        `No matches found for "${pattern}".${suffix}`,
        `Found 0 matches for "${truncateForDisplay(pattern, 48)}"`,
      );
    }

    const notes: string[] = [`Found ${state.matches.length} matches after scanning ${state.filesScanned} files.`];
    if (state.hitResultLimit) {
      notes.push("Stopped after reaching the match limit.");
    }
    if (state.hitScanLimit) {
      notes.push("Stopped after reaching the file scan limit.");
    }

    return toolSuccess(
      title,
      `<pattern>${pattern}</pattern>\n<matches>\n${state.matches.join("\n")}\n</matches>\n(${notes.join(" ")})`,
      `Found ${state.matches.length} matches for "${truncateForDisplay(pattern, 48)}"`,
    );
  } catch (error) {
    return toolError(title, `Search content failed: ${formatError(error)}`);
  }
}

async function editFileTool(cwd: string, args: unknown): Promise<CopilotToolExecutionResult> {
  const title = "Edit file";
  const input = (args as Record<string, unknown>) ?? {};
  const requestedPath = typeof input.path === "string" ? input.path : null;
  const oldString = typeof input.old_string === "string" ? input.old_string : null;
  const newString = typeof input.new_string === "string" ? input.new_string : null;
  const replaceAll = input.replace_all === true;

  if (!requestedPath) {
    return toolError(title, "Edit file failed: 'path' argument is required.");
  }
  if (oldString === null) {
    return toolError(title, "Edit file failed: 'old_string' argument is required.");
  }
  if (newString === null) {
    return toolError(title, "Edit file failed: 'new_string' argument is required.");
  }
  if (oldString.length === 0) {
    return toolError(title, "Edit file failed: 'old_string' must not be empty.");
  }

  const safe = safePath(cwd, requestedPath);
  if (!safe) {
    return toolError(
      title,
      `Edit file failed: Path '${requestedPath}' is outside the working directory.`,
    );
  }

  const relativePath = relativePathFrom(cwd, safe);

  try {
    const content = await readTextFile(safe);
    const newlineStyle = detectNewlineStyle(content);
    const normalizedOld = normalizeNewlines(oldString, newlineStyle);
    const normalizedNew = normalizeNewlines(newString, newlineStyle);

    if (normalizedOld === normalizedNew) {
      return toolError(title, "Edit file failed: 'old_string' and 'new_string' must differ.");
    }

    const matches = countOccurrences(content, normalizedOld);
    if (matches === 0) {
      return toolError(
        title,
        `Edit file failed: Could not find the requested text in ${relativePath}.`,
      );
    }

    if (!replaceAll && matches > 1) {
      return toolError(
        title,
        `Edit file failed: Found ${matches} matches in ${relativePath}; set replace_all=true or read more context first.`,
      );
    }

    const updatedContent = replaceAll
      ? content.split(normalizedOld).join(normalizedNew)
      : content.replace(normalizedOld, normalizedNew);

    await fs.promises.writeFile(safe, updatedContent, "utf-8");
    const replacements = replaceAll ? matches : 1;
    const contentLengthChanged = content.length !== updatedContent.length;

    return toolSuccess(
      title,
      `<path>${relativePath}</path>\n<replacements>${replacements}</replacements>\n<content_length_changed>${contentLengthChanged}</content_length_changed>`,
      `Edited ${relativePath} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
      { fileChangePath: relativePath },
    );
  } catch (error) {
    return toolError(title, `Edit file failed: ${formatError(error)}`);
  }
}

const COPILOT_TOOLS: readonly CopilotToolHandler[] = [
  {
    name: "read_file",
    title: "Read file",
    definition: buildToolDefinition({
      name: "read_file",
      description:
        "Read a narrow line window from an existing text file. Prefer small windows with offset and limit instead of re-reading large files.",
      properties: {
        path: {
          type: "string",
          description: "Path to a file, relative to the working directory or absolute within it.",
        },
        offset: {
          type: "integer",
          description: `Starting line number, 1-based. Defaults to ${DEFAULT_READ_OFFSET}.`,
        },
        limit: {
          type: "integer",
          description: `Maximum lines to read. Defaults to ${DEFAULT_READ_LIMIT}; hard max ${MAX_READ_LIMIT}.`,
        },
      },
      required: ["path"],
    }),
    execute: readFileTool,
  },
  {
    name: "list_directory",
    title: "List directory",
    definition: buildToolDefinition({
      name: "list_directory",
      description:
        "List files and subdirectories at a given path. Use this for quick structure checks, not deep content search.",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list. Defaults to the working directory.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively. Defaults to false.",
        },
      },
    }),
    execute: listDirectoryTool,
  },
  {
    name: "glob_files",
    title: "Search files",
    definition: buildToolDefinition({
      name: "glob_files",
      description:
        "Find files by filename or path pattern. Use this first to discover candidate files before reading them.",
      properties: {
        pattern: {
          type: "string",
          description: "Glob-like pattern such as '*.ts', '**/*.test.ts', or 'src/**/provider*.ts'.",
        },
        path: {
          type: "string",
          description: "Optional base path to search within. Defaults to the working directory.",
        },
      },
      required: ["pattern"],
    }),
    execute: globFilesTool,
  },
  {
    name: "grep_content",
    title: "Search content",
    definition: buildToolDefinition({
      name: "grep_content",
      description:
        "Search text-like source files for an exact substring and return matching file:line snippets.",
      properties: {
        pattern: {
          type: "string",
          description: "Substring to search for.",
        },
        path: {
          type: "string",
          description: "Optional file or directory path to search within. Defaults to the working directory.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether the search is case-sensitive. Defaults to false.",
        },
      },
      required: ["pattern"],
    }),
    execute: grepContentTool,
  },
  {
    name: "edit_file",
    title: "Edit file",
    definition: buildToolDefinition({
      name: "edit_file",
      description:
        "Edit an existing text file by replacing an exact old_string with new_string. Prefer this over write_file for targeted changes.",
      properties: {
        path: {
          type: "string",
          description: "Path to an existing file.",
        },
        old_string: {
          type: "string",
          description: "Exact text to replace. Read enough context first so the match is unique.",
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all matches when true. Defaults to false and requires exactly one match.",
        },
      },
      required: ["path", "old_string", "new_string"],
    }),
    execute: editFileTool,
  },
  {
    name: "write_file",
    title: "Write file",
    definition: buildToolDefinition({
      name: "write_file",
      description:
        "Create a new file or intentionally replace an entire file. Do not use this for small edits when edit_file is sufficient.",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to create or overwrite.",
        },
        content: {
          type: "string",
          description: "Full text content for the file.",
        },
      },
      required: ["path", "content"],
    }),
    execute: writeFileTool,
  },
] as const;

const COPILOT_TOOL_MAP = new Map(COPILOT_TOOLS.map((tool) => [tool.name, tool]));

export const COPILOT_TOOL_DEFINITIONS: OpenAIToolDefinition[] = COPILOT_TOOLS.map(
  (tool) => tool.definition,
);

export function getCopilotToolTitle(name: string): string {
  return COPILOT_TOOL_MAP.get(name)?.title ?? name.replaceAll("_", " ");
}

export function buildCopilotSystemPrompt(cwd: string): string {
  return [
    "You are an expert coding assistant with direct access to a sandboxed local filesystem toolset.",
    `Working directory: ${cwd}`,
    "",
    "Available tools:",
    "  - read_file(path, offset?, limit?)",
    "  - list_directory(path?, recursive?)",
    "  - glob_files(pattern, path?)",
    "  - grep_content(pattern, path?, case_sensitive?)",
    "  - edit_file(path, old_string, new_string, replace_all?)",
    "  - write_file(path, content)",
    "",
    "Tool use guidance:",
    "  - Use glob_files to discover candidate files.",
    "  - Use grep_content to find exact symbols or snippets.",
    "  - Use read_file with narrow windows before editing.",
    "  - Prefer edit_file for modifying existing files.",
    "  - Use write_file only for new files or intentional full rewrites.",
    "  - Avoid re-reading the same large file unless you need a different window.",
    "  - Keep tool usage incremental, targeted, and deterministic.",
    "",
    "All paths must stay within the working directory.",
  ].join("\n");
}

export function safePath(cwd: string, input: string): string | null {
  const normalizedCwd = path.resolve(cwd);
  const resolved = path.resolve(normalizedCwd, input);
  if (resolved !== normalizedCwd && !resolved.startsWith(`${normalizedCwd}${path.sep}`)) {
    return null;
  }
  return resolved;
}

export async function executeCopilotTool(
  cwd: string,
  name: string,
  args: unknown,
): Promise<CopilotToolExecutionResult> {
  const tool = COPILOT_TOOL_MAP.get(name);
  if (!tool) {
    return toolError("Tool", `Unknown tool '${name}'.`, `Error: Unknown tool '${name}'.`);
  }
  return tool.execute(cwd, args);
}
