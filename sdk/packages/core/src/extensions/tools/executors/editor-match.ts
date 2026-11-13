/**
 * Whitespace-tolerant matching for the editor tool.
 *
 * Models often reproduce `old_text` from memory with different indentation or
 * trailing spaces. Exact matching then fails on edits that are otherwise
 * unambiguous. This matcher keeps exact bytes first and only falls back to
 * normalized line windows when no exact occurrence exists, so a fuzzy match can
 * never shadow a real one.
 *
 * Replacement offsets point into the original content (not into the
 * normalized text), so the write keeps every byte outside the matched window.
 */

const MAX_CANDIDATES = 51;
const TIMES = ["[ \\t]+$", "^[ \\t]+", "^[ \\t]+|[ \\t]+$"] as const;
const MODES = [
	"ignoring trailing whitespace",
	"ignoring leading whitespace (indentation)",
	"ignoring leading and trailing whitespace",
] as const;

export type EditorMatchMode = "exact" | (typeof MODES)[number];

export interface EditorMatch {
	offset: number;
	length: number;
	mode: EditorMatchMode;
}

export interface EditorMatchResult {
	candidates: EditorMatch[];
	mode: EditorMatchMode;
}

function splitLines(content: string, eol: "\r\n" | "\n"): string[] {
	return content.split(eol === "\r\n" ? /\r\n/ : /\n/);
}

function lineStarts(content: string, eol: "\r\n" | "\n"): number[] {
	const starts = [0];
	let from = 0;
	while (from <= content.length) {
		const next = content.indexOf(eol, from);
		if (next < 0) {
			break;
		}
		starts.push(next + eol.length);
		from = next + eol.length;
	}
	return starts;
}

function normalizeLine(line: string, modeIndex: number): string {
	return line.replace(new RegExp(TIMES[modeIndex], "g"), "");
}

/** One-based line number of an offset in content. */
export function lineNumberAt(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < content.length; i++) {
		if (content.charCodeAt(i) === 10) {
			line++;
		}
	}
	return line;
}

/**
 * All places `oldText` can replace. Exact occurrences win; otherwise the file
 * is scanned for line windows equal after trimming trailing/leading spaces and
 * tabs. Candidate offsets always refer to the original content.
 */
export function findEditorMatches(
	content: string,
	oldText: string,
	eol: "\r\n" | "\n",
): EditorMatchResult {
	if (oldText.length === 0) {
		return { candidates: [], mode: "exact" };
	}

	const exact: EditorMatch[] = [];
	let from = 0;
	while (exact.length < MAX_CANDIDATES) {
		const offset = content.indexOf(oldText, from);
		if (offset < 0) {
			break;
		}
		exact.push({ offset, length: oldText.length, mode: "exact" });
		from = offset + oldText.length;
	}
	if (exact.length > 0) {
		return { candidates: exact, mode: "exact" };
	}

	const oldLines = splitLines(oldText, eol);
	if (oldLines.length === 0) {
		return { candidates: [], mode: "exact" };
	}
	const fileLines = splitLines(content, eol);
	const starts = lineStarts(content, eol);

	for (let modeIndex = 0; modeIndex < MODES.length; modeIndex++) {
		const target = oldLines.map((line) => normalizeLine(line, modeIndex));
		const hits: number[] = [];
		for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
			let matches = true;
			for (let j = 0; j < oldLines.length; j++) {
				if (normalizeLine(fileLines[i + j], modeIndex) !== target[j]) {
					matches = false;
					break;
				}
			}
			if (matches) {
				hits.push(i);
				if (hits.length >= MAX_CANDIDATES) {
					break;
				}
			}
		}
		if (hits.length === 0) {
			continue;
		}
		const mode = MODES[modeIndex];
		const candidates = hits.map((lineIndex) => ({
			offset: starts[lineIndex] ?? content.length,
			length: fileLines.slice(lineIndex, lineIndex + oldLines.length).join(eol)
				.length,
			mode,
		}));
		return { candidates, mode };
	}

	return { candidates: [], mode: "exact" };
}

