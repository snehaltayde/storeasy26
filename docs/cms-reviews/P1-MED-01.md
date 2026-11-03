# P1 MED-01: Phone photos just work

Spec: `docs/CMS_FULL_BUILD_SPEC.md` section 7.14, MED-01. Base commit: 939d630.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Level | Status |
|---|---|
| Implemented | YES, on branch `cms/p1-med01` |
| Locally tested | YES for logic, the wiring and the real server route. Real pixels are NOT tested: node has no canvas, so every encode in the suite comes from a stand-in. |
| Browser verified | **NOT DONE.** No browser or dev server was available in this batch. See "Browser drill still needed". |
| Staging verified | NOT DONE |
| Production enabled | NOT DONE |

## What was built

- `lib/media-upload-plan.js` (new, pure, no imports): what to do with each kind of file, when to skip, target long edge (1920), the ordered encode steps, the preview size, the founder's messages, and the mapping from server answers to plain words.
- `lib/media-upload.js` (new, browser-safe): `uploadImage`, the one upload path. It decodes, plans, encodes until something fits, makes the preview, and posts with XHR so upload percent can be reported. The canvas and the network are injectable, so node can run the whole path.
- `components/admin/MediaUploadStatus.js` (new): the shared progress banner.
- `components/admin/MediaAdmin.js`, `components/admin/cms/MediaPicker.js`: both now call `uploadImage`. Their own upload, thumbnail and dimension code is gone. Copy no longer leads with size limits.
- `scripts/test-media-upload.js` + `test:media-upload` in `package.json` (new).

`lib/media.js` and `app/api/admin/media/route.js` were not changed: `git diff --stat 939d630 -- lib/media.js app/api/admin/media/route.js` prints nothing.

### How each case is handled

| File | Result |
|---|---|
| JPEG over the limit or over 1920px | JPEG, long edge 1920, qualities 0.85, 0.78, 0.7, 0.62, 0.55 in turn |
| Too detailed for all of those | Shrinks to 1600 then 1280 (qualities 0.7, 0.6). Library toast says it was made smaller. |
| PNG or WebP with no transparency, over the limit or over 1920px | Same, written as JPEG, file renamed |
| PNG or WebP with transparency | WebP steps. If the browser can't write WebP (Safari answers with a PNG), PNG at 1920, 1600, 1280, 1024, 800. **Never a JPEG step**, so never flattened onto black. If the transparency check itself can't run, the image counts as transparent. |
| Within the limit and no larger than 1920px | The same `File` object goes up, no upscale, no re-encode. Preview only, using the old rule (wider than 480px). |
| Over 1920px and within the limit, but re-encoding doesn't shrink it | Original is kept |
| GIF, SVG | Left as they are, nothing encoded, server rules apply. An oversized one is refused by the server and the founder reads plain words. |
| HEIC the browser can open (Safari) | JPEG, even when small, because the server refuses HEIC |
| HEIC it can't open | Plain message, nothing sent |
| Other image types (AVIF and so on) | Same as HEIC, with the general "couldn't open" message |
| Not an image | Plain message, nothing decoded, nothing sent |
| Can't fit under the limit | Plain message, nothing sent |
| Damaged and over the limit | Plain message. Damaged and within the limit goes to the server, whose magic-byte check refuses it, and the founder reads plain words. |

## Acceptance

Tags: unit = plain node. There is no JSX-capable runner in the repo yet (spec 8.15), so nothing here is tagged rendered. Component behaviour is covered by source scan plus the browser drill.

Evidence command for all unit rows: `pnpm test:media-upload` → **52 passed, 0 failed**. Quoted names are test names.

| # | Item | Tag | Status | Evidence |
|---|---|---|---|---|
| 1 | A 5MB phone photo uploads with no error, with a long edge of at least 1920px after resize and within the server limit | unit + browser drill | Logic passes through the real route. **Real photo NOT browser verified.** | "ACCEPTANCE: a 5MB phone photo uploads...": a 5,000,000 byte 4032x3024 file through `uploadImage` with a stand-in encoder, into the real `POST` handler and real `saveMedia`. The stored row is checked: 1920x1440, within 1.5MB, thumbnail attached. Drill 1. |
| 2 | MediaPicker and MediaAdmin use one upload path | unit (source scan) + browser drill | Passes scan. **Not browser verified.** | "MediaAdmin and MediaPicker both upload through uploadImage and hold no copy of their own"; "nothing else in the console posts files to the media route". Drill 2. |
| 3 | Negative: a file that is not an image is refused with a plain message | unit + browser drill | Passes. **Not browser verified.** | "NEGATIVE: a file that isn't an image...", "every real server refusal maps to plain words" (feeds real `validateUpload` output through the mapper). Drill 7. |
| 4 | Negative: SVG sanitizing and magic-byte checks still run on the server | unit | Passes on the real route | "route: PNG bytes declared as JPEG are refused...", "route: an SVG uploaded through the shared path is sanitized before it is stored" (reads the stored bytes back), "magic-byte sniffing still decides...". |

