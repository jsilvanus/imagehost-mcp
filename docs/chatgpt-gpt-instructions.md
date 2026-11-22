# Configuring ChatGPT Custom GPT for ImageHost

This document provides instructions for integrating OpenAI ChatGPT Custom GPTs with your ImageHost / Kuvarasto service.

---

## 1. Overview

With this integration, whenever your Custom GPT generates an image (using ChatGPT's native DALL-E image generation) or receives an image in chat, it automatically imports the image directly into your permanent ImageHost S3-backed storage and provides you with a permanent, shareable URL.

### Ingestion Flow:
```
User -> Custom GPT: "Generate a dramatic sunset over Finnish lakes"
Custom GPT -> DALL-E: Generates image
Custom GPT -> ImageHost Action: POST /api/chatgpt/import with openaiFileIdRefs
ImageHost -> OpenAI CDN: Validates host (SSRF safe), downloads image buffer
ImageHost -> Sharp: Validates file magic bytes, generates WebP thumbnail & preview
ImageHost -> S3: Stores original and WebP variants
ImageHost -> ImageHost DB: Persists metadata in user photo group (default "ChatGPT")
ImageHost -> Custom GPT: Returns permanent URL and image ID
Custom GPT -> User: Displays image with permanent ImageHost link
```

---

## 2. Server Configuration

Ensure your ImageHost deployment has the following environment variables set (in `.env` or Docker Compose):

```bash
# Set a shared secret Bearer token for your Custom GPT Action:
CHATGPT_API_KEY=your-secure-random-bearer-token-here

# Optional overrides (defaults shown):
CHATGPT_ALLOWED_DOMAINS=oaiusercontent.com,openai.com
CHATGPT_MAX_DOWNLOAD_BYTES=26214400 # 25 MB
CHATGPT_DOWNLOAD_TIMEOUT_MS=15000   # 15 seconds
```

---

## 3. Creating & Configuring the Custom GPT

1. Open **ChatGPT** and navigate to **Explore GPTs** -> **Create a GPT** (or edit an existing one).
2. Go to the **Configure** tab.
3. Fill in basic details:
   - **Name**: `ImageHost Creator` (or your preferred name)
   - **Description**: `Generates images and permanently archives them in Kuvarasto / ImageHost.`
   - **Capabilities**: Ensure **DALL·E Image Generation** is **enabled**.

### Setting Up Instructions
In the **Instructions** box, copy and paste the following prompt:

```markdown
You are a creative visual assistant connected to the user's personal ImageHost photo library.

Whenever you generate an image using DALL-E or when the user asks you to save a generated visual:
1. Immediately invoke the `importChatGptImages` action.
2. Provide the generated image in the `openaiFileIdRefs` parameter.
3. Provide a clear, descriptive caption in the `description` parameter and relevant tags in `tags`.
4. Wait for the action response:
   - If `success` is true, display the image in chat and provide the permanent ImageHost URL returned in `url`.
   - Report the assigned sequence number and image ID.
   - If the action returns an error or fails, explain transparently that saving to ImageHost failed, report the error details, and do NOT claim the image was archived.
5. Do not prompt the user to manually download or re-upload files.
```

---

## 4. Adding the Action

1. In the Custom GPT editor, scroll down to **Actions** and click **Create new action**.
2. **Schema**:
   - You can either click **Import from URL** and enter:
     ```
     https://kehitys.riihimaenseurakunta.fi/kuvarasto/api/chatgpt/openapi.yaml
     ```
     (or your instance's domain: `https://<YOUR_HOST>/api/chatgpt/openapi.yaml`)
   - Or open [docs/openapi/chatgpt-actions.yaml](./openapi/chatgpt-actions.yaml) and copy-paste the YAML contents directly into the Schema box.
3. **Authentication**:
   - Click the gear/settings icon next to **Authentication**.
   - You can choose either **OAuth** or **API Key**:
     - **Option A: OAuth 2.0 (Recommended for multi-user / personal library attribution)**:
       - **Authentication Type**: Select **OAuth**.
       - **Client ID**: `kuvarasto` (or your client ID in Tunnus)
       - **Client Secret**: `<Tunnus client secret>`
       - **Authorization URL**: `https://kehitys.riihimaenseurakunta.fi/identity/auth`
       - **Token URL**: `https://kehitys.riihimaenseurakunta.fi/identity/token`
       - **Scope**: `openid profile email`
       - **Token Exchange Method**: Default (Basic Authorization header or Request Body)
     - **Option B: API Key (Simpler for personal single-user GPT)**:
       - **Authentication Type**: Select **API Key**.
       - **Auth Type**: Select **Bearer**.
       - **API Key**: Enter the value configured in your server's `CHATGPT_API_KEY` (or your personal session token).
4. **Privacy Policy**:
   - Enter your public privacy policy URL or your ImageHost base URL (e.g. `https://kehitys.riihimaenseurakunta.fi/kuvarasto`).
5. Click **Save** (or **Update**) in the top right corner.

---

## 5. Security & Isolation

- **SSRF Prevention**: The ImageHost GPT Action adapter resolves the DNS of download URLs and strictly denies private/loopback IP addresses (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local, multicast, etc.).
- **Domain Allowlisting**: Only trusted OpenAI hostnames (`*.oaiusercontent.com`, `*.openai.com`) are permitted.
- **Payload Validation**: Magic byte inspection validates image format integrity (JPEG, PNG, WebP, GIF) before ingestion.
- **Resource Protection**: Downloads exceeding 25MB or 15-second timeouts are aborted immediately to prevent resource exhaustion.
