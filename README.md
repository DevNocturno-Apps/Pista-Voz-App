# Pista & Voz

A browser-based audio and video studio. The Node server provides Google Photos Picker configuration and secure Instagram account authorization/publishing. The app can still be used locally without provider credentials; those integrations remain disabled until configured.

The mobile studio is organized as four steps: select a beat, record and process vocals, arrange the timeline and caption, then export or publish. The workflow navigation keeps the existing audio recording, rendering, device sharing, and Instagram integrations available throughout.

## Run locally

Requirements: Node.js 20 or newer.

```sh
npm install
cp .env.example .env
```

Set `APP_BASE_URL=http://localhost:3000` and generate local secrets:

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Use the first value for `SESSION_SECRET` and the second for `TOKEN_ENCRYPTION_KEY` in `.env`, then run:

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). Do not use a static file server for OAuth or publishing; the frontend calls this Node backend.

## Google Photos Picker setup

1. In Google Cloud Console, create a project, enable the **Google Photos Picker API**, and configure the OAuth consent screen.
2. Create an OAuth client ID for a **Web application**. Add the deployed site origin to its authorized JavaScript origins (and `http://localhost:3000` for local testing).
3. Create an API key restricted to the Google Photos Picker API and the deployed website's HTTP referrers.
4. Put the client ID in `GOOGLE_CLIENT_ID` and API key in `GOOGLE_API_KEY`.

The app requests only `photospicker.mediaitems.readonly`, keeps the access token in browser memory, opens Google's Picker, and imports the selected photo. A user can also choose an image from the device's native photo/file picker.

## Instagram publishing setup

1. Create a Meta developer app and add **Instagram API with Instagram Login**. Configure Business Login and request `instagram_business_basic` and `instagram_business_content_publish`.
2. Use an Instagram **professional account**. Add it to the app for development/testing; public users require the appropriate Meta App Review/Advanced Access approvals. Stories are available only for eligible business accounts.
3. Add this exact OAuth redirect URI to the Meta app's Instagram Business Login settings:

   `https://YOUR_PUBLIC_HOST/api/instagram/callback`

   For local testing, also add `http://localhost:3000/api/instagram/callback` if Meta accepts it for your app.

4. Set `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and `APP_BASE_URL` in the server environment. Never expose the app secret in frontend code.
5. Deploy the Node server at a public HTTPS URL with persistent storage for `data/` (sessions and temporary media). `APP_BASE_URL` must be that public URL: Instagram fetches the temporary MP4 from the server before publishing.
6. Configure `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` as independent random secrets. The app encrypts Instagram tokens server-side and uses secure, HTTP-only session cookies.

When connected, users can render an MP4 and publish a Feed video, Reel, or Story from the site. Instagram processing and eligibility restrictions still apply. The app never publishes until the user explicitly clicks **Publish to Instagram**.

### Uploading without a connected account

Direct publishing is optional. On a phone, prepare the mix, choose **Create video to share or upload**, select Post, Reel, or Story, and render the video. Tap **Share video** and choose Instagram in the phone's share sheet, then finish the upload in Instagram. Alternatively, save the video and upload it from Instagram's **+** button. On a computer, download the video and transfer it to your phone. Instagram generally expects MP4; if the browser creates a WebM file, use a browser/device that exports MP4 or convert it before uploading.

## Hosting

This repository includes a GitHub Actions workflow that publishes the browser app to GitHub Pages whenever changes reach `main`. After pushing, open the repository's **Settings → Pages**, select **GitHub Actions** as the build and deployment source if prompted, and share the Pages URL shown there. The site provides the browser-based studio, device photo selection, and save/share options.

GitHub Pages is static hosting; Google Photos Picker and direct Instagram publishing require the separate Node backend and provider configuration described above. Those options are unavailable on the Pages site, but device photos and local save/share remain available. If you later want the backend, this repository also includes a Render Blueprint in `render.yaml`; Render persistent disks require a paid web-service plan.

Do not commit `.env`, provider secrets, or session data.

## Important configuration

- Google Photos Picker and Instagram integrations are optional and report their setup status in the UI.
- Instagram's backend requires `APP_BASE_URL` to be publicly reachable over HTTPS in production.
- Temporary Instagram MP4 uploads are removed after about an hour.
- This project is not Meta-verified; Meta controls which accounts can authorize and publish until app review and access requirements are satisfied.