Items from the task brief beyond the spec's list:

| Item | Tag | Status | Evidence |
|---|---|---|---|
| Server limits unchanged, proven by test | unit | Passes | "server limits are unchanged, and the browser's copy matches them", "server size limit holds at the exact byte for every type", "route: a raw 5MB photo sent past the browser step is still refused" |
| Size planning is a pure function plain node can test | unit | Passes | "— size plan" section; "lib/media-upload.js stays browser-safe: no server imports" |
| Transparent PNG is not flattened | unit + browser drill | Plan and path pass. **Real pixels not verified.** | "steps: a transparent image never gets a JPEG step", both "transparent PNG" path tests. Drill 3. |
| Already small image: no upscale, no needless recompress | unit | Passes | "an already small image goes up byte for byte...", "re-encoding that would grow the file keeps the original" |
| SVG and GIF left as they are | unit | Passes | "SVG and GIF are left exactly as they are...", "a GIF over the limit..." |
| HEIC the browser can't decode gets a plain message | unit + browser drill | Passes with a stand-in decode failure. **Real browsers not verified.** | "HEIC this browser can't open...", "HEIC this browser can open (Safari)...". Drill 5. |
| Can't compress under the limit gets a plain message | unit | Passes | "an image that can't fit...", "transparent PNG too detailed for PNG in Safari..." |
| Progress, not a size error | unit + browser drill | Labels and order pass. **Display not verified.** | "progress: the founder sees stages...". Drill 2. |

### Do the tests bite?

One-off mutation run (each break applied, suite run, file restored). All ten turned the suite red: server limit raised, magic-byte check removed, SVG sanitizing skipped in `saveMedia`, a JPEG step added for transparent images, upscale allowed, target lowered to 1600, always re-encode, trusting the requested output type (the Safari case), HEIC message dropped, picker moved off the shared path.

### Are the ladder's numbers realistic?

The stand-in encoder's sizes are calibrated, not measured in a browser. One-off run with sharp (real JPEG encoder, not a browser canvas, not committed) on a synthetic photo-like 4032x3024 image, resized to 1920 wide:

| Source at q92 | q85 | q55 |
|---|---|---|
| 2.59MB | 0.16MB | 0.05MB |
| 4.87MB | 0.32MB | 0.09MB |
| 6.58MB | 0.52MB | 0.16MB |
| 8.80MB (heavy noise) | 0.90MB | 0.33MB |

Synthetic images, so this only says the first step should normally fit. Drill 1 is the real check.

## Suites

Run with `pnpm run <suite>` on the final tree, each suite exiting 0.

- Related: test:media-upload 52/0, test:storefront 15/0, test:releases 25/0, test:agency 16/0, test:admin-console 9/0, test:cms-api 20/0, test:security 13/0, test:tenant-boundary 24/0 (passed/failed).
- Every `test:*` except `test:perf`: **40 suites, 0 failed** (the 39 at baseline plus test:media-upload).
- `pnpm build` compiled the changed client components. Its Turbopack warning traces through `lib/platform/migrate.js`, which this change doesn't touch. The build ran once, before the last comment and doc edits.

## Browser drill still needed

Run on `pnpm dev:design`, signed in as owner, and commit screenshots or a recording per spec 8.15. Do each upload from both Storefront → Media (MediaAdmin) and an image field's picker (MediaPicker) unless noted.

