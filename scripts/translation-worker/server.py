"""Local English-to-Bulgarian translation using official Argos EN→BG weights."""

import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ctranslate2
import sentencepiece
from langdetect import DetectorFactory, detect_langs
from langdetect.lang_detect_exception import LangDetectException

MAX_LINES = 36
MAX_CHARACTERS = 5_000
MAX_REQUEST_BYTES = 48 * 1024
MAX_SEQUENCE_TOKENS = 140
MAX_TOTAL_TOKENS = 2_048
MAX_OUTPUT_TOKENS = 220
DetectorFactory.seed = 0


class BadTranslationInput(Exception):
    pass


class TranslationModel:
    def __init__(self, package_dir, threads):
        metadata = json.loads((package_dir / 'metadata.json').read_text(encoding='utf-8'))
        if metadata.get('from_code') != 'en' or metadata.get('to_code') != 'bg':
            raise ValueError('Use the official English-to-Bulgarian Argos package.')
        self.tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(package_dir / 'sentencepiece.model'))
        self.translator = ctranslate2.Translator(
            str(package_dir / 'model'), device='cpu', compute_type='int8',
            inter_threads=1, intra_threads=threads, max_queued_batches=1,
        )

    def split_tokens(self, text):
        encoded = self.tokenizer.encode(text, out_type=str)
        if len(encoded) <= MAX_SEQUENCE_TOKENS:
            return [encoded]
        chunks = []
        current = []
        for word in text.split():
            tokens = self.tokenizer.encode(word, out_type=str)
            if len(tokens) > MAX_SEQUENCE_TOKENS:
                raise BadTranslationInput('A word is too long to translate.')
            if len(current) + len(tokens) > MAX_SEQUENCE_TOKENS:
                chunks.append(current)
                current = []
            current.extend(tokens)
        if current:
            chunks.append(current)
        return chunks

    def translate(self, lines):
        chunks = []
        ranges = []
        for line in lines:
            start = len(chunks)
            if line.strip():
                chunks.extend(self.split_tokens(line))
            ranges.append((start, len(chunks)))
        if sum(map(len, chunks)) > MAX_TOTAL_TOKENS:
            raise BadTranslationInput('The text is too complex for a single translation request.')
        outputs = self.translator.translate_batch(
            chunks, max_batch_size=8, max_input_length=MAX_SEQUENCE_TOKENS,
            max_decoding_length=MAX_OUTPUT_TOKENS, beam_size=4, length_penalty=0.2, replace_unknowns=True,
        )
        best = [result.hypotheses[0] for result in outputs]
        translations = [self.tokenizer.decode_pieces(tokens).replace('▁', ' ').strip() for tokens in best]
        if len(translations) != len(chunks) or not all(translations) or any(len(tokens) >= MAX_OUTPUT_TOKENS for tokens in best):
            raise BadTranslationInput('The translation model returned incomplete text.')
        return [' '.join(translations[start:end]) if start != end else line
                for line, (start, end) in zip(lines, ranges)]


def translation_input(body):
    if not isinstance(body, dict) or set(body) != {'sourceLanguage', 'targetLanguage', 'lines'}:
        raise BadTranslationInput('Expected sourceLanguage, targetLanguage and lines.')
    source = body['sourceLanguage']
    if source not in ('en', 'auto') or body['targetLanguage'] != 'bg':
        raise BadTranslationInput('Only English-to-Bulgarian translation is available.')
    lines = body['lines']
    if not isinstance(lines, list) or not 1 <= len(lines) <= MAX_LINES:
        raise BadTranslationInput('Provide between 1 and 36 lines.')
    if any(not isinstance(line, str) or any(ch in line for ch in ('\x00', '\n', '\r')) for line in lines):
        raise BadTranslationInput('Each line must be a plain text string.')
    if not any(line.strip() for line in lines) or sum(map(len, lines)) > MAX_CHARACTERS:
        raise BadTranslationInput('Provide text containing at most 5,000 characters.')
    if source == 'auto':
        try:
            languages = detect_langs(' '.join(lines))
        except LangDetectException:
            languages = []
        if not languages or languages[0].lang != 'en' or languages[0].prob < 0.80:
            raise BadTranslationInput('Could not confidently detect English. Specify English as the source language if appropriate.')
    return lines


class TranslationServer(ThreadingHTTPServer):
    def __init__(self, port):
        self.token = os.environ['SHARKAI_TRANSLATION_WORKER_TOKEN'].strip().encode()
        if len(self.token) < 24:
            raise ValueError('Set a private translation worker token with at least 24 characters.')
        package_dir = Path(os.environ['SHARKAI_TRANSLATION_MODEL_DIR']).resolve(strict=True)
        threads = min(4, max(1, int(os.environ.get('SHARKAI_TRANSLATION_THREADS', '2'))))
        self.model = TranslationModel(package_dir, threads)
        self.busy = threading.Lock()
        super().__init__(('127.0.0.1', port), TranslationHandler)


class TranslationHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(8)
        super().setup()

    def log_message(self, *_args):
        return

    def respond(self, status, payload=None):
        data = json.dumps(payload, ensure_ascii=False).encode() if payload else b''
        try:
            self.send_response(status)
            self.send_header('X-SharkAI-Translation-Worker', '1')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            if data:
                self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            if data:
                self.wfile.write(data)
        except OSError:
            pass

    def authenticated(self):
        supplied = self.headers.get('Authorization', '').encode()
        return hmac.compare_digest(supplied, b'Bearer ' + self.server.token)

    def do_GET(self):
        if not self.authenticated():
            self.respond(401)
        else:
            self.respond(204 if self.path == '/health' else 404)

    def do_POST(self):
        if not self.authenticated():
            self.respond(401)
            return
        if self.path != '/translate':
            self.respond(404)
            return
        if not self.server.busy.acquire(blocking=False):
            self.respond(429)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size > MAX_REQUEST_BYTES:
                self.respond(413)
                return
            if size < 1 or self.headers.get_content_type() != 'application/json':
                self.respond(422)
                return
            lines = translation_input(json.loads(self.rfile.read(size)))
            self.respond(200, {'lines': self.server.model.translate(lines)})
        except BadTranslationInput as error:
            self.respond(422, {'error': str(error)})
        except (ValueError, OSError):
            self.respond(422)
        except RuntimeError:
            self.respond(503)
        finally:
            self.server.busy.release()


if __name__ == '__main__':
    port = int(os.environ.get('SHARKAI_TRANSLATION_WORKER_PORT', '3863'))
    with TranslationServer(port) as server:
        print(f'SharkAI translation worker listening on 127.0.0.1:{port}', flush=True)
        server.serve_forever()
