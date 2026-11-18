# SharkAI translation worker

This optional CPU service translates English into Bulgarian with the official Argos Translate EN→BG 1.9 package. CTranslate2 runs the model and SentencePiece tokenizes the input. All inference runs on the worker's host. The worker reads a local model directory and starts without an external account, API key or connection. It serves one translation at a time.

## Model and runtime

The Argos archive is 72,324,211 bytes. Its SHA-256 is `28401fbb5f94e1ce8a54e3005beea9d5f08767d67e3e0900940e08722cfc275a`. Extract `metadata.json`, `sentencepiece.model`, `README.md` and `model/` from the package. The package's tokenizer data in `stanza/` is optional for this implementation. [Argos Data download](https://data.argosopentech.com/argospm/v1/translate-en_bg-1_9.argosmodel)

The packaged model is distributed under Argos MIT/CC0 terms. Its included README attributes the original CC BY 4.0 OPUS model to Jörg Tiedemann and Santhosh Thottingal, authors of *OPUS-MT — Building open translation services for the World* (EAMT 2020). Keep the source attribution when redistributing model files. [Argos model license](https://github.com/argosopentech/argos-translate/issues/533) · [OPUS-MT paper](https://aclanthology.org/2020.eamt-1.61/)

Use Python 3.12 and `requirements.txt`. To reuse compatible system NumPy, PyYAML and setuptools, create the virtual environment with `--system-site-packages`, verify those imports, then install the pinned runtime packages with `pip install --no-deps -r scripts/translation-worker/requirements.txt`. The tested Linux x64 runtime used about 245 MB of additional disk space for the installed environment and extracted model, excluding the temporary archive. An isolated installation that also downloads NumPy and PyYAML will use more space. Stanza and PyTorch are unnecessary.

## Configuration

| Variable | Value |
|---|---|
| `SHARKAI_TRANSLATION_WORKER_TOKEN` | Private shared token of at least 24 characters. Set the same token on the SharkAI server. |
| `SHARKAI_TRANSLATION_MODEL_DIR` | Absolute path of the extracted EN→BG Argos package directory. |
| `SHARKAI_TRANSLATION_WORKER_PORT` | Defaults to `3863` on loopback. |
| `SHARKAI_TRANSLATION_THREADS` | Defaults to two CPU threads. Accepts one to four. |

Run `python scripts/translation-worker/server.py` with the worker environment. Set `SHARKAI_TRANSLATION_WORKER_URL=http://127.0.0.1:3863` on SharkAI when both services run on the same host. A separately hosted worker can use a dedicated HTTPS reverse proxy that preserves the `Authorization` header.

The worker requires `Authorization: Bearer <token>` for `GET /health` and `POST /translate`. A healthy response has status `204` and `X-SharkAI-Translation-Worker: 1`. `POST /translate` accepts JSON with `sourceLanguage` set to `en` or `auto`, `targetLanguage` set to `bg` and `lines` containing up to 36 strings and 5,000 characters in total. Its response has a `lines` array in the input order. Paragraph breaks are preserved as blank lines. Unrecognized source languages, unsupported directions and overlong text return `422`. A simultaneous request returns `429`.