1. **Real phone photo.** Upload a real JPEG of about 5MB, 4000px wide. Expect no error, `image/jpeg` in the library, 1920 on the long edge, under 1.5MB, "+thumb" shown. Look at it full size: sharp, and colours match the original (iPhone photos are Display P3).
2. **One path and progress.** Upload the same kind of file from both places. Expect "Getting … ready…", "Uploading … N%", "Saving…" in a banner in both, on a throttled connection so the percent moves. Both uploads end with dimensions and a preview in the library. In the picker the grid loads the preview (`/api/media/<thumb id>` in the network panel), and the picked image lands in the field.
3. **Transparent PNG.** Upload a transparent PNG over 1.5MB, once in Chrome and once in Safari. Check over a coloured background: corners stay see-through, no black. Chrome should store WebP. Safari should store PNG at whatever size fits. Also a transparent PNG with a single see-through area, to confirm the check catches it. Confirm in Safari that `toBlob` really answers a WebP request with a PNG blob, as the code assumes.
4. **Sideways photos.** A portrait phone photo with EXIF rotation stays upright after resize, and the recorded width and height match (expect 1440x1920).
5. **HEIC.** (a) iPhone Safari: pick a HEIC from Photos. With `accept="image/*"` iOS is expected to hand over a JPEG. Confirm it does and that it uploads. (b) Mac Safari: a `.heic` file, expect it to arrive as JPEG in the library. (c) Chrome on Mac or Windows: a `.heic` file, expect the plain HEIC message and no POST in the network panel. (d) Android Chrome: confirm the gallery offers photos and what a HEIC does there.
6. **Small and unchanged.** An 800px JPEG under 1.5MB: the stored file has the same size in bytes as the original. A 300px PNG: no "+thumb". Nothing looks blurred or grown.
7. **Refusals in plain words.** A PDF (choose "All files"): plain "isn't an image". A PDF renamed `.jpg`: plain "isn't really the kind of image". A GIF over 1.5MB and an SVG over 300KB: plain "too big". Network off during upload: plain "didn't go through". Then re-pick the same file in the picker and confirm it starts again (the input now resets).
8. **SVG and GIF.** A small SVG with a script: stored version has no script (open `/api/media/<id>`). An animated GIF stays animated.
9. **Phones.** On a real iPhone and Android, a large photo from the camera (`image/*` also offers the camera) completes without the tab crashing or running out of memory. Try a 48MP photo if a device has one: decoding it is the heaviest step and is not bounded in code.
10. **Hosted limit.** On staging, not on the harness: one full-size upload with a preview, to confirm the hosting platform's request limit isn't reached and the XHR path works through the proxy.

## Differences from the spec, and decisions

- **`accept` changed to `image/*`** in both pickers. The old explicit list stopped a HEIC on a Mac or Android being picked at all, so the plain message could never appear. My understanding is that iOS turns HEIC into JPEG for `image/*` as it did for the old list, and would stop doing so if HEIC were listed explicitly, but I could not check that here: drill 5(a).
- **A photo can end up below 1920px** in one case: it doesn't fit at 1920 even at quality 0.55. It then goes to 1600 or 1280 rather than being refused, because the founder asked for a photo to work, and the library toast says so. The picker has no toast and doesn't say it, though the library shows the real dimensions. The spec's 1920 target holds for a normal 5MB photo. If reviewers want a hard 1920 floor, remove `LAST_RESORT` and the message path already handles it.
- **Over 1920px but within the limit is resized.** "Already small" is read as small in bytes AND in size, and the original is kept if re-encoding doesn't shrink it.
- **Opaque PNG and WebP become JPEG** when they must be re-encoded. It is the one format every browser can write. A hard-edged screenshot will show a little JPEG softness; only files over the limit or over 1920px are affected.
- **MediaPicker preview fix.** `thumbOf` read `t?.url`, but listed variants carry no url, so it always loaded the full image. Picker uploads now make previews, so this is a one-line fix to use them. It goes slightly beyond "one upload path".
- **The picker's file input now resets** after each upload, so picking the same file again after an error works.
- **GIF and SVG over the limit are still sent** and refused by the server, as the brief says, rather than checked first. A huge GIF wastes an upload before the plain message.
- **Limit numbers exist twice.** `lib/media.js` imports the db, so the browser can't import it, and `lib/media.js` was to stay untouched. The first test fails if the copies differ.
- **Spec 8.15 lists "resize path" under `test-media-refs`.** The brief names `test:media-upload`, so it lives there.
- **The spec's citations were accurate** against 939d630: `lib/media.js:9-10`, `lib/media.js:15-21`, `MediaAdmin.js:73`, `MediaPicker.js:47`.

## Known limits, not fixed

- **Animated WebP and animated PNG** over 1920px or over the limit are written from their first frame, with no warning. Before this change the over-1920 ones under the limit stayed animated, so this is a small regression. Detecting it means parsing file bytes, which I left out as beyond the requirement.
- **Location data.** An already small phone JPEG goes up byte for byte, so any EXIF location in it is stored and served, as it was before. Resized photos lose EXIF. Worth a decision outside this item.
- **A second copy is possible.** Dedupe compares output bytes, so the same photo resized by a different browser is stored again.
- **A multi-file upload in the library stops at the first failure,** as it did before. The message names the file that failed but not the ones left unsent.
- **Text progress only,** no bar.
- **The route test depends on `node:module` `registerHooks`** (Node 22.15 or later) to resolve the route's `@/` and `next/*` imports. Ran here on Node 26. The repo sets no `engines` field.
