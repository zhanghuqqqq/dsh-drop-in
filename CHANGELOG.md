# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-09-07

### Fixed

- **DSH's native "图片拖动到此处即可添加" (images-here) overlay stayed on screen forever after dropping a takeover-kind item (e.g. a spreadsheet).** Root cause: that overlay is driven by `ComposerAttachments`' document-**bubble** `dragenter` listener incrementing a depth counter, and its own bubble-phase `drop` handler is the only thing that resets it. v0.1.1's capture-phase `stopPropagation()` on drop correctly blocked that handler — which removed the "images only" toast but also removed the counter reset, leaving the overlay stuck. Fix: the plugin now stops propagation at the **capture** phase for `dragenter` and `dragover` as well, so for takeover kinds the native attachment pipeline never sees the drag at all — its overlay never shows and its counter never increments. Passthrough kinds (pure local images, folders) still reach the native pipeline untouched.

### Added

- `tests/overlay-propagation.sim.mjs`: a DOM-propagation simulation proving the capture-phase blinding (takeover drags never reach the native bubble listeners; passthrough lifecycles stay intact).

## [0.1.1] - 2026-09-07

### Fixed

- **Drag overlay never disappeared after drop.** Root cause: the author stylesheet rule `.ddi-overlay { display: flex }` always overrode the browser's UA default `[hidden] { display: none }` (author normal beats UA normal in the CSS cascade regardless of specificity), so `overlayEl.hidden = true` had no visual effect. Visibility is now driven by an explicit `.ddi-visible` class (`.ddi-overlay` defaults to `display: none`), with `showOverlay`/`hideOverlay` symmetrically adding/removing it. Two explicit hide paths were added alongside the existing 180 ms dragover watchdog: `dragleave` (hides only when the pointer truly left the window, `relatedTarget === null`) and `dragend` — all four hide paths (drop / dragleave / dragend / timer) are now explicit.
- **Dropping a non-image file popped DSH's native "images only" toast.** Root cause: `onDrop` called `preventDefault()` without `stopPropagation()`, so the event still reached the document-bubble drop listener of DSH's native attachment pipeline (`ComposerAttachments`), which rejected non-image files. Takeover kinds (files / url / text / data-url / too-many) now call `event.stopPropagation()` right after `preventDefault()`; passthrough kinds (pure local images, folders) and the anti-navigation safety net are untouched, so native vision attachments and workspace-folder adoption keep working.

### Documentation

- README troubleshooting: added the known low-severity residual — dropping a non-folder file onto the workspace panel shows both the desktop shell's inline "exactly one folder" hint and this plugin's upload toasts; upload is unaffected, the shell hint can be ignored.

## [0.1.0] - 2026-09-06

### Added

- Initial release of the dsh-drop-in drag & drop input plugin for DeepSeek Harness.
- Global dragover/drop interception with a drop classifier: local files (any type, up to 20) → streamed upload to `<workspace>/.dropped/<sessionId>/` and `[附件: name](absolutePath)` references appended to the composer; web images / links → host-side streamed download (redirect-following, retry, 2 GiB cap) then referenced the same way; plain text → inserted into the composer, >5000 chars saved as a `.md` file.
- Passthrough rules: pure local images keep DSH's native vision-attachment pipeline; folders keep native workspace adoption.
- Host routes under `/dsh-drop-in/v1`: `PUT /upload`, `POST /fetch-url`, `POST /save-text`, `DELETE /file` — with session validation, filename sanitizing, `_1/_2` dedupe and path fencing.
- Per-session system-prompt injection describing the drop-file reference convention for the model.
- Host-side smoke test suite: 12 scenarios in `tests/smoke.mjs` (mock context + local origin server).
