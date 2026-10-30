// The fallback scale for task work estimates when no clean past job is comparable.
// Scheduler terminology: coordinator/src/eta.ts. This scale sizes work, not elapsed time to delivery.
export const DEFAULT_ESTIMATE_SCALE = `Only when no comparable past job fits, use this fallback scale in agent time:
most small tasks finish in under 20 minutes, and even big tasks finish well under an hour. These are starting anchors,
not limits. Judge the task's work and explain why no comparison fits. As clean comparable jobs accumulate, use their
actual agent times instead of this fallback.`;
