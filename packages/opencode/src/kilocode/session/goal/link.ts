import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundProcess } from "@/kilocode/background-process"
import type { SessionID } from "@/session/schema"
import { GoalState } from "./state"

/**
 * The seam between the goal loop and the scheduler: the single classification
 * table for the six scheduling tools, the per-session wait record, the goal
 * arm hook the wakeup side calls on a fire, and the pending-fire queue that
 * serializes a fire against an in-flight goal turn.
 */
export namespace GoalLink {
  export type Kind = "wakeup" | "cron" | "process"
  export type Wait = { kind: Kind; id: string; label: string; dueAt?: number; recurring?: boolean }

  // A process wait only ends when a process reaches a terminal status.
  const FINISHED: readonly string[] = ["exited", "failed", "stopped"]
  // A process already on its way down is not a wait worth recording.
  const STOPPED: readonly string[] = ["exited", "failed", "stopped", "stopping"]

  /**
   * The one place the six scheduling tools are read from a tool part. Returns
   * the wait a completed scheduling call left behind, or undefined when the
   * part is not a completed scheduling wait.
   */
  export function waitFor(part: typeof SessionV1.ToolPart.Type): Wait | undefined {
    if (part.state.status !== "completed") return undefined
    const meta = part.state.metadata
    if (part.tool === "schedule_wakeup") {
      const id = meta?.id
      if (typeof id !== "string") return undefined
      return {
        kind: "wakeup",
        id,
        label: String(meta.prompt ?? meta.reason ?? id),
        dueAt: typeof meta.dueAt === "number" ? meta.dueAt : undefined,
      }
    }
    if (part.tool === "cron_create") {
      const id = meta?.id
      if (typeof id !== "string") return undefined
      return {
        kind: "cron",
        id,
        label: String(meta.prompt ?? id),
        dueAt: typeof meta.dueAt === "number" ? meta.dueAt : undefined,
        recurring: meta.recurring === true,
      }
    }
    if (part.tool === "background_process") {
      const id = meta?.processID
      const status = meta?.status
      if (typeof id !== "string") return undefined
      if (typeof status === "string" && STOPPED.includes(status)) return undefined
      return { kind: "process", id, label: id }
    }
    return undefined
  }

  /** Scheduling calls that only inspect or cancel an existing wait are not a wait themselves. */
  export function bookkeeping(tool: string) {
    return tool === "cancel_wakeup" || tool === "cron_list" || tool === "cron_delete"
  }

  // One wait per session: session ids are process-unique.
  const waits = new Map<string, Wait>()

  export function set(sessionID: string, wait: Wait) {
    waits.set(sessionID, wait)
  }

  export function get(sessionID: string) {
    return waits.get(sessionID)
  }

  export function clear(sessionID: string) {
    waits.delete(sessionID)
  }

  /** Clear and return the wait only when it is still the one the caller awaits. */
  export function take(sessionID: string, waitID: string) {
    const wait = waits.get(sessionID)
    if (!wait || wait.id !== waitID) return undefined
    waits.delete(sessionID)
    return wait
  }

  export type Arm = (input: { sessionID: SessionID; action: "resume"; note?: string }) => Effect.Effect<unknown, Error>

  const arms = new Map<string, Arm>()

  export function registerArm(sessionID: SessionID, fn: Arm) {
    arms.set(sessionID, fn)
  }

  export function arm(sessionID: SessionID, input: { sessionID: SessionID; action: "resume"; note?: string }) {
    const fn = arms.get(sessionID)
    if (!fn) return Effect.fail(new Error("no goal resume handler"))
    return fn(input)
  }

  export type Pending = { note: string; wait: Wait }

  const pending = new Map<string, Pending[]>()

  /** A fire that reaches a session mid-turn waits here instead of starting a concurrent goal run. */
  export function pushPending(sessionID: SessionID, entry: Pending) {
    const list = pending.get(sessionID)
    if (list) list.push(entry)
    else pending.set(sessionID, [entry])
  }

  /** Drain the queued fires for a session. */
  export function takePending(sessionID: SessionID) {
    const list = pending.get(sessionID) ?? []
    if (list.length) pending.delete(sessionID)
    return list
  }

  export function resumeOrQueue(sessionID: SessionID, note: string, wait: Wait) {
    if (GoalState.active(sessionID)) {
      pushPending(sessionID, { note, wait })
      return Effect.void
    }
    return arm(sessionID, { sessionID, action: "resume", note })
  }

  export type Cleanup = (sessionID: SessionID) => Effect.Effect<unknown, unknown>

  const cleanups: Cleanup[] = []

  /** Every Wakeup layer build registers once, so whichever build owns the timer can interrupt it. */
  export function registerCleanup(fn: Cleanup) {
    cleanups.push(fn)
  }

  export function cleanup(sessionID: SessionID) {
    return Effect.forEach(cleanups, (fn) => Effect.catchCause(fn(sessionID), () => Effect.void), { discard: true })
  }

  /**
   * The background-process wait (D10): poll the process and resume the goal
   * once it is gone or terminal. The caller forks it in the instance scope so
   * it outlives the goal loop fiber.
   */
  export function processWatch(sessionID: SessionID, wait: Wait) {
    return Effect.gen(function* () {
      while (true) {
        const info = yield* Effect.promise(() => BackgroundProcess.get(wait.id as BackgroundProcess.ID))
        const status = info?.status
        if (!info || (status !== undefined && FINISHED.includes(status))) {
          yield* arm(sessionID, {
            sessionID,
            action: "resume",
            note: `[background process] ${wait.id} ${status ?? "gone"}`,
          })
          return
        }
        yield* Effect.sleep("500 millis")
      }
    }).pipe(Effect.catchCause((cause) => Effect.logError("background process wait failed", { id: wait.id, cause })))
  }
}
