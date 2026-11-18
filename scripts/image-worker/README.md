# SharkAI image worker

The optional Linux worker runs Stable Diffusion v1.5 and its LCM LoRA on CPU. Text-to-image produces 512 × 512 PNGs. Image-to-image uses the original orientation and full frame, with the longest side capped at 512 pixels. Prompts in English tend to follow the instructions more closely. The worker handles one request at a time and stops the native process if the caller disconnects or the 150-second limit expires.

## Edits

Send `prompt`, base64-encoded `image` and its `mimeType` to `POST /images`. The optional `edit` object accepts these fields when a source image is supplied.

| Field | Accepted values |
|---|---|
| `mode` | `preserve` keeps more of the source structure and uses a strength of 0.35. This is the default. `transform` uses a strength of 0.55 for a broader change. |
| `strength` | Optional numeric override from 0.20 through 0.65. Lower strengths generally preserve more detail. The sampler groups nearby values into discrete steps. |
| `style` | Optional descriptive text up to 240 characters, appended to the prompt. |

For an edit, describe the desired appearance, such as `orange sunset over a mountain lake, watercolor illustration`. The output is a new PNG. The model can change objects and details, even in `preserve` mode.

## Runtime

Use Python 3.11 or 3.12 in a virtual environment and install `requirements.txt`. Install an official stable-diffusion.cpp CPU release for the host platform. The Linux x64 test uses the Ubuntu 24.04 asset from `master-695-bdb431a`. Keep its shared libraries next to `sd-cli`. [stable-diffusion.cpp release](https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-695-bdb431a)

Download the SD v1.5 EMA-only Safetensors checkpoint. Its SHA-256 is `6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa`. SD v1.5 is published under CreativeML Open RAIL-M. The license permits commercial use with specific use restrictions. [Model card and license](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5) · [Pinned checkpoint](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/451f4fe16113bff5a5d2269ed5ad43b0592e9a14/v1-5-pruned-emaonly.safetensors)

Download the authors’ SD v1.5 LCM LoRA and save it as `lcm-sdv1-5.safetensors`. Its SHA-256 is `8f90d840e075ff588a58e22c6586e2ae9a6f7922996ee6649a7f01072333afe4`. The authors publish it under OpenRAIL++. [Adapter model card](https://huggingface.co/latent-consistency/lcm-lora-sdv1-5) · [Pinned adapter](https://huggingface.co/latent-consistency/lcm-lora-sdv1-5/resolve/cf2fced511dbe7e26c8d1d397e728fbab875db4b/pytorch_lora_weights.safetensors)

Set these worker environment variables and run `python scripts/image-worker/server.py`.

| Variable | Value |
|---|---|
| `SHARKAI_IMAGE_WORKER_TOKEN` | A private token of 24 or more characters. Use the same value on the SharkAI server. |
| `SHARKAI_SD_CLI` | Absolute path to `sd-cli`. |
| `SHARKAI_SD_MODEL` | Absolute path to the SD v1.5 checkpoint. |
| `SHARKAI_SD_LCM_LORA` | Absolute path to `lcm-sdv1-5.safetensors`. |
| `SHARKAI_SD_THREADS` | Defaults to four CPU threads. |
| `SHARKAI_IMAGE_WORKER_PORT` | Defaults to `3850` on loopback. |

Set `SHARKAI_IMAGE_WORKER_URL=http://127.0.0.1:3850` and `SHARKAI_IMAGE_WORKER_TOKEN` on a SharkAI server running on the same host. To connect from another host, set the URL to a dedicated HTTPS reverse proxy. Preserve the `Authorization` header, allow the worker's 150-second runtime, and close the upstream request when the caller disconnects. A health request requires the token. User files are staged in a request-local temporary directory and removed when it ends.
