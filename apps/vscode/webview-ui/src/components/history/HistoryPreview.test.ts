import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { HISTORY_PREVIEW_LIMIT, selectHistoryPreviewItems } from "./HistoryPreview"

function historyItem(index: number, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${index}`,
		ts: index + 1,
		task: `task ${index}`,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	}
}

describe("selectHistoryPreviewItems", () => {
	it("keeps the latest seven visible tasks", () => {
		const items = Array.from({ length: 10 }, (_, index) => historyItem(index))
		const preview = selectHistoryPreviewItems(items)

		expect(HISTORY_PREVIEW_LIMIT).toBe(7)
		expect(preview).toHaveLength(7)
		expect(preview.map((item) => item.id)).toEqual(["task-0", "task-1", "task-2", "task-3", "task-4", "task-5", "task-6"])
	})

	it("skips entries without a timestamp or task text before applying the limit", () => {
		const items = [historyItem(1), historyItem(2, { ts: 0 }), historyItem(3, { task: "" }), historyItem(4)]

		expect(selectHistoryPreviewItems(items).map((item) => item.id)).toEqual(["task-1", "task-4"])
	})
})
