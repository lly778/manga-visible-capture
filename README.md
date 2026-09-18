# Manga Visible Capture

A Chrome extension for batch-capturing a selected visible manga region and exporting the screenshots as one ZIP archive.

## Features

- Automatically detect a likely manga viewer region or select one manually.
- Capture only the visible selected region.
- Turn pages by clicking either side of the viewer or sending arrow keys.
- Continue until manually stopped, the page URL changes, or the captured page stops changing.
- Choose the page-turn wait time from `0.1` to `30` seconds in `0.1`-second steps.
- Use the current page title as the default ZIP filename.
- Keep screenshots in memory and download one ZIP when the task stops.

## Install

1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this `chrome-extension` folder.

## Use

1. Open a manga page that you are authorized to access.
2. Click the extension icon.
3. Choose `自动识别区域` or `手动框选`.
4. Set the page-turn wait time, page-turn method, and ZIP filename.
5. Click `开始批量截图`.
6. Keep the target tab active. Use the floating `停止` button when finished.

The extension captures only what is visibly rendered in the active tab. It does not bypass login, payment, DRM, access-control, or anti-automation restrictions.
