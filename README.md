# Manga Visible Capture

A Chrome extension for batch-capturing a selected visible manga region and exporting the screenshots as one ZIP archive.

## Features

- Automatically detect a likely manga viewer region or select one manually. When a full-page image sits inside a taller viewer container, use the image's top and bottom edges rather than including surrounding page content.
- Trim broad black or dark-gray margins from automatically detected regions. If the first page occupies only the left half of a two-page viewer, reserve an equally wide blank slot on the right so later two-page captures fit. Small cuts at either outer page edge are corrected by the same rule; manual selection is unchanged.
- Capture only the visible selected region.
- Turn pages by clicking either side of the viewer or sending arrow keys.
- Continue until manually stopped, the page URL changes, or the captured page stops changing. Small animation and rendering differences are ignored when detecting an unchanged page. A full-page navigation still exports the screenshots already captured.
- Automatically check stability after every page turn and capture as soon as the page settles. No separate timing test or fixed wait needs configuration. Read only already-rendered canvases and images in the selected visible region at 40 ms intervals, including readers that compose a page from multiple image tiles, monitoring pixels, loading, position, transforms and opacity. A short 120 ms quiet interval confirms the final frame. If no suitable readable surface is available, use Chrome screenshots at least 550 ms apart and one additional unchanged sample. No image URLs or reader data APIs are used.
- Complete portrait pages use fast detection even with an empty second-page slot reserved for later spreads. Clipped pages and missing tiles still block capture. Screenshot-based detection reuses the saved page as its pre-turn baseline to avoid an extra screenshot before clicking.
- If a newly visible cross-origin image makes fast pixel sampling unreadable during a turn, switch to Chrome screenshots and compare with the saved pre-turn screenshot. Keep waiting for the final page to settle rather than abandoning it when the detection source changes.
- While using screenshot detection, retry fast pixel sampling between screenshot probes. When the next page becomes fully readable, confirm its pixels at the usual 40 ms / 120 ms intervals, then use one screenshot to verify the change against the saved page and save that exact sample. Cross-origin advertisements still use screenshot detection; no site-specific advertising exceptions are required.
- Save the last confirmed screen sample without another screenshot when its tab, crop and viewport still match. Once a captured frame has been cropped and stored, turn the next page while PNG encoding finishes; ZIP export waits for all encoding to complete. This removes additional saving work after stability confirmation without adding a fixed page delay.
- On Yanmaga, stop and export saved screenshots when its rental/end dialog is visible and no comic page remains visible. Do not capture the dialog or keep clicking while its background alternates. A recommendation beside a still-visible comic page does not trigger this stop.
- On KimiComi, stop before image-loading checks when the reader's final next-episode/favorite card is visible and no comic page remains visible. Ignore hidden episode viewers and the reader's intentional empty page; a visible comic placeholder still prevents premature stopping. Export saved comics without capturing the end card or opening the next episode.
- Covered preloads, broken images and animations that do not change the visible page do not block capture; substantial unloaded images on top still do. After successful turns, an unchanged stable page stops using twice the slowest settling time of the last four turns, with a 1.2-second minimum and an 8-second maximum. With no turn history, allow 8 seconds. Continuous movement times out after 30 seconds and exports saved screenshots. Progress explains the waiting reason. Settings saved by older versions cannot disable stability checking or add a fixed delay.
- Use the current page title as the default ZIP filename.
- Save ZIP files directly with the File System Access API, without the downloads permission or filename listeners. This removes the shared download-renaming path that conflicts with IDM.
- Keep screenshots in memory and open a save page when the task stops. Click Save ZIP to choose the destination with the page title prefilled. Cancelling or a write failure keeps the export available for retry.

## Install

1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this `chrome-extension` folder.

## Use

1. Open a manga page that you are authorized to access.
2. Click the extension icon.
3. Choose `自动识别区域` or `手动框选`.
4. Set the page-turn method and ZIP filename. Each page is automatically checked for stability before capture.
5. Click `开始批量截图`.
6. Keep the target tab active. Use the floating `停止` button when finished.
7. In the save page, click `保存 ZIP` and choose a location. Existing files require the system save dialog's overwrite confirmation; names are no longer automatically numbered by the downloads API.

Use desktop Chrome or Edge with `showSaveFilePicker` support. If a save page is closed, reopen it with `打开待保存的 ZIP` in the extension popup. Save before closing the browser or reloading the extension: pending archives are held in memory, not persisted to disk. Unsupported browsers display an error rather than falling back to a download that IDM can intercept.

The extension captures only what is visibly rendered in the active tab. It does not bypass login, payment, DRM, access-control, or anti-automation restrictions.
