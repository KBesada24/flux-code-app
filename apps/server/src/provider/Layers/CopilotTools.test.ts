import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it } from "vitest";

import { executeCopilotTool } from "./CopilotTools.ts";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-tools-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFile(rootDir: string, relativePath: string, contents: string | Buffer) {
  const absolutePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
  return absolutePath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("CopilotTools", () => {
  describe("read_file", () => {
    it("reads line-numbered content from line 1 by default and shows a continuation hint", async () => {
      const cwd = await makeWorkspace();
      await writeFile(cwd, "src/example.ts", ["one", "two", "three"].join("\n"));

      const result = await executeCopilotTool(cwd, "read_file", {
        path: "src/example.ts",
        limit: 2,
      });

      assert.equal(result.ok, true);
      assert.equal(result.summary, "Read src/example.ts lines 1-2");
      assert.match(result.output, /<path>src\/example\.ts<\/path>/u);
      assert.match(result.output, /1: one/u);
      assert.match(result.output, /2: two/u);
      assert.match(result.output, /Use offset=3 to continue\./u);
    });

    it("reads from an offset, preserves numbering, and rejects escape paths", async () => {
      const cwd = await makeWorkspace();
      await writeFile(cwd, "src/example.ts", ["a", "b", "c", "d"].join("\n"));

      const result = await executeCopilotTool(cwd, "read_file", {
        path: "src/example.ts",
        offset: 3,
        limit: 2,
      });
      const escaped = await executeCopilotTool(cwd, "read_file", {
        path: "../outside.txt",
      });

      assert.equal(result.ok, true);
      assert.equal(result.summary, "Read src/example.ts lines 3-4");
      assert.match(result.output, /3: c/u);
      assert.match(result.output, /4: d/u);
      assert.equal(escaped.ok, false);
      assert.match(escaped.output, /outside the working directory/u);
    });

    it("errors on missing or oversized files", async () => {
      const cwd = await makeWorkspace();
      await writeFile(cwd, "large.txt", "x".repeat(500_001));

      const missing = await executeCopilotTool(cwd, "read_file", {
        path: "missing.txt",
      });
      const oversized = await executeCopilotTool(cwd, "read_file", {
        path: "large.txt",
      });

      assert.equal(missing.ok, false);
      assert.match(missing.output, /ENOENT/u);
      assert.equal(oversized.ok, false);
      assert.match(oversized.output, /byte limit/u);
    });
  });

  describe("glob_files", () => {
    it("finds files by pattern, respects base path, and skips ignored directories", async () => {
      const cwd = await makeWorkspace();
      await writeFile(cwd, "src/a.ts", "export const a = 1;\n");
      await writeFile(cwd, "src/nested/b.ts", "export const b = 2;\n");
      await writeFile(cwd, "dist/ignored.ts", "ignored\n");

      const result = await executeCopilotTool(cwd, "glob_files", {
        pattern: "**/*.ts",
        path: "src",
      });

      assert.equal(result.ok, true);
      assert.equal(result.summary, "Found 2 matching files");
      assert.match(result.output, /src\/a\.ts/u);
      assert.match(result.output, /src\/nested\/b\.ts/u);
      assert.doesNotMatch(result.output, /dist\/ignored\.ts/u);
    });

    it("caps results and rejects escape paths", async () => {
      const cwd = await makeWorkspace();
      for (let index = 0; index < 205; index += 1) {
        await writeFile(cwd, `src/file-${index}.ts`, `export const value${index} = ${index};\n`);
      }

      const capped = await executeCopilotTool(cwd, "glob_files", {
        pattern: "*.ts",
        path: "src",
      });
      const escaped = await executeCopilotTool(cwd, "glob_files", {
        pattern: "*.ts",
        path: "../outside",
      });

      assert.equal(capped.ok, true);
      assert.equal(capped.summary, "Found 200 matching files");
      assert.match(capped.output, /Results were truncated\./u);
      assert.equal(escaped.ok, false);
      assert.match(escaped.output, /outside the working directory/u);
    });
  });

  describe("grep_content", () => {
    it("returns file:line snippets, respects case sensitivity and base paths, and skips ignored directories", async () => {
      const cwd = await makeWorkspace();
      await writeFile(cwd, "src/alpha.ts", "ProviderService\nproviderService\n");
      await writeFile(cwd, "src/beta.ts", "ProviderService\n");
      await writeFile(cwd, "dist/ignored.ts", "ProviderService\n");

      const insensitive = await executeCopilotTool(cwd, "grep_content", {
        pattern: "providerservice",
        path: "src",
      });
      const sensitive = await executeCopilotTool(cwd, "grep_content", {
        pattern: "providerService",
        path: "src",
        case_sensitive: true,
      });

      assert.equal(insensitive.ok, true);
      assert.equal(insensitive.summary, 'Found 3 matches for "providerservice"');
      assert.match(insensitive.output, /src\/alpha\.ts:1: ProviderService/u);
      assert.match(insensitive.output, /src\/alpha\.ts:2: providerService/u);
      assert.match(insensitive.output, /src\/beta\.ts:1: ProviderService/u);
      assert.doesNotMatch(insensitive.output, /dist\/ignored\.ts/u);

      assert.equal(sensitive.ok, true);
      assert.equal(sensitive.summary, 'Found 1 matches for "providerService"');
      assert.match(sensitive.output, /src\/alpha\.ts:2: providerService/u);
      assert.doesNotMatch(sensitive.output, /src\/alpha\.ts:1: ProviderService/u);
    });

    it("caps matches, caps scanned files, skips non-text files, and rejects escape paths", async () => {
      const cwd = await makeWorkspace();
      await writeFile(cwd, "src/image.bin", Buffer.from([0, 159, 146, 150]));
      for (let index = 0; index < 55; index += 1) {
        await writeFile(cwd, `src/match-${index}.ts`, `const target = ${index};\n`);
      }
      for (let index = 0; index < 505; index += 1) {
        await writeFile(cwd, `scan-limit/file-${index}.ts`, `const miss${index} = ${index};\n`);
      }

      const capped = await executeCopilotTool(cwd, "grep_content", {
        pattern: "target",
        path: "src",
      });
      const scanLimited = await executeCopilotTool(cwd, "grep_content", {
        pattern: "999",
        path: "scan-limit",
      });
      const escaped = await executeCopilotTool(cwd, "grep_content", {
        pattern: "target",
        path: "../outside",
      });

      assert.equal(capped.ok, true);
      assert.equal(capped.summary, 'Found 50 matches for "target"');
      assert.match(capped.output, /Stopped after reaching the match limit\./u);
      assert.doesNotMatch(capped.output, /image\.bin/u);

      assert.equal(scanLimited.ok, true);
      assert.equal(scanLimited.summary, 'Found 0 matches for "999"');
      assert.match(scanLimited.output, /No matches found for "999"\. Stopped after reaching the file scan limit\./u);
      assert.equal(escaped.ok, false);
      assert.match(escaped.output, /outside the working directory/u);
    });
  });

  describe("edit_file", () => {
    it("replaces a unique match and reports the file change", async () => {
      const cwd = await makeWorkspace();
      const filePath = path.join(cwd, "src/example.ts");
      await writeFile(cwd, "src/example.ts", "const value = 1;\nconst other = 2;\n");

      const result = await executeCopilotTool(cwd, "edit_file", {
        path: "src/example.ts",
        old_string: "const value = 1;",
        new_string: "const value = 3;",
      });

      assert.equal(result.ok, true);
      assert.equal(result.summary, "Edited src/example.ts (1 replacement)");
      assert.equal(result.fileChangePath, "src/example.ts");
      assert.match(result.output, /<replacements>1<\/replacements>/u);
      assert.equal(await fs.readFile(filePath, "utf8"), "const value = 3;\nconst other = 2;\n");
    });

    it("errors on missing text, ambiguous matches, directory paths, identical replacements, and escape paths", async () => {
      const cwd = await makeWorkspace();
      await writeFile(cwd, "src/example.ts", "repeat\nrepeat\n");
      await fs.mkdir(path.join(cwd, "src/folder"), { recursive: true });

      const missing = await executeCopilotTool(cwd, "edit_file", {
        path: "src/example.ts",
        old_string: "nope",
        new_string: "yep",
      });
      const ambiguous = await executeCopilotTool(cwd, "edit_file", {
        path: "src/example.ts",
        old_string: "repeat",
        new_string: "done",
      });
      const directory = await executeCopilotTool(cwd, "edit_file", {
        path: "src/folder",
        old_string: "a",
        new_string: "b",
      });
      const identical = await executeCopilotTool(cwd, "edit_file", {
        path: "src/example.ts",
        old_string: "repeat",
        new_string: "repeat",
      });
      const escaped = await executeCopilotTool(cwd, "edit_file", {
        path: "../outside.ts",
        old_string: "a",
        new_string: "b",
      });

      assert.equal(missing.ok, false);
      assert.match(missing.output, /Could not find the requested text/u);
      assert.equal(ambiguous.ok, false);
      assert.match(ambiguous.output, /set replace_all=true/u);
      assert.equal(directory.ok, false);
      assert.match(directory.output, /not a file/u);
      assert.equal(identical.ok, false);
      assert.match(identical.output, /must differ/u);
      assert.equal(escaped.ok, false);
      assert.match(escaped.output, /outside the working directory/u);
    });

    it("replaces all matches when requested and preserves CRLF newlines", async () => {
      const cwd = await makeWorkspace();
      const filePath = path.join(cwd, "src/windows.ts");
      await writeFile(cwd, "src/windows.ts", "const a = 1;\r\nconst a = 1;\r\n");

      const result = await executeCopilotTool(cwd, "edit_file", {
        path: "src/windows.ts",
        old_string: "const a = 1;\n",
        new_string: "const a = 2;\n",
        replace_all: true,
      });

      assert.equal(result.ok, true);
      assert.equal(result.summary, "Edited src/windows.ts (2 replacements)");
      assert.equal(await fs.readFile(filePath, "utf8"), "const a = 2;\r\nconst a = 2;\r\n");
    });
  });

  describe("write_file", () => {
    it("writes new files, overwrites existing files, and rejects escape paths", async () => {
      const cwd = await makeWorkspace();
      const filePath = path.join(cwd, "src/new-file.ts");

      const created = await executeCopilotTool(cwd, "write_file", {
        path: "src/new-file.ts",
        content: "export const value = 1;\n",
      });
      const overwritten = await executeCopilotTool(cwd, "write_file", {
        path: "src/new-file.ts",
        content: "export const value = 2;\n",
      });
      const escaped = await executeCopilotTool(cwd, "write_file", {
        path: "../outside.ts",
        content: "nope\n",
      });

      assert.equal(created.ok, true);
      assert.equal(created.summary, "Wrote src/new-file.ts");
      assert.equal(created.fileChangePath, "src/new-file.ts");
      assert.equal(overwritten.ok, true);
      assert.equal(await fs.readFile(filePath, "utf8"), "export const value = 2;\n");
      assert.equal(escaped.ok, false);
      assert.match(escaped.output, /outside the working directory/u);
    });
  });
});
