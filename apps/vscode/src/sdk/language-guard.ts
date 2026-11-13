/**
 * Stops an answer that drifts into CJK characters.
 *
 * The guard watches visible assistant text (not reasoning), and when a run of
 * CJK characters reaches the threshold it aborts the turn the same way the Stop
 * button does, but without the `cancelled` status event: the session stays
 * resumable without a stale "Resume Task" button. The partial answer (text and
 * reasoning) is removed from the transcript, and a synthetic prompt asks the
 * model to answer in Russian again. Synthetic prompts are hidden from the
 * transcript by isSyntheticUserPrompt.
 *
 * After the attempt limit the answer is passed through as-is: the point is to
 * keep the conversation readable, not to deadlock it. A clean turn resets the
 * per-session counter.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentEvent } from "@cline/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { MessageStateHandler } from "./task-proxy"

/** How long the abort may take before the cleanup runs anyway. */
const DEFAULT_FALLBACK_MS = 3_000
/** One-shot marker that allows the next answer to use another language. */
const DEFAULT_ALLOW_TTL_SECONDS = 600

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\u3000-\u303f\uff01-\uff60]/

export interface LanguageGuardSession {
	sessionId: string
	sdkHost: {
		abort(sessionId: string): Promise<void>
	}
}

export interface SdkLanguageGuardOptions {
	getActiveSession: () => LanguageGuardSession | undefined
	getTask: () => { messageStateHandler: MessageStateHandler } | undefined
	setRunning: (running: boolean) => void
	clearPending: (reason: string) => void
	postStateToWebview: () => Promise<void>
	/** Bumps the message epoch so the webview rebuilds the transcript after the cleanup. */
	bumpEpoch: () => void
	/** Sends the model-facing regeneration prompt (synthetic, no user echo). */
	resume: (prompt: string) => void | Promise<void>
	/** Test seam: directory for the state, log and marker files. */
	logDir?: string
}

interface GuardRecord {
	strikes: number
	seen: string
	maxWarned: boolean
}

type GuardState = Record<string, GuardRecord>

interface PendingAbort {
	sessionId: string
	prompt: string
	cjk: number | "force"
}

interface RunState {
	sessionId: string
	run: number
	seenLen: number
	done: boolean
	allow: boolean
}

function int(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10)
	return Number.isFinite(parsed) ? parsed : fallback
}

function tailOf(text: string): string {
	return text.slice(-24).replace(new RegExp(CJK.source, "g"), "#").replace(/\s+/g, " ")
}

