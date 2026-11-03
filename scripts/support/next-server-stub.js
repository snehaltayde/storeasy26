// next/server as the route harness sees it: the real module, with after() queued.
import { createRequire } from "node:module";

const real = createRequire(import.meta.url)("next/server");
export const { NextResponse, NextRequest } = real;
export const after = (fn) => globalThis.__afterSchedule(fn);
