# NOOVERSE Render Worker

A small Node.js + FFmpeg web service used by NOOVERSE to assemble generated video clips and master audio into a final MP4.

## Endpoints

- `GET /health` — health check
- `POST /render` — submit an asynchronous render job
- `GET /jobs/:id` — poll job status

## Authentication

Set `SERVICE_KEY` in the deployment environment. Callers may send either:

- `Authorization: Bearer <SERVICE_KEY>`
- `X-Service-Key: <SERVICE_KEY>`

## Render payload

```json
{
  "clips": [
    {"url": "https://.../clip1.mp4"},
    {"url": "https://.../clip2.mp4"}
  ],
  "audio_url": "https://.../master.mp3",
  "output_upload_url": "https://signed-upload-url",
  "output_public_url": "https://public-output-url"
}
```

If `output_upload_url` is provided, the rendered MP4 is uploaded there with HTTP PUT. Otherwise the job response contains a base64 output for testing only.
