/** A resume waiting for a usage-limit window to reset. */
export type PendingResume = {
  /** When the resume prompt is sent, in ms since the epoch. */
  at: number
  /** The window that ran out (`five_hour`, `seven_day`), or `unknown` when no reset time was reported. */
  window: string
}

/** The last call the loop breaker refused. */
export type BlockedCall = {
  /** A short, human-readable form of the call. */
  label: string
  /** How many identical failures came before it. */
  failures: number
}

declare module 'claude-code' {
  interface PluginState {
    unattended: {
      pending: PendingResume | null
      resumes: number
      blocked: BlockedCall | null
    }
  }
}
