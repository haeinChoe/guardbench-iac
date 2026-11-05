# Agent instructions

## User-reviewable implementation slices

For work that contains multiple independently reviewable changes:

1. Before editing, outline the slices in order. Give each slice one goal, a bounded file or infrastructure scope, and a checkable completion condition.
2. Implement only the first slice. Keep it coherent and reviewable on its own; avoid mixing unrelated cleanup or later-stage work into it.
3. Finish the slice before handing it over: inspect its diff, run the relevant checks, and report changed files, results, infrastructure effects, and remaining slices.
4. Stop for the user's review before starting the next slice. Apply the user's feedback and continue only after the user reviews or explicitly asks to proceed.
5. If the task is naturally one small change, keep it as one slice. Split only when each part can be reviewed independently.
6. If new findings change the sequence or scope, explain the adjustment before implementing the next slice.

For Terraform work, use formatting, validation, and plan checks when relevant. Do not apply infrastructure changes without the user's explicit authorization.
