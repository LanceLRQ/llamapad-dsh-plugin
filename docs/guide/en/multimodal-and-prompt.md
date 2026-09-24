# Multimodal input and prompt snapshot

[中文](../zh/multimodal-and-prompt.md) · [Back to README](../../../README.en.md)

## Image input

Models with mmproj (vision projector file) configured can accept images. The plugin tells dsh which inputs a model supports based on `mmprojFile` in the panel's model config:

- mmproj configured and the file present: `["text", "image"]`, dsh's input box allows pasting images.
- No mmproj configured, or configured but the file is missing (`missing-mmproj`): `["text"]`.
- Older panels don't have this field in their response, so the plugin can't tell and declares nothing.

How an image is passed along: an image you paste into dsh first goes through the host's attachments service to read its bytes, gets converted into a base64 `image_url`, and is sent along with the message to llama.cpp. Both `proxy` and `direct` mode support this.

When image reading fails (e.g. the attachments service is unavailable, or storage-layer validation doesn't pass), the plugin puts a placeholder text `[image attachment unavailable]` in that spot instead of silently dropping it. This way the model knows an image was supposed to be there, and it's visible when troubleshooting. Images in tool results are handled the same way.

Whether formats like GIF or WebP work depends on whether llama.cpp can decode them.

## The local model list in the system prompt

The plugin adds a `llamapad:local-fleet` section to dsh's system prompt, written in English since a model reads it. It includes:

- which models are currently running, with the default model marked `default` and a note on who a request without a model name goes to;
- which other models could be started, excluding running ones, up to 20 listed, with just a count for any beyond that.

This way, any provider's model, including cloud models, can see what's available locally, and can decide to hand a suitable task to a local model itself, or call `llamapad_start_model` to bring one up.

The data comes from a cache maintained alongside status refreshes, and the latest value is read each time the system prompt is assembled. When the panel is unreachable or hasn't been probed successfully yet, this section is simply omitted, rather than saying "no local models".

### Privacy

This list is part of the system prompt, and is sent along with the request to whichever provider the current session uses. If the session is using a cloud model, the cloud provider can see what models are on your local GPU. If that's a concern, set `statusPromptSection` to `false`.
