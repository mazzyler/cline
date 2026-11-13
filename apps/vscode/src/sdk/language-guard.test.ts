import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentEvent } from "@cline/shared"
import type { ClineMessage, ClineSay } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SdkLanguageGuard, type SdkLanguageGuardOptions } from "./language-guard"
import type { MessageStateHandler } from "./task-proxy"

const ENV_KEYS = [
	"CJK_ABORT_OFF",
	"CJK_ABORT_RUN",
	"CJK_GUARD_MAX",
	"CJK_GUARD_ALLOW_TTL",
	"CJK_ABORT_FALLBACK_MS",
	"CJK_GUARD_LOGDIR",
	"CJK_GUARD_LOG",
	"CJK_GUARD_STATE",
	"CJK_GUARD_ALLOW",
	"CJK_GUARD_FORCE",
] as const

const savedEnv = new Map<string, string | undefined>()
const tempDirs: string[] = []

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key])
		delete process.env[key]
	}
})

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key)
		if (value === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = value
		}
	}
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

function textDelta(text: string, accumulated: string): AgentEvent {
	return { type: "content_start", contentType: "text", text, accumulated } as AgentEvent
}

function reasoningDelta(text: string): AgentEvent {
	return { type: "content_start", contentType: "reasoning", reasoning: text } as AgentEvent
}

function message(ts: number, say: ClineSay, text: string, partial = false): ClineMessage {
	return { ts, type: "say", say, text, ...(say === "reasoning" ? { reasoning: text } : {}), partial }
}

interface Harness {
	guard: SdkLanguageGuard
	session: { sessionId: string; sdkHost: { abort: ReturnType<typeof vi.fn> } }
	messages: () => ClineMessage[]
	resume: ReturnType<typeof vi.fn>
	options: SdkLanguageGuardOptions
	dir: string
}

function makeHarness(initial: ClineMessage[] = []): Harness {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cjk-guard-"))
	tempDirs.push(dir)
	const session = {
		sessionId: "s1",
		sdkHost: { abort: vi.fn(async () => {}) },
	}
	let stored = [...initial]
	const handler = {
		getClineMessages: () => [...stored],
		replaceMessages: (next: ClineMessage[]) => {
			stored = [...next]
		},
	} as unknown as MessageStateHandler
	const resume = vi.fn(async () => {})
	const options: SdkLanguageGuardOptions = {
		getActiveSession: () => session,
		getTask: () => ({ messageStateHandler: handler }),
		setRunning: vi.fn(),
		clearPending: vi.fn(),
		postStateToWebview: vi.fn(async () => {}),
		bumpEpoch: vi.fn(),
		resume,
		logDir: dir,
	}
	return {
		guard: new SdkLanguageGuard(options),
		session,
		messages: () => [...stored],
		resume,
		options,
		dir,
	}
}

function logLines(dir: string): string {
	try {
		return fs.readFileSync(path.join(dir, "cjk-guard.log"), "utf8")
	} catch {
		return ""
	}
}

