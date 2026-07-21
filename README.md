# MangaLens

MangaLens is a browser extension. It translates manga panel text automatically in real time using the Google Gemini API.

It erases original manga text and draws the English translation directly onto the manga page canvas.

---

## Features

- **In-Place Canvas Translation**: Erases original text and paints English translations directly on the manga image.
- **Automatic Language Detection**: Detects source languages including Japanese, Vietnamese, Korean, Chinese, and Thai.
- **Automatic Model Fallback**: Retries secondary Gemini models automatically if the primary model fails.
- **Rate Limit Management**: Controls API request frequency to match Google Gemini rate limits.
- **Overlay Fallback**: Renders HTML text overlays if canvas inpainting is unavailable.
- **Local Storage Caching**: Saves translations locally to avoid redundant API requests.
<img width="805" height="990" alt="Screenshot 2026-07-21 122705" src="https://github.com/user-attachments/assets/86fbcb38-7cbe-403c-99ec-7e29e8b26097" />
<img width="770" height="1008" alt="Screenshot 2026-07-21 122716" src="https://github.com/user-attachments/assets/81fec140-1bbb-4e69-b151-e76c12d084f1" />

---

## Prerequisites

Before installation, ensure you have:
1. A Chromium browser (Google Chrome, Microsoft Edge, or Brave).
2. A Google Gemini API Key. Get a free API key from [Google AI Studio](https://aistudio.google.com/apikey).

---

## Installation

Follow these steps to install MangaLens in your browser:

1. Download or clone this repository to your local computer.
2. Open your web browser.
3. Open the extensions page:
   - **Google Chrome**: Enter `chrome://extensions` in the address bar.
   - **Microsoft Edge**: Enter `edge://extensions` in the address bar.
   - **Brave**: Enter `brave://extensions` in the address bar.
4. Enable **Developer mode** using the toggle switch in the top right corner.
5. Click **Load unpacked**.
6. Select the extension directory containing `manifest.json`.

---

## Usage Instructions

### Step 1: Set Up API Key

1. Click the **MangaLens icon** in your browser toolbar.
2. Paste your Gemini API key into the **API Key** input field.
3. Click **Save Key**.

### Step 2: Translate Manga

- **Automatic Translation**: Enable **Auto-Translate** in the popup. Images translate automatically as you scroll.
- **Manual Translation**: Hover your mouse over any manga image and click **Translate**.

### Step 3: Toggle Original View

- Click **Show Original** on any translated panel to view the original image.
- Click **Show Translation** to re-apply the translation overlay.

---

## Troubleshooting

### Issue: Translation does not load
1. Verify that your API key is valid in the MangaLens popup.
2. Confirm that **Enable Extension** is turned on.
3. Click **Clear Cache** in the popup, then reload the web page.

### Issue: Rate Limit Notice
- Google Gemini free tier permits 10 to 15 requests per minute.
- Wait a few seconds. MangaLens handles retries automatically.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for full details.
