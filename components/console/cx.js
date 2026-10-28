// Tiny class joiner for the console primitives (no clsx dependency).
export const cx = (...parts) => parts.filter(Boolean).join(" ");
