# P1 MED-01: Phone photos just work

Spec: `docs/CMS_FULL_BUILD_SPEC.md` section 7.14, MED-01. Base commit: 939d630.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Level | Status |
|---|---|
| Implemented | YES, on branch `cms/p1-med01` |
| Locally tested | YES for logic, the wiring and the real server route. Real pixels are NOT tested: node has no canvas, so every encode in the suite comes from a stand-in. |
| Browser verified | **NOT DONE.** One-off headless Chrome probes ran `lib/media-upload*.js` alone on a local page (see "Fix round 1" and "Fix round 2"). No console screen, no real upload, no Safari, no phone. See "Browser drill still needed". |
| Staging verified | NOT DONE |
| Production enabled | NOT DONE |

## What was built

- `lib/media-upload-plan.js` (new, pure, no imports): what to do with each kind of file, when to skip, target long edge (1920), the ordered encode steps, the preview size, animated file detection, the founder's messages, and the mapping from server answers to plain words.
- `lib/media-upload.js` (new, browser-safe): `uploadImage`, the one upload path. It decodes, plans, encodes until something fits, makes the preview, and posts with XHR so upload percent can be reported. The canvas and the network are injectable, so node can run the whole path.
- `components/admin/MediaUploadStatus.js` (new): the shared progress banner.
- `components/admin/MediaAdmin.js`, `components/admin/cms/MediaPicker.js`: both now call `uploadImage`. Their own upload, thumbnail and dimension code is gone. Copy no longer leads with size limits.
- `scripts/test-media-upload.js` + `test:media-upload` in `package.json` (new).

`lib/media.js` and `app/api/admin/media/route.js` were not changed: `git diff --stat 939d630 -- lib/media.js app/api/admin/media/route.js` prints nothing.

### How each case is handled

| File | Result |
|---|---|
| JPEG over the limit or over 1920px | JPEG, long edge 1920, qualities 0.85, 0.78, 0.7, 0.62, 0.55 in turn |
| Too detailed for all of those | Shrinks to 1600 then 1280 (qualities 0.7, 0.6). A toast gives the final size, in both the library and the picker. |
| PNG or WebP with no transparency, over the limit or over 1920px | Same, written as JPEG, file renamed |
| PNG or WebP with transparency, whatever the file is called | WebP steps. If the browser can't write WebP (Safari answers with a PNG), PNG at 1920, 1600, 1280, 1024, 800. **Never a JPEG step**, so never flattened onto black. If the transparency check itself can't run, the image counts as transparent. Only bytes that really start `FF D8 FF` skip the check. |
| Within the limit and no larger than 1920px | The same `File` object goes up, no upscale, no re-encode. Preview only, using the old rule (wider than 480px). |
| Over 1920px and within the limit, but re-encoding doesn't shrink it | Original is kept |
| Animated WebP or PNG within the limit, over 1920px | The same `File` goes up, still animated, at its full size. Only the preview is made. |
| Animated WebP or PNG over the limit | Plain message, nothing sent. Shrinking it would stop the animation. |
| GIF, SVG | Left as they are, nothing encoded, server rules apply. An oversized one is refused by the server and the founder reads plain words. |
| HEIC the browser can open (Safari) | JPEG, even when small, because the server refuses HEIC |
| HEIC it can't open | Plain message, nothing sent |
| Other image types (AVIF and so on) | Same as HEIC, with the general "couldn't open" message. The same with an empty type and a `.avif` name. |
| Older type names (`image/jpg`, `image/pjpeg`, `image/x-png`, `image/apng`) | Treated as the standard type, so the rows above apply. A small one goes up with its bytes unchanged. |
| Empty type and a name we know (including `.jfif` and `.apng`) | The name fills in the type |
| Empty type and no name we know | The first bytes decide. JPEG, PNG, WebP and GIF follow their rows above. Anything else that opens becomes a JPEG. Anything that won't open gets "isn't an image". |
| Not an image, as the browser reports it | Plain message, nothing decoded, nothing sent |
| An empty file | Plain "is empty" message, nothing decoded, nothing sent |
| Can't fit under the limit | Plain message, nothing sent |
| JPEG, PNG or WebP the browser can't open, any size | Plain "couldn't open" message, nothing sent. The server only checks the first bytes, so a damaged JPEG with a good header would otherwise be stored and show as a broken image. |
| A still image with the wrong name, small in bytes and in pixels (PNG bytes called `.jpg`) | Opens fine, goes to the server, and the magic-byte check refuses it in plain words. |
| A still image with the wrong name, over the limit or over 1920px | The first bytes decide, not the name. Transparent stays transparent (WebP, or PNG in Safari), never a JPEG step. Solid becomes a JPEG. It uploads. If re-encoding wouldn't shrink it, it falls back to the row above. |
| An animated PNG or WebP, or a GIF, with the wrong name, over the limit or over 1920px | Plain "isn't really the kind of image" message, nothing encoded, nothing sent. Never made still. The small ones get the same message from the server. |
| A browser with no `createImageBitmap` at all | Nothing can be checked here, so small files go to the server, which decides. No dimensions and no preview. |