function stamp(): string {
	const date = new Date()
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
		date.getHours(),
	)}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export class SdkLanguageGuard {
	private readonly runLength: number
	private readonly maxAttempts: number
	private readonly allowTtlSeconds: number
	private readonly fallbackMs: number
	private readonly off: boolean
	private readonly logDir: string
	private readonly logPath: string
	private readonly statePath: string
	private readonly allowPath: string
	private readonly forcePath: string

	private current: RunState = { sessionId: "", run: 0, seenLen: 0, done: false, allow: false }
	private pending: PendingAbort | undefined
	private fallbackTimer: ReturnType<typeof setTimeout> | undefined

	constructor(private readonly options: SdkLanguageGuardOptions) {
		this.runLength = int(process.env.CJK_ABORT_RUN, 8)
		this.maxAttempts = int(process.env.CJK_GUARD_MAX, 2)
		this.allowTtlSeconds = int(process.env.CJK_GUARD_ALLOW_TTL, DEFAULT_ALLOW_TTL_SECONDS)
		this.fallbackMs = int(process.env.CJK_ABORT_FALLBACK_MS, DEFAULT_FALLBACK_MS)
		this.off = process.env.CJK_ABORT_OFF === "1"

		const home = os.homedir()
		this.logDir = options.logDir ?? process.env.CJK_GUARD_LOGDIR ?? path.join(home, ".cline", "data", "logs")
		this.logPath = process.env.CJK_GUARD_LOG ?? path.join(this.logDir, "cjk-guard.log")
		this.statePath = process.env.CJK_GUARD_STATE ?? path.join(this.logDir, "cjk-guard-state.json")
		this.allowPath = process.env.CJK_GUARD_ALLOW ?? path.join(this.logDir, "cjk-guard-allow")
		this.forcePath = process.env.CJK_GUARD_FORCE ?? path.join(this.logDir, "cjk-guard-force")
		this.log("module=loaded")
	}

	/** Observe one lead-agent stream event. Never throws into the event pipeline. */
	observe(sessionId: string, event: AgentEvent): void {
		if (this.off || event.parentAgentId) {
			return
		}
		if (event.type === "content_start" && event.contentType === "reasoning") {
			// Reasoning has its own stream and is not shown as the answer; the
			// model may think in CJK without the user seeing it. Break the run so
			// reasoning characters never accumulate with answer characters.
			this.current.run = 0
			return
		}
		if (event.type !== "content_start" || event.contentType !== "text") {
			return
		}
		this.onTextDelta(sessionId, event.text ?? "", event.accumulated ?? "")
	}

	/**
	 * Called when a send promise settles. Applies a pending cleanup and resumes
	 * the task, or resets the attempt counter after a clean turn.
	 */
	async onSendSettled(sessionId: string): Promise<void> {
		const pending = this.pending
		if (pending) {
			if (pending.sessionId === sessionId || pending.sessionId === "unknown") {
				await this.applyPending(pending)
			}
			return
		}
		this.beginTurn(sessionId)
		this.resetStrikes(sessionId)
	}

	dispose(): void {
		this.clearFallback()
		this.pending = undefined
	}

	/**
	 * Starts a fresh answer. Called on turn settlement and before the guard's
	 * own resume, so a short aborted answer followed by a longer first delta is
	 * still recognized as a new answer (the accumulated text does not shrink).
	 */
	private beginTurn(sessionId: string): void {
		this.current = { sessionId, run: 0, seenLen: 0, done: false, allow: false }
	}

	private onTextDelta(sessionId: string, text: string, accumulated: string): void {
		const newAnswer = this.current.sessionId !== sessionId || accumulated.length < this.current.seenLen
		if (newAnswer) {
			this.current = { sessionId, run: 0, seenLen: 0, done: false, allow: false }
			this.log(`sid=${sessionId} stream:delta`)
		}
		this.current.seenLen = accumulated.length
		if (this.current.done) {
			return
		}
		if (this.takeForceMarker()) {
			this.trigger(sessionId, "force", accumulated)
			return
		}
		for (const char of text) {
			if (CJK.test(char)) {
				this.current.run += 1
				if (this.current.run >= this.runLength) {
					this.current.run = 0
					this.trigger(sessionId, this.runLength, accumulated)
					return
				}
			} else if (!/\s/.test(char)) {
				// Spaces and line breaks do not break a CJK run: spaced-out
				// Chinese is the same failure mode.
				this.current.run = 0
			}
		}
	}

	private trigger(sessionId: string, cjk: number | "force", accumulated: string): void {
		if (this.current.allow) {
			return
		}
		if (this.takeAllowMarker()) {
			this.current.allow = true
			this.log(`sid=${sessionId} event=prompt_submit cjk=${cjk} action=allowed (allow marker)`)
			return
		}

		const state = this.loadState()
		let record = state[sessionId]
		if (!record) {
			record = { strikes: 0, seen: "", maxWarned: false }
			state[sessionId] = record
		}
		record.strikes = int(String(record.strikes), 0) + 1
		const attempt = record.strikes
		if (attempt > this.maxAttempts) {
			// The limit is spent: keep the answer as-is. A failed language
			// guard must not leave the task unable to finish.
			record.maxWarned = true
			this.saveState(state)
			this.current.done = true
			this.log(`sid=${sessionId} cjk=${cjk} strikes=${attempt} action=over-limit-pass tail=${tailOf(accumulated)}`)
			return
		}
		record.seen = `stream:${Date.now()}`
		this.saveState(state)

		this.pending = { sessionId, prompt: this.messageFor(cjk, attempt), cjk }
		this.current.done = true
		this.log(`sid=${sessionId} cjk=${cjk} strikes=${attempt} action=abort tail=${tailOf(accumulated)}`)
		this.abortForGuard(sessionId)
	}

	private abortForGuard(sessionId: string): void {
		const session = this.options.getActiveSession()
		if (!session) {
			this.log(`sid=${sessionId} action=abort-path none (no active session)`)
			this.scheduleFallback(sessionId)
			return
		}
		try {
			this.options.clearPending("language guard abort")
			if (this.pending) {
				this.pending.sessionId = session.sessionId
			}
			void session.sdkHost.abort(session.sessionId).catch((error) => {
				this.log(`sid=${sessionId} action=session-abort-error ${error instanceof Error ? error.message : error}`)
			})
			this.options.setRunning(false)
			this.log(`sid=${sessionId} action=abort-path sdkHost.abort`)
		} catch (error) {
			this.log(`sid=${sessionId} action=session-abort-failed ${error instanceof Error ? error.message : error}`)
		}
		this.scheduleFallback(session.sessionId)
	}

	private scheduleFallback(sessionId: string): void {
		this.clearFallback()
		this.fallbackTimer = setTimeout(() => {
			const pending = this.pending
			if (pending && (pending.sessionId === sessionId || pending.sessionId === "unknown")) {
				void this.applyPending(pending)
			}
		}, this.fallbackMs)
		this.fallbackTimer.unref?.()
	}

	private clearFallback(): void {
		if (this.fallbackTimer) {
			clearTimeout(this.fallbackTimer)
			this.fallbackTimer = undefined
		}
	}

	private async applyPending(pending: PendingAbort): Promise<void> {
		if (this.pending !== pending) {
			return
		}
		this.pending = undefined
		this.clearFallback()

		const dropped = this.dropPartialAnswer()
		this.options.bumpEpoch()
		this.log(`sid=${pending.sessionId} stream:ui-pushed${dropped ? ` messages ${dropped.before} -> ${dropped.after}` : ""}`)
		try {
			await this.options.postStateToWebview()
		} catch (error) {
			this.log(`sid=${pending.sessionId} stream:ui-pushed-failed ${error instanceof Error ? error.message : error}`)
		}

		// The prefix makes the prompt synthetic: message-translator hides it
		// from the transcript, while the model still receives the instruction.
		const prompt = `[TASK RESUMPTION] ${pending.prompt}`
		this.log(`sid=${pending.sessionId} stream:guard-prompt тихо: ${pending.prompt}`)
		this.beginTurn(pending.sessionId)
		try {
			await this.options.resume(prompt)
			this.log(`sid=${pending.sessionId} stream:regenerate-sent`)
		} catch (error) {
			this.log(`sid=${pending.sessionId} stream:send-failed ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Removes the interrupted answer from the transcript: the streaming text and
	 * reasoning blocks after the last user message, plus any partial answer
	 * blocks elsewhere. Empty `resume_task` stubs (from a Stop button) go too.
	 */
	private dropPartialAnswer(): { before: number; after: number } | undefined {
		const handler = this.options.getTask()?.messageStateHandler
		if (!handler) {
			this.log("stream:drop-no-handler")
			return undefined
		}
		const all = handler.getClineMessages()
		const isAnswerBlock = (message: ClineMessage) => message.say === "text" || message.say === "reasoning"
		const hasAnswerContent = (message: ClineMessage) =>
			String(message.text ?? "").trim().length > 0 || String(message.reasoning ?? "").trim().length > 0

		const drop = new Set<number>()
		let lastUser = -1
		for (let index = all.length - 1; index >= 0; index--) {
			if (all[index].say === "user_feedback") {
				lastUser = index
				break
			}
		}
		if (lastUser >= 0) {
			let end = -1
			for (let index = all.length - 1; index > lastUser; index--) {
				if (isAnswerBlock(all[index]) && hasAnswerContent(all[index])) {
					end = index
					break
				}
			}
			let start = end
			while (start - 1 > lastUser && isAnswerBlock(all[start - 1]) && hasAnswerContent(all[start - 1])) {
				start--
			}
			if (end >= 0) {
				for (let index = start; index <= end; index++) {
					drop.add(index)
				}
			}
		}
		all.forEach((message, index) => {
			if (message.partial === true && isAnswerBlock(message)) {
				drop.add(index)
			}
		})

		const keep = all
			.filter((_message, index) => !drop.has(index))
			.filter((message) => !(message.type === "ask" && message.ask === "resume_task" && !String(message.text ?? "").trim()))
		if (keep.length === all.length) {
			this.log(`stream:drop-nothing (messages ${all.length})`)
			return undefined
		}
		handler.replaceMessages(keep)
		this.log(`stream:drop-ok messages ${all.length} -> ${keep.length}`)
		return { before: all.length, after: keep.length }
	}

	private resetStrikes(sessionId: string): void {
		const state = this.loadState()
		const record = state[sessionId]
		if (!record || int(String(record.strikes), 0) === 0) {
			return
		}
		record.strikes = 0
		record.maxWarned = false
		this.saveState(state)
		this.log(`sid=${sessionId} cjk=0 strikes=0 action=reset`)
	}

	private takeAllowMarker(): boolean {
		try {
			if (!fs.existsSync(this.allowPath)) {
				return false
			}
			const fresh = (Date.now() - fs.statSync(this.allowPath).mtimeMs) / 1000 <= this.allowTtlSeconds
			try {
				fs.unlinkSync(this.allowPath)
			} catch {
				// One-shot marker: the next trigger will not see it.
			}
			return fresh
		} catch {
			return false
		}
	}

	private takeForceMarker(): boolean {
		try {
			if (!fs.existsSync(this.forcePath)) {
				return false
			}
			const fresh = (Date.now() - fs.statSync(this.forcePath).mtimeMs) / 1000 <= this.allowTtlSeconds
			try {
				fs.unlinkSync(this.forcePath)
			} catch {
				// One-shot marker: a repeated check must not fire twice.
			}
			return fresh
		} catch {
			return false
		}
	}

	private messageFor(cjk: number | "force", attempt: number): string {
		if (cjk === "force") {
			return (
				"Языковой контроль: ответ прерван принудительной проверкой обвязки (маркер " +
				`cjk-guard-force) — попытка ${attempt}/${this.maxAttempts}. Отвечай строго по-русски, без иероглифов.`
			)
		}
		let tail = ""
		if (attempt === this.maxAttempts) {
			tail = " Это последнее предупреждение."
		} else if (attempt >= Math.max(3, Math.floor((this.maxAttempts * 8) / 10))) {
			tail = " Лимит близко — поднажми."
		}
		return (
			`Языковой контроль: в предыдущем ответе снова CJK-символы (${cjk} шт.) — попытка ` +
			`${attempt}/${this.maxAttempts}. Отвечай строго по-русски, без иероглифов.${tail}`
		)
	}

	private loadState(): GuardState {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"))
			return parsed && typeof parsed === "object" ? (parsed as GuardState) : {}
		} catch {
			return {}
		}
	}

	private saveState(state: GuardState): void {
		try {
			fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
			fs.writeFileSync(this.statePath, JSON.stringify(state, null, 1))
		} catch {
			// The guard must keep working even when the log directory is read-only.
		}
	}

	private log(line: string): void {
		try {
			fs.mkdirSync(this.logDir, { recursive: true })
			fs.appendFileSync(this.logPath, `${stamp()} ${line}\n`)
		} catch {
			// Logging must not break the stream.
		}
	}
}
