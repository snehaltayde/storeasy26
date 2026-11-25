// Files outside components/kit/ that may mark a control data-read-control
// (support's stray-control rule on a new-UI route lets a marked control pass).
// test:console-kit fails a mark outside components/kit/ without a row here,
// and any mark on a submit button or inside a form that is not method="get".
// Each row: { path, reason } (the read the control performs). Phase 2 lines
// append rows; when appends conflict, keep both sides.
export const READ_CONTROLS = [];
