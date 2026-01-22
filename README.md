# Telegram webhook server

Minimal Express server to receive Telegram webhook updates and print the payload.

## Setup

```bash
npm install
npm start
```

Environment variables:
- `TELEGRAM_BOT_TOKEN` (required) to download voice recordings.
- `RECORDINGS_DIR` (optional) folder to store downloads, default `recordings`.

## Webhook

Configure your bot webhook to point to:

```
POST https://your-domain.example/webhook
```

The server logs the full update object and any message text.
