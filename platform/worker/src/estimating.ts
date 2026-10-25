// The fallback scale for scope estimates when no clean past job is comparable.
export const DEFAULT_ESTIMATE_SCALE = `Only when no comparable past job fits, use this fallback scale in agent time:
most small tasks finish in under 20 minutes, and even big tasks finish well under an hour. These are starting anchors,
not limits. Judge the task's scope and explain why no comparison fits. As clean comparable jobs accumulate, use their
actual agent times instead of this fallback.`;