/** Three lines of context around each candidate, for the multiple-match error. */
export function formatEditorCandidates(
	content: string,
	eol: "\r\n" | "\n",
	result: EditorMatchResult,
): string {
	if (result.candidates.length === 0) {
		return "";
	}
	const fileLines = splitLines(content, eol);
	const out: string[] = [];
	for (const [index, candidate] of result.candidates.slice(0, 5).entries()) {
		const first = lineNumberAt(content, candidate.offset);
		const last = lineNumberAt(
			content,
			candidate.offset + Math.max(0, candidate.length - 1),
		);
		const low = Math.max(0, first - 1 - 3);
		const high = Math.min(fileLines.length, last + 3);
		out.push(
			`  match ${index + 1}/${result.candidates.length} -- lines ${first}-${last} (${candidate.mode}):`,
		);
		for (let line = low; line < high; line++) {
			const text =
				fileLines[line].length > 120
					? `${fileLines[line].slice(0, 120)}...`
					: fileLines[line];
			const inMatch = line + 1 >= first && line + 1 <= last;
			out.push(
				`${inMatch ? "> " : "  "}${line + 1}: ${inMatch ? JSON.stringify(text) : text}`,
			);
		}
	}
	if (result.candidates.length > 5) {
		out.push("  ... (first 5 matches shown)");
	}
	return out.join("\n");
}

/** Where exact occurrences start, for the multiple-match error. */
export function formatEditorOccurrenceLines(
	content: string,
	oldText: string,
): string {
	if (!oldText) {
		return "";
	}
	const lines: number[] = [];
	let from = 0;
	while (lines.length < 8) {
		const offset = content.indexOf(oldText, from);
		if (offset < 0) {
			break;
		}
		lines.push(lineNumberAt(content, offset));
		from = offset + oldText.length;
	}
	if (lines.length === 0) {
		return "";
	}
	const suffix = lines.length >= 8 ? " (first 8 shown)" : "";
	return ` Occurrences start at lines ${lines.join(", ")}${suffix}.`;
}

/**
 * Hint for "text not found": the file line sharing the most words with the
 * first non-empty line of old_text. Words shorter than four characters are
 * ignored, so punctuation and short identifiers do not produce noise.
 */
export function formatEditorHint(
	content: string,
	oldText: string,
	eol: "\r\n" | "\n",
): string {
	const oldLines = splitLines(oldText, eol);
	const fileLines = splitLines(content, eol);
	let best = -1;
	let bestScore = 0;
	let first = "";
	for (const oldLine of oldLines) {
		first = oldLine.trim();
		if (!first) {
			continue;
		}
		const words = first
			.replace(/[^A-Za-z0-9]+/g, " ")
			.split(" ")
			.filter((word) => word.length >= 4);
		if (words.length === 0) {
			continue;
		}
		for (let i = 0; i < fileLines.length; i++) {
			let score = 0;
			for (const word of words) {
				if (fileLines[i].includes(word)) {
					score++;
				}
			}
			if (score > bestScore) {
				bestScore = score;
				best = i;
			}
		}
		if (bestScore > 0) {
			break;
		}
	}
	if (best < 0 || bestScore === 0) {
		return "";
	}
	return ` Hint: no exact match; the line closest to old_text is line ${best + 1}: ${JSON.stringify(
		fileLines[best].slice(0, 160),
	)} (old_text line: ${JSON.stringify(first.slice(0, 160))}) -- check indentation and whitespace and re-read the file.`;
}

/** Note prepended to the result when a fallback or an explicit occurrence was used. */
export function formatEditorMatchNote(
	content: string,
	result: EditorMatchResult,
	candidate: EditorMatch,
	occurrence: number | undefined,
): string {
	const first = lineNumberAt(content, candidate.offset);
	const last = lineNumberAt(
		content,
		candidate.offset + Math.max(0, candidate.length - 1),
	);
	if (candidate.mode !== "exact") {
		return `\nNOTE: old_text matched ${candidate.mode}; replaced file lines ${first}-${last}.`;
	}
	if (result.candidates.length > 1 && occurrence !== undefined) {
		return `\nNOTE: replaced match ${occurrence} of ${result.candidates.length}; lines ${first}-${last}.`;
	}
	return "";
}