describe("SdkLanguageGuard", () => {
	it("aborts at eight CJK characters, removes the partial answer and resumes silently", async () => {
		const harness = makeHarness([
			message(0, "task", "задача"),
			message(1, "user_feedback", "привет"),
			message(2, "reasoning", "思考思考思考思考", true),
			message(3, "text", "你好你好你好你好", true),
		])

		harness.guard.observe("s1", textDelta("你好你好", "你好你好"))
		expect(harness.session.sdkHost.abort).not.toHaveBeenCalled()

		harness.guard.observe("s1", textDelta("你好你好", "你好你好你好你好"))
		expect(harness.session.sdkHost.abort).toHaveBeenCalledWith("s1")
		expect(harness.options.setRunning).toHaveBeenCalledWith(false)

		await harness.guard.onSendSettled("s1")

		expect(harness.resume).toHaveBeenCalledTimes(1)
		expect(harness.resume.mock.calls[0][0]).toMatch(/^\[TASK RESUMPTION\] Языковой контроль/)
		expect(harness.messages().map((item) => item.say)).toEqual(["task", "user_feedback"])
		expect(harness.options.bumpEpoch).toHaveBeenCalled()
		expect(logLines(harness.dir)).toContain("action=abort")
		expect(logLines(harness.dir)).toContain("stream:regenerate-sent")
		harness.guard.dispose()
	})

	it("does not count reasoning characters and resets the run on reasoning", () => {
		const harness = makeHarness()
		harness.guard.observe("s1", reasoningDelta("思考思考思考思考思考思考思考思考思考"))
		expect(harness.session.sdkHost.abort).not.toHaveBeenCalled()

		harness.guard.observe("s1", textDelta("你好你好", "你好你好"))
		harness.guard.observe("s1", reasoningDelta("思考"))
		harness.guard.observe("s1", textDelta("你好你好你好", "你好你好你好你好你好"))
		expect(harness.session.sdkHost.abort).not.toHaveBeenCalled()
		harness.guard.dispose()
	})

	it("does not break a CJK run on whitespace", () => {
		const harness = makeHarness()
		harness.guard.observe("s1", textDelta("你好你好", "你好你好"))
		harness.guard.observe("s1", textDelta(" ", "你好你好 "))
		harness.guard.observe("s1", textDelta("你好你好", "你好你好 你好你好"))
		expect(harness.session.sdkHost.abort).toHaveBeenCalledTimes(1)
		harness.guard.dispose()
	})

	it("passes the answer through after the attempt limit", async () => {
		const harness = makeHarness()

		for (let attempt = 0; attempt < 2; attempt++) {
			harness.guard.observe("s1", textDelta("", ""))
			harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))
			await harness.guard.onSendSettled("s1")
		}
		expect(harness.session.sdkHost.abort).toHaveBeenCalledTimes(2)

		harness.guard.observe("s1", textDelta("", ""))
		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))

		expect(harness.session.sdkHost.abort).toHaveBeenCalledTimes(2)
		expect(logLines(harness.dir)).toContain("action=over-limit-pass")
		harness.guard.dispose()
	})

	it("consumes the one-shot allow marker for the current answer only", () => {
		const harness = makeHarness()
		fs.writeFileSync(path.join(harness.dir, "cjk-guard-allow"), "перевод\n")

		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))
		expect(harness.session.sdkHost.abort).not.toHaveBeenCalled()
		expect(fs.existsSync(path.join(harness.dir, "cjk-guard-allow"))).toBe(false)
		expect(logLines(harness.dir)).toContain("action=allowed")

		harness.guard.observe("s1", textDelta("", ""))
		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))
		expect(harness.session.sdkHost.abort).toHaveBeenCalledTimes(1)
		harness.guard.dispose()
	})

	it("aborts a CJK-free answer when the force marker is present", async () => {
		const harness = makeHarness()
		fs.writeFileSync(path.join(harness.dir, "cjk-guard-force"), "проверка\n")

		harness.guard.observe("s1", textDelta("hello", "hello"))
		expect(harness.session.sdkHost.abort).toHaveBeenCalledTimes(1)
		expect(fs.existsSync(path.join(harness.dir, "cjk-guard-force"))).toBe(false)

		await harness.guard.onSendSettled("s1")
		expect(harness.resume.mock.calls[0][0]).toContain("принудительной проверкой")
		harness.guard.dispose()
	})

	it("counts a longer first delta after the guard resumed the task", async () => {
		const harness = makeHarness()
		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))
		await harness.guard.onSendSettled("s1")
		expect(harness.session.sdkHost.abort).toHaveBeenCalledTimes(1)

		// The next answer starts with a delta longer than the aborted answer:
		// the accumulated text does not shrink, so only an explicit turn reset
		// makes the guard count it.
		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好 and more"))
		expect(harness.session.sdkHost.abort).toHaveBeenCalledTimes(2)
		harness.guard.dispose()
	})

	it("resets the attempt counter after a clean turn", async () => {
		const harness = makeHarness()
		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))
		await harness.guard.onSendSettled("s1")
		await harness.guard.onSendSettled("s1")

		expect(logLines(harness.dir)).toContain("action=reset")

		harness.guard.observe("s1", textDelta("", ""))
		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))
		expect(logLines(harness.dir)).toContain("strikes=1 action=abort")
		harness.guard.dispose()
	})

	it("keeps transcript entries that belong to earlier turns", async () => {
		const harness = makeHarness([
			message(1, "user_feedback", "первый вопрос"),
			message(2, "text", "первый ответ", false),
			message(3, "user_feedback", "второй вопрос"),
			message(4, "reasoning", "思考", true),
			message(5, "text", "你好你好你好你好", true),
		])

		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))
		await harness.guard.onSendSettled("s1")

		expect(harness.messages().map((item) => item.ts)).toEqual([1, 2, 3])
		harness.guard.dispose()
	})

	it("is disabled by CJK_ABORT_OFF=1", () => {
		process.env.CJK_ABORT_OFF = "1"
		const harness = makeHarness()
		harness.guard.observe("s1", textDelta("你好你好你好你好", "你好你好你好你好"))
		expect(harness.session.sdkHost.abort).not.toHaveBeenCalled()
		harness.guard.dispose()
	})

	it("ignores teammate agents", () => {
		const harness = makeHarness()
		harness.guard.observe("s1", {
			...textDelta("你好你好你好你好", "你好你好你好你好"),
			parentAgentId: "lead",
		} as AgentEvent)
		expect(harness.session.sdkHost.abort).not.toHaveBeenCalled()
		harness.guard.dispose()
	})
})
