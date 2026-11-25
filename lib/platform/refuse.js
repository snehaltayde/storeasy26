// A library's own refusal: an Error with a 4xx status whose words an operator
// route may show as they are (lib/platform/operator-error.js). No imports, so
// Edge-safe code can use it too.
export const refuse = (status, message) => Object.assign(new Error(message), { status });
