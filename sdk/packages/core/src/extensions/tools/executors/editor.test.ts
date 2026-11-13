import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createEditorExecutor } from "./editor";

const context = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
};

async function withTempFile(
	content: string,
	run: (filePath: string, dir: string) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
	const filePath = path.join(dir, "example.txt");
	await fs.writeFile(filePath, content, "utf-8");
	try {
		await run(filePath, dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("createEditorExecutor", () => {
	it("creates a missing file when edit is used", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
		const filePath = path.join(dir, "example.txt");

		try {
			const editor = createEditorExecutor();
			const result = await editor(
				{
					path: filePath,
					new_text: "created with edit",
				},
				dir,
				{
					agentId: "agent-1",
					conversationId: "conv-1",
					iteration: 1,
				},
			);

			expect(result).toBe(`File created successfully at: ${filePath}`);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"created with edit",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("inserts before a one-based line and appends at the EOF boundary", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
		const filePath = path.join(dir, "example.txt");
		await fs.writeFile(filePath, "one\ntwo", "utf-8");

		try {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					new_text: "inserted",
					insert_line: 2,
				},
				dir,
				{
					agentId: "agent-1",
					conversationId: "conv-1",
					iteration: 1,
				},
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"one\ninserted\ntwo",
			);

			await editor(
				{
					path: filePath,
					new_text: "tail",
					insert_line: 4,
				},
				dir,
				{
					agentId: "agent-1",
					conversationId: "conv-1",
					iteration: 1,
				},
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"one\ninserted\ntwo\ntail",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("emits a minimal diff for an in-place single-line edit", async () => {
		await withTempFile("a\nb\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, old_text: "b", new_text: "B" },
				dir,
				context,
			);

			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-2: b\n+2: B\n\`\`\``,
			);
		});
	});

	it("only emits the changed region when the edit changes the line count", async () => {
		await withTempFile("a\nb\nc\nd\ne\nf", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, old_text: "b\nc\nd", new_text: "B" },
				dir,
				context,
			);

			// The trailing unchanged lines (e, f) must not be mispaired into
			// the diff even though their positions shifted.
			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-2: b\n-3: c\n-4: d\n+2: B\n\`\`\``,
			);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nB\ne\nf");
		});
	});

	it("emits only additions for a pure insertion via str_replace", async () => {
		await withTempFile("a\nb\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, old_text: "a\nb", new_text: "a\nnew\nb" },
				dir,
				context,
			);

			expect(result).toBe(`Edited ${filePath}\n\`\`\`diff\n+2: new\n\`\`\``);
		});
	});

	it("truncates long diffs at maxDiffLines while keeping both sides visible", async () => {
		const oldLines = Array.from({ length: 10 }, (_, i) => `old-${i}`);
		await withTempFile(oldLines.join("\n"), async (filePath, dir) => {
			const editor = createEditorExecutor({ maxDiffLines: 3 });
			const result = await editor(
				{
					path: filePath,
					old_text: oldLines.join("\n"),
					new_text: "replaced",
				},
				dir,
				context,
			);

			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-1: old-0\n-2: old-1\n+1: replaced\n... diff truncated (8 more removed, 0 more added lines) ...\n\`\`\``,
			);
		});
	});

	it("does not drop additions when removals alone exhaust maxDiffLines", async () => {
		const oldLines = Array.from({ length: 6 }, (_, i) => `old-${i}`);
		const newLines = Array.from({ length: 4 }, (_, i) => `new-${i}`);
		await withTempFile(oldLines.join("\n"), async (filePath, dir) => {
			const editor = createEditorExecutor({ maxDiffLines: 6 });
			const result = await editor(
				{
					path: filePath,
					old_text: oldLines.join("\n"),
					new_text: newLines.join("\n"),
				},
				dir,
				context,
			);

			// Budget splits 3/3 instead of removals consuming all 6 lines and
			// reporting +0 additions.
			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-1: old-0\n-2: old-1\n-3: old-2\n+1: new-0\n+2: new-1\n+3: new-2\n... diff truncated (3 more removed, 1 more added lines) ...\n\`\`\``,
			);
		});
	});

	it("preserves CRLF line endings when inserting LF-only text into a CRLF file", async () => {
		await withTempFile("one\r\ntwo\r\nthree", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					new_text: "first\nsecond",
					insert_line: 2,
				},
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"one\r\nfirst\r\nsecond\r\ntwo\r\nthree",
			);
		});
	});

	it("replaces multi-line LF old_text in a CRLF file and keeps CRLF endings", async () => {
		await withTempFile("a\r\nb\r\nc\r\nd", async (filePath, dir) => {
			const editor = createEditorExecutor();
			// Reads strip "\r", so the model round-trips LF-only text even
			// though the file on disk is CRLF.
			const result = await editor(
				{ path: filePath, old_text: "b\nc", new_text: "B\nC\nX" },
				dir,
				context,
			);

			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-2: b\n-3: c\n+2: B\n+3: C\n+4: X\n\`\`\``,
			);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"a\r\nB\r\nC\r\nX\r\nd",
			);
		});
	});

	// The CRLF branch is exercised for real by Windows CI, where os.EOL is
	// "\r\n" (github.com/cline/cline/issues/13504).
	it("creates new files with the platform-native line ending", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
		const filePath = path.join(dir, "fresh.txt");

		try {
			const editor = createEditorExecutor();
			await editor(
				{ path: filePath, new_text: "one\ntwo\nthree" },
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				["one", "two", "three"].join(os.EOL),
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("replaces text in a pure-LF file without introducing CRLF", async () => {
		await withTempFile("a\nb\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{ path: filePath, old_text: "b\nc", new_text: "B\r\nC" },
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nB\nC");
		});
	});

	it("inserts $-sequences in new_text literally", async () => {
		await withTempFile("a\nb\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					old_text: "b",
					new_text: "cost=$100 pid=$$ match=$& rest=$'",
				},
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"a\ncost=$100 pid=$$ match=$& rest=$'\nc",
			);
		});
	});

	it("rejects insert_line 0 with the valid one-based boundary range", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
		const filePath = path.join(dir, "example.txt");
		await fs.writeFile(filePath, "one\ntwo", "utf-8");

		try {
			const editor = createEditorExecutor();

			await expect(
				editor(
					{
						path: filePath,
						new_text: "invalid",
						insert_line: 0,
					},
					dir,
					{
						agentId: "agent-1",
						conversationId: "conv-1",
						iteration: 1,
					},
				),
			).rejects.toThrow(
				"Invalid insert_line: 0. insert_line must be a positive one-based boundary line in the range 1-3. Use 3 to append at EOF.",
			);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("one\ntwo");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("whitespace-tolerant editor matching", () => {
	it("applies an unambiguous indentation-only match and reports the fallback", async () => {
		await withTempFile(
			"function f() {\n  return 1;\n}\n",
			async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{
						path: filePath,
						old_text: "    return 1;",
						new_text: "  return 2;",
					},
					dir,
					context,
				);

				expect(result).toContain(
					"NOTE: old_text matched ignoring leading whitespace (indentation)",
				);
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"function f() {\n  return 2;\n}\n",
				);
			},
		);
	});

	it("ignores trailing whitespace on every line of a multi-line match", async () => {
		await withTempFile("alpha  \nbeta\n", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, old_text: "alpha\nbeta", new_text: "ALPHA\nBETA" },
				dir,
				context,
			);

			expect(result).toContain(
				"NOTE: old_text matched ignoring trailing whitespace",
			);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"ALPHA\nBETA\n",
			);
		});
	});

	it("keeps CRLF endings when the fallback matches line windows", async () => {
		await withTempFile("a \r\nb\r\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{ path: filePath, old_text: "a\nb", new_text: "A\nB" },
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("A\r\nB\r\nc");
		});
	});

	it("rejects an ambiguous exact match with candidate lines and the occurrence hint", async () => {
		await withTempFile("x\nx\nx", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await expect(
				editor({ path: filePath, old_text: "x", new_text: "Y" }, dir, context),
			).rejects.toThrow(/multiple occurrences of text found/);
			await expect(
				editor({ path: filePath, old_text: "x", new_text: "Y" }, dir, context),
			).rejects.toThrow(/occurrence: N/);
			await expect(
				editor({ path: filePath, old_text: "x", new_text: "Y" }, dir, context),
			).rejects.toThrow(/match 1\/3 -- lines 1-1 \(exact\)/);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("x\nx\nx");
		});
	});

	it("replaces the occurrence picked from the candidate list", async () => {
		await withTempFile("x\nx\nx", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, old_text: "x", new_text: "Y", occurrence: 2 },
				dir,
				context,
			);

			expect(result).toContain("NOTE: replaced match 2 of 3");
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("x\nY\nx");
		});
	});

	it("adds a closest-line hint when the text is absent", async () => {
		await withTempFile("alpha beta gamma\n", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await expect(
				editor(
					{ path: filePath, old_text: "alpha delta", new_text: "x" },
					dir,
					context,
				),
			).rejects.toThrow(/line closest to old_text is line 1/);
		});
	});

	it("treats an empty old_text as not found", async () => {
		await withTempFile("alpha\n", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await expect(
				editor({ path: filePath, old_text: "", new_text: "x" }, dir, context),
			).rejects.toThrow(/text not found/);
		});
	});
});