## Acceptance

Tags: unit = plain node. There is no JSX-capable runner in the repo yet (spec 8.15), so nothing here is tagged rendered. Component behaviour is covered by source scan plus the browser drill.

Evidence command for all unit rows: `pnpm test:media-upload` → **100 passed, 0 failed**. Quoted names are test names.

| # | Item | Tag | Status | Evidence |
|---|---|---|---|---|
| 1 | A 5MB phone photo uploads with no error, with a long edge of at least 1920px after resize and within the server limit | unit + browser drill | Logic passes through the real route. **Real photo NOT browser verified.** | "ACCEPTANCE: a 5MB phone photo uploads...": a 5,000,000 byte 4032x3024 file through `uploadImage` with a stand-in encoder, into the real `POST` handler and real `saveMedia`. The stored row is checked: 1920x1440, within 1.5MB, thumbnail attached. Drill 1. |
| 2 | MediaPicker and MediaAdmin use one upload path | unit (source scan) + browser drill | Passes scan. **Not browser verified.** | "MediaAdmin and MediaPicker both upload through uploadImage and hold no copy of their own"; "nothing else in the console posts files to the media route". Drill 2. |
| 3 | Negative: a file that is not an image is refused with a plain message | unit + browser drill | Passes. **Not browser verified.** | "NEGATIVE: a file that isn't an image...", "a damaged photo small enough to send...", "every real server refusal maps to plain words" (feeds real `validateUpload` output through the mapper). Drill 7. |
| 4 | Negative: SVG sanitizing and magic-byte checks still run on the server, exactly as they were | unit | Passes on the real route, comparing the exact stored bytes | "route: every SVG element that can run or load something..." (script, foreignObject, iframe, object, embed, animate, set, handler), "route: every event handler...", "route: unsafe links..." (javascript, data, http, protocol-relative and others; safe links kept), "route: files that only look like an image..." (RIFF that isn't WebP, the `<?php` guard, the sniff window; asserts nothing stored), "route: an SVG is measured and sniffed after cleaning...", "route: a PNG signature with nothing after it...", "route: PNG bytes declared as JPEG...", "magic-byte sniffing still decides...", "magic-byte sniffing checks every byte...", "route: the stored file name is cleaned...", "route: a bad preview never costs the photo". `git diff 939d630 -- lib/media.js` is empty. These pin the cases they list, not every possible change to `lib/media.js`. |

Items from the task brief beyond the spec's list:

| Item | Tag | Status | Evidence |
|---|---|---|---|
| Server limits unchanged, proven by test | unit | Passes | "server limits are unchanged, and the browser's copy matches them", "server size limit holds at the exact byte for every type", "route: a raw 5MB photo sent past the browser step is still refused" |
| Size planning is a pure function plain node can test | unit | Passes | "— size plan" section; "lib/media-upload.js stays browser-safe: no server imports" |
| Transparent PNG is not flattened, whatever the file is called | unit + browser drill | Plan and path pass. One-off Chrome probe of the module passes. **Not verified on a console screen or in Safari.** | "steps: a transparent image never gets a JPEG step", both "transparent PNG" path tests, "wrong name, see-through picture...". Drill 3. |
| Already small image: no upscale, no needless recompress | unit | Passes | "an already small image goes up byte for byte...", "re-encoding that would grow the file keeps the original" |
| Animated PNG, animated WebP and GIF are not silently flattened, whatever the file is called | unit + browser drill | Passes. Real Chrome probed. **Display not verified.** Animated AVIF and HEIC are the exception, see "Known limits". | "isAnimated reads the file's structure...", "an animated WebP or PNG within the limit...", "...over the limit...", "wrong name, moving picture or GIF...", "an animated PNG the browser calls image/apng...". Drill 8. |
| Retry works after a failed upload, in both places | unit + browser drill | Real handler source passes. **Not browser verified.** | "library, connection down...", "picker, failed...". Drill 7. |
| SVG and GIF left as they are | unit | Passes | "SVG and GIF are left exactly as they are...", "a GIF over the limit..." |
| HEIC the browser can't decode gets a plain message | unit + browser drill | Passes with a stand-in decode failure. **Real browsers not verified.** | "HEIC this browser can't open...", "HEIC this browser can open (Safari)...". Drill 5. |
| Can't compress under the limit gets a plain message | unit | Passes | "an image that can't fit...", "transparent PNG too detailed for PNG in Safari..." |
| Progress, not a size error | unit + browser drill | Labels, order and the idle check pass. The banner's place in the JSX is scanned with comments stripped, not rendered. **Display not verified.** | "progress: the founder sees stages...", "the progress banner draws nothing while idle...", "MediaAdmin and MediaPicker both upload...". Drill 2. |
| Closing the picker during an upload doesn't fill the spot | unit + browser drill | Real handler source passes. **Not browser verified.** | "picker closed during an upload...", "picker closed during an upload that fails...", "picker: every open and every close counts...". Drill 2. |

### Do the tests bite?

Three one-off mutation runs (each break applied, `test:media-upload` run, file restored), not committed.

- First build: ten breaks, all red: server limit raised, magic-byte check removed, SVG sanitizing skipped in `saveMedia`, a JPEG step added for transparent images, upscale allowed, target lowered to 1600, always re-encode, trusting the requested output type (the Safari case), HEIC message dropped, picker moved off the shared path.
- Fix round 1: 68 breaks, **0 survived**. That covers every survivor the review listed, plus each fix made in this round being undone. On its first pass 4 survived, each now pinned: a browser with no decoder and a too-big file, a preview stored as what it really is, the library resetting its input before the refresh, and a crude letter-scan in the PNG check.
- Fix round 2: 62 breaks, 61 red. That covers every survivor this review listed, plus each fix being undone. The one survivor is removing the `b.length >= 12` guard from the WebP sniff, which changes nothing: the last byte it checks is at position 11, so a shorter file already fails.

These prove the suite notices those particular breaks, not that it notices every break.

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

- Related: test:media-upload 100/0, test:storefront 15/0, test:releases 25/0, test:agency 16/0, test:admin-console 9/0, test:cms-api 20/0, test:security 13/0, test:tenant-boundary 24/0 (passed/failed).
- Every `test:*` except `test:perf`, 40 suites (the 39 at baseline plus test:media-upload), run four times on the final code. **One run had 0 failed. The other three each had 1 failed, always one of two suites that also fail at random on the baseline:**
  - `test:shopify-push` failed 2 of the 4 full runs. Run on its own 25 times: 12 failures at 939d630, 5 on this branch. The failing tests change from run to run, and all are retry tests. Timing is the likely cause, but that wasn't confirmed.
  - `test:cms-api` failed 1 of the 4 full runs, on "history: console saves trail...". Run on its own 40 times: 8 failures at 939d630, 8 on this branch.
  - This branch changes nothing either suite imports, and they were left alone. The baseline note that all 39 pass holds only for a lucky run. Worth its own item, because a real failure in either suite is easy to wave away.
- `pnpm build` exits 0 on this round's code and compiled the changed client components. Its two Turbopack warnings both trace through `lib/platform/migrate.js`, which this change doesn't touch. Round 1 recorded three.

## Fix round 1

An independent reviewer's findings. Each was checked against the code first, and all were accurate.

| Finding | Result |
|---|---|
| The server-rules proof only covered part of the sanitizer and sniffer | Fixed. Route-level tests now compare exact stored bytes, or assert nothing was stored. `lib/media.js` still unchanged. |
| Library retry did nothing with the connection down: a failed refresh skipped the input reset, and the promise rejected unhandled | Fixed. The input resets first and a failed refresh is caught. Drill 7 now retries in both places. |
| This packet overclaimed on damaged files | Fixed the behaviour and the row: a JPEG, PNG or WebP the browser can't open is refused with the "couldn't open" message. |
| A small animated WebP over 1920px silently became a still JPEG | Fixed for WebP and PNG. Reads the file's own structure instead of searching for `ANMF`/`acTL`, which can occur by chance in a big file's picture data and would wrongly refuse it. |
| `imageOrientation` could reject in an older browser, making any big JPEG "damaged" | Fixed. Retries without the option on a `TypeError`, and damage isn't retried. Oldest supported iOS Safari added to drills 4 and 5. |
| Test gaps in reachable logic and wiring | Fixed. The upload handlers in both components now run from their real source text with stand-ins for React, which goes further than the source scan the review asked for. The JSX lines are still only scanned. |
| Founder copy | Fixed. See "Differences from the spec". |

One-off headless Chrome 156 probe of this branch's `lib/media-upload*.js`, with the review's fixtures and a stand-in send. It covers only that code, not a console screen:

| Fixture | Result |
|---|---|
| Animated WebP, 3 frames, 2400x1200, 16,300 bytes | Sent as `anim.webp`, same size and type, 2400x1200 |
| 40,000 bytes starting FF D8 FF E0, then filler | "We couldn't open", nothing sent |
| A real JPEG cut in half | "We couldn't open", nothing sent |
| Real still WebP, 2400x1200 | Still resized to 1920x960 |
| Sideways phone photo, with the browser forced to reject the `imageOrientation` option | 1440x1920, the same result as without forcing |
| Detailed transparent PNG, with `toBlob` forced to answer WebP requests with PNG | Stored 800x800. Notice: "cutout.png" uploaded. It had to be made smaller to fit, so it's now 800×800 pixels and could look soft on a big banner. |

## Fix round 2

A second independent review. Each finding was checked against the code first, and all were accurate.

| Finding | Result |
|---|---|
| A transparent PNG named `.jpg`, over the limit or over 1920px, was flattened onto black. An animated PNG, animated WebP or GIF named `.jpg` became a still image. | Fixed. Once a file is going to be re-encoded, its first bytes decide, not its name. See "How each case is handled". Of the two fixes the review offered, this one keeps a big wrongly named solid picture uploading, as it already did. Refusing it would send a founder away with advice they may not be able to follow. |
| The server-rules proof still missed real weakening of `lib/media.js`, and the test file's comment said otherwise | Fixed. Exact-byte and shortest-length sniff cases, SVG limit and sniff measured after cleaning (four cases), file name cleaning through the route, a bad preview keeping the original. Comment corrected. `lib/media.js` still unchanged. |
| This packet overclaimed on wrong-named files and flattening | Fixed by the first row, and the rows now state size and name separately. |
| Progress display proof could be defeated | Fixed. Scans drop comments first, the banner must sit on a line of its own, and the idle guard runs from its real source text. Busy and disabled states are scanned. JSX is still scanned, not rendered. |
| Unusual types got the wrong treatment | Fixed. Older type names map to the standard ones, `.jfif` and `.avif` added. No type and no known name now asks the file's bytes, then tries to open it, before saying "isn't an image". |
| `image/apng` and `.apng` skipped the animation rules | Fixed. Both map to `image/png`, so the existing rules apply. |
| Closing the picker during an upload still filled the spot, and could close a picker opened for another spot | Fixed. The picker tracks each open and close. If it closed since the upload started, nothing is placed, the image stays in the library, and a toast says so. A failure becomes a toast instead of a banner in a closed dialog. Blocking the close was rejected: a stalled upload would trap the founder in the dialog, since the XHR has no timeout. |
| Small client test gaps; the "is empty" message couldn't appear for a photo | Fixed. Exact-limit encode, the full ladders, the `.jpeg` empty-type case and the preview's form name are pinned. `prepareImage` now says "is empty" before trying to open the file. |

One-off headless Chrome 156 probe of this branch's `lib/media-upload*.js`, inlined into one local page, with real canvases and no send. It covers only that code, not a console screen. "Corner" is the top-left pixel of the output, decoded again, where the source's corner is see-through in the transparent cases.

| Fixture | Result |
|---|---|
| Transparent PNG, 2600x2600, typed `image/jpeg`, named `cutout.jpg` | `cutout.webp`, 1920x1920, corner `[0,0,0,0]`. The review's probe saw `[0,0,0,255]`, black, from the old JPEG step. |
| The same, padded to 2MB | The same |
| Solid PNG, 2600x2600, typed `image/jpeg` | `shot.jpg`, JPEG, 1920x1920, corner `[255,255,255,255]` |
| Real two-frame APNG, 2600x2600, typed `image/jpeg` | "isn't really the kind of image", nothing encoded |
| The same APNG typed `image/apng`, and with no type and a `.apng` name | Sent as `anim.apng`, `image/png`, same size, 2600x2600 |
| GIF padded to 2MB, typed `image/jpeg` | "isn't really the kind of image" |
| Real animated WebP, 3 frames, 2400x1200, typed `image/jpeg` | "isn't really the kind of image" |
| The same WebP, correctly typed | Sent as `moving.webp`, same size, 2400x1200 |
| Empty file typed `image/jpeg` | "is empty" |
| Small real JPEG typed `image/pjpeg` | `image/jpeg`, same size in bytes |
| Small real JPEG, no type, named `camera_upload` | `image/jpeg`, same size in bytes |
| Words, no type, named `notes` | "isn't an image" |

How often real devices send these older type names was not measured, and whether Chrome reports `image/apng` for a picked `.apng` file was not checked, because a script can't set a file input. Drill 7 covers the names a browser really sends.

## Browser drill still needed

Run on `pnpm dev:design`, signed in as owner, and commit screenshots or a recording per spec 8.15. Do each upload from both Storefront → Media (MediaAdmin) and an image field's picker (MediaPicker) unless noted.

1. **Real phone photo.** Upload a real JPEG of about 5MB, 4000px wide. Expect no error, `image/jpeg` in the library, 1920 on the long edge, under 1.5MB, "+thumb" shown. Look at it full size: sharp, and colours match the original (iPhone photos are Display P3).
2. **One path and progress.** Upload the same kind of file from both places. Expect "Getting … ready…", "Uploading … N%", "Saving…" in a banner in both, on a throttled connection so the percent moves. Both uploads end with dimensions and a preview in the library. In the picker the grid loads the preview (`/api/media/<thumb id>` in the network panel), and the picked image lands in the field. Then, on a throttled connection, start a picker upload and close the dialog with Escape: the spot stays as it was, and a toast says the image is in the library and wasn't added. Repeat, reopening the picker for a different spot before the upload ends: neither spot changes and the reopened picker stays open. Repeat with the network going off after closing: a toast gives the "didn't go through" message.
3. **Transparent PNG.** Upload a transparent PNG over 1.5MB, once in Chrome and once in Safari. Check over a coloured background: corners stay see-through, no black. Chrome should store WebP. Safari should store PNG at whatever size fits. Repeat with the same file renamed `.jpg`: same result. Also a transparent PNG with a single see-through area, to confirm the check catches it. Confirm in Safari that `toBlob` really answers a WebP request with a PNG blob, as the code assumes. If it lands well below 1920, a toast gives the final size, from the picker as well as the library.
4. **Sideways photos.** A portrait phone photo with EXIF rotation stays upright after resize, and the recorded width and height match (expect 1440x1920). Repeat on the oldest iOS Safari we support: that is where the `imageOrientation` option may be rejected, and whether the retry without it still gives an upright photo is unknown.
5. **HEIC.** (a) iPhone Safari: pick a HEIC from Photos. With `accept="image/*"` iOS is expected to hand over a JPEG. Confirm it does and that it uploads. (b) Mac Safari: a `.heic` file, expect it to arrive as JPEG in the library. (c) Chrome on Mac or Windows: a `.heic` file, expect the plain HEIC message and no POST in the network panel. (d) Android Chrome: confirm the gallery offers photos and what a HEIC does there. (e) The oldest iOS Safari we support: a large phone photo uploads and isn't called damaged.
6. **Small and unchanged.** An 800px JPEG under 1.5MB: the stored file has the same size in bytes as the original. A 300px PNG: no "+thumb". Nothing looks blurred or grown.
7. **Refusals in plain words.** A PDF (choose "All files"): plain "isn't an image". A PDF renamed `.jpg`, and a damaged JPEG with a good header: plain "couldn't open", no POST in the network panel. A small PNG renamed `.jpg` (under 1.5MB and under 1920px): plain "isn't really the kind of image". A zero-byte `.jpg`: plain "is empty", no POST. A photo with no file extension, and a `.jfif`: uploads. Note the type each one reports, if a browser tool shows it. A GIF over 1.5MB and an SVG over 300KB: plain "too big". Network off during upload: plain "didn't go through", in both the library and the picker. With the network still off, re-pick the same file in each and confirm it starts again and says the same thing. Turn the network on, re-pick once more, and confirm it uploads.
8. **SVG, GIF and animated files.** A small SVG with a script: stored version has no script (open `/api/media/<id>`). An animated GIF stays animated. An animated WebP and an animated PNG over 1920px and under 1.5MB stay animated, with the file name unchanged. The same over 1.5MB: plain "animated image and it's too big". An animated PNG, an animated WebP and a GIF each renamed `.jpg`, over 1.5MB or over 1920px: plain "isn't really the kind of image", no POST. A file named `.apng`: follows the animated PNG rules.
9. **Phones.** On a real iPhone and Android, a large photo from the camera (`image/*` also offers the camera) completes without the tab crashing or running out of memory. Try a 48MP photo if a device has one: decoding it is the heaviest step and is not bounded in code.
10. **Hosted limit.** On staging, not on the harness: one full-size upload with a preview, to confirm the hosting platform's request limit isn't reached and the XHR path works through the proxy.

## Differences from the spec, and decisions

- **`accept` changed to `image/*`** in both pickers. The old explicit list stopped a HEIC on a Mac or Android being picked at all, so the plain message could never appear. My understanding is that iOS turns HEIC into JPEG for `image/*` as it did for the old list, and would stop doing so if HEIC were listed explicitly, but I could not check that here: drill 5(a).
- **A photo can end up below 1920px** in one case: it doesn't fit at 1920 even at quality 0.55. It then goes to 1600 or 1280 rather than being refused, because the founder asked for a photo to work, and a toast gives the final size. The spec's 1920 target holds for a normal 5MB photo. If reviewers want a hard 1920 floor, remove `LAST_RESORT` and the message path already handles it.
- **Over 1920px but within the limit is resized.** "Already small" is read as small in bytes AND in size, and the original is kept if re-encoding doesn't shrink it.
- **The "made smaller" notice is a toast in the picker, not a banner.** Picking an image closes the dialog, so a banner inside it would disappear at once. The toast provider sits in the console root layout, so the toast outlives the dialog. It shows for 5 seconds.
- **HEIC advice no longer assumes an iPhone:** "Save it as a JPEG first, or upload it from a phone browser that can open it."
- **Small files the browser can't open are now refused here,** where before they went to the server. A browser with no `createImageBitmap` still sends them, so it isn't locked out.
- **Opaque PNG and WebP become JPEG** when they must be re-encoded. It is the one format every browser can write. A hard-edged screenshot will show a little JPEG softness; only files over the limit or over 1920px are affected.
- **MediaPicker preview fix.** `thumbOf` read `t?.url`, but listed variants carry no url, so it always loaded the full image. Picker uploads now make previews, so this is a one-line fix to use them. It goes slightly beyond "one upload path".
- **Both file inputs now reset** after each upload, even with the connection down, so picking the same file again after an error works.
- **GIF and SVG over the limit are still sent** and refused by the server, as the brief says, rather than checked first. A huge GIF wastes an upload before the plain message.
- **Limit numbers exist twice.** `lib/media.js` imports the db, so the browser can't import it, and `lib/media.js` was to stay untouched. The first test fails if the copies differ.
- **Spec 8.15 lists "resize path" under `test-media-refs`.** The brief names `test:media-upload`, so it lives there.
- **`sniffImage` is a second copy of the server's first-bytes rules,** for the same reason as the limit numbers. A test fails if the two disagree on any of its samples.
- **Reading the whole file before re-encoding** now applies to JPEGs too, because the name can't be trusted. A phone photo's file is small next to its decoded image, so this adds little to the memory drill 9 is checking.
- **The spec's citations were accurate** against 939d630: `lib/media.js:9-10`, `lib/media.js:15-21`, `MediaAdmin.js:73`, `MediaPicker.js:47`.

## Known limits, not fixed

- **Animated AVIF and HEIC sequences** are written from their first frame with no warning, under their own name or called `.jpg`, because their structure isn't read. The server can't take those formats anyway, so nothing that used to work has changed.
- **A wrongly named still image gets a different answer depending on size.** A big PNG called `.jpg` uploads. A small one is refused with "isn't really the kind of image", because it goes up unchanged and the server's check runs. Sending a small one under its real type would make both upload, but it changes what the wrong-name drill and the server refusal mean here, so it needs a decision of its own.
- **A HEIC with no type and no extension** gets "isn't an image" in a browser that can't open it, which isn't true. Only the first bytes of JPEG, PNG, WebP and GIF are recognised.
- **Closing the picker during an upload** doesn't cancel it. It carries on with nothing on screen until its toast. Reopening the picker shows the banner again.
- **Damage the browser can still open.** A photo with some bad picture data can decode with a smeared area, pass, and be stored. A damaged GIF is left to the server, which only checks the first bytes, as it did before.
- **A small file with enormous dimensions** can run out of memory on decode and get the "may be damaged" message, which isn't the real reason. Before this round it would have been stored.
- **A browser with no way to open images** stores 0x0 for dimensions, because `saveMedia` turns a missing width into 0. The library hides 0, and this is unchanged from before.
- **A successful upload with a failed refresh** shows the success toast, but the new file stays out of the library list until the page reloads.
- **Sanitizer gaps, already there before this work and deliberately left alone,** because the brief says `lib/media.js` stays as it is. It removes tags in a single pass, so `<scr<script></script>ipt>` comes out as a working `<script>`. It also leaves unquoted `href=javascript:...` alone. Confirmed by running the real function. The media route's `default-src 'none'` CSP blocks script execution, and only signed-in staff can upload, so nothing runs today. Worth its own item. The new tests pin what the sanitizer does today and don't claim it is complete.
- **Location data.** An already small phone JPEG goes up byte for byte, so any EXIF location in it is stored and served, as it was before. Resized photos lose EXIF. Worth a decision outside this item.
- **A second copy is possible.** Dedupe compares output bytes, so the same photo resized by a different browser is stored again.
- **A multi-file upload in the library stops at the first failure,** as it did before. The message names the file that failed but not the ones left unsent.
- **Text progress only,** no bar.
- **The route test depends on `node:module` `registerHooks`** (Node 22.15 or later) to resolve the route's `@/` and `next/*` imports. Ran here on Node 26. The repo sets no `engines` field.
