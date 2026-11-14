import { describe, expect, it } from "vitest";
import { findEditorMatches } from "./editor-match";

describe("findEditorMatches", () => {
	it("keeps fallback offsets aligned when a CRLF file contains a lone LF", () => {
		const content = "alpha\r\nbeta\ngamma\r\ndelta";
		const result = findEditorMatches(content, "gamma\ndelta");

		expect(result.candidates).toHaveLength(1);
		const [candidate] = result.candidates;
		expect(candidate.offset).toBe(content.indexOf("gamma"));
		expect(
			content.slice(candidate.offset, candidate.offset + candidate.length),
		).toBe("gamma\r\ndelta");
	});
});
