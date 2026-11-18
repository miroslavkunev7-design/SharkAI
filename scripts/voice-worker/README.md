# SharkAI voice worker

The optional Linux worker uses whisper.cpp for Bulgarian and English speech recognition and Piper for speech output. It accepts up to 2 MiB of audio, decodes up to 20 seconds inside a Linux Bubblewrap sandbox and removes the temporary recording when the request ends. The browser records up to 15 seconds per turn and requires secure media access and microphone permission. Voice conversation also needs a configured chat model and the browser's Web Audio API.

Install `bubblewrap`, `util-linux` and `ffmpeg` in `/usr/bin`. Unprivileged user namespaces must work for Bubblewrap. Build whisper.cpp tag `v1.7.6` with CMake and use the CPU `whisper-cli` binary. Use the multilingual quantized `ggml-small-q5_1.bin` checkpoint with SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`. [whisper.cpp release](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.7.6) · [Pinned checkpoint](https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin)

For speech output, install `piper-tts==1.8.0` in a Python 3.12 virtual environment. Keep each ONNX model and its matching `.onnx.json` side by side. Use `bg_BG-dimitar-medium` for Bulgarian and `en_US-amy-low` for English. Check the respective model cards for license terms. [Bulgarian voice](https://huggingface.co/rhasspy/piper-voices/tree/0ca208afc2a2ee102b1e961e72e0a7e4907be3d0/bg/bg_BG/dimitar/medium) · [English voice](https://huggingface.co/rhasspy/piper-voices/tree/0ca208afc2a2ee102b1e961e72e0a7e4907be3d0/en/en_US/amy/low)

| Worker variable | Value |
| --- | --- |
| `SHARKAI_VOICE_WORKER_TOKEN` | Private shared token of at least 24 characters. |
| `SHARKAI_WHISPER_CLI` | Absolute path to `whisper-cli`. |
| `SHARKAI_WHISPER_MODEL` | Absolute path to the multilingual checkpoint. |
| `SHARKAI_WHISPER_THREADS` | Defaults to 2 and is capped at 4. |
| `SHARKAI_PIPER_CLI` | Absolute path to the virtual environment's `piper` executable, when using speech output. |
| `SHARKAI_PIPER_BG` | Optional absolute path to the Bulgarian ONNX voice. |
| `SHARKAI_PIPER_EN` | Optional absolute path to the English ONNX voice. |
| `SHARKAI_VOICE_WORKER_PORT` | Loopback port, default 3855. |

Start with `python3 scripts/voice-worker/server.py`. On the SharkAI server set `SHARKAI_VOICE_WORKER_URL` to `http://127.0.0.1:3855` or the worker's dedicated HTTPS reverse proxy. Set `SHARKAI_VOICE_WORKER_TOKEN` to the same private token. A proxy must forward the authorization header, support the 30-second request window and close its worker connection when the caller disconnects. Browser clients use the authenticated SharkAI API.

Run `node scripts/test-chat-voice.cjs` with `SHARKAI_TEST_URL` pointing to the local SharkAI app and `POSTGRES_PRISMA_URL` pointing to the same disposable test database. The test exercises both configured languages through the normal app API.
