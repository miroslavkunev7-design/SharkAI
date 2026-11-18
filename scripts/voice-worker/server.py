"""Authenticated loopback worker for whisper.cpp and Piper."""

import array
import hmac
import json
import os
import re
import select
import socket
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


LIMIT_AUDIO = 2 * 1024 * 1024
LIMIT_WAV = 4 * 1024 * 1024
RATE = 16000
MIMES = {'audio/webm': 'matroska', 'audio/ogg': 'ogg', 'audio/mp4': 'mov', 'audio/wav': 'wav', 'audio/x-wav': 'wav'}
FFMPEG = '/usr/bin/ffmpeg'
BWRAP = '/usr/bin/bwrap'
PRLIMIT = '/usr/bin/prlimit'
CHILD_ENV = {'PATH': '/usr/bin', 'LC_ALL': 'C.UTF-8', 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2'}


class VoiceFailure(Exception):
    def __init__(self, status):
        self.status = status


def required_file(key, executable=False):
    item = Path(os.environ[key]).resolve(strict=True)
    if not item.is_file() or (executable and not os.access(item, os.X_OK)):
        raise ValueError(f'{key} must specify a readable local file.')
    return item


def decode_command(directory, format_name):
    return [BWRAP, '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
            '--clearenv', '--cap-drop', 'ALL', '--ro-bind', FFMPEG, FFMPEG, '--ro-bind', PRLIMIT, PRLIMIT,
            '--ro-bind-try', '/usr/lib', '/usr/lib', '--ro-bind-try', '/usr/lib64', '/usr/lib64',
            '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
            '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache', '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
            '--dev', '/dev', '--proc', '/proc',
            '--size', '16777216', '--tmpfs', '/tmp', '--bind', str(directory), '/audio', '--chdir', '/audio',
            PRLIMIT, '--as=805306368', '--cpu=6', '--core=0', '--fsize=2097152', '--nofile=64', '--',
            FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
            '-threads', '1', '-f', format_name, '-i', '/audio/input', '-map', '0:a:0', '-vn', '-sn', '-dn',
            '-t', '20', '-ac', '1', '-ar', str(RATE), '-c:a', 'pcm_s16le', '-threads', '1', '/audio/decoded.wav']


def audible(path):
    try:
        with wave.open(str(path), 'rb') as stream:
            if stream.getnframes() < stream.getframerate() // 4 or stream.getsampwidth() != 2:
                return False
            samples = array.array('h', stream.readframes(stream.getnframes()))
            if sys.byteorder != 'little':
                samples.byteswap()
            return sum(x * x for x in samples) > len(samples) * 36 ** 2
    except (OSError, wave.Error, EOFError):
        return False


class VoiceServer(ThreadingHTTPServer):
    def __init__(self, port):
        self.token = os.environ['SHARKAI_VOICE_WORKER_TOKEN'].strip()
        if len(self.token) < 24:
            raise ValueError('Set a private SHARKAI_VOICE_WORKER_TOKEN with at least 24 characters.')
        self.whisper = required_file('SHARKAI_WHISPER_CLI', executable=True)
        self.model = required_file('SHARKAI_WHISPER_MODEL')
        self.short_bg_model = required_file('SHARKAI_WHISPER_SHORT_BG_MODEL') if os.environ.get('SHARKAI_WHISPER_SHORT_BG_MODEL') else None
        self.threads = min(4, max(1, int(os.environ.get('SHARKAI_WHISPER_THREADS', '2'))))
        self.piper = required_file('SHARKAI_PIPER_CLI', executable=True) if os.environ.get('SHARKAI_PIPER_CLI') else None
        self.voices = {lang: required_file(key) for lang, key in (('bg', 'SHARKAI_PIPER_BG'), ('en', 'SHARKAI_PIPER_EN')) if os.environ.get(key)}
        self.busy = threading.BoundedSemaphore(2)
        with tempfile.TemporaryDirectory(prefix='sharkai-voice-probe-') as folder:
            work = Path(folder)
            with wave.open(str(work / 'input'), 'wb') as stream:
                stream.setparams((1, 2, RATE, RATE, 'NONE', 'not compressed'))
                stream.writeframes(b'\0\0' * RATE)
            subprocess.run(decode_command(work, 'wav'), env=CHILD_ENV, check=True, timeout=10,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            probes = [('en', work / 'decoded.wav')]
            if self.short_bg_model:
                probe = work / 'probe-input-bg.wav'
                with wave.open(str(probe), 'wb') as stream:
                    stream.setparams((1, 2, RATE, 3 * RATE, 'NONE', 'not compressed'))
                    stream.writeframes(b'\0\0' * 3 * RATE)
                probes.append(('bg', probe))
            for lang, input_path in probes:
                subprocess.run(self.transcribe_command(input_path, lang, work / f'probe-{lang}'), env=CHILD_ENV,
                               check=True, timeout=19, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if self.voices and not self.piper:
                raise ValueError('Voice models require SHARKAI_PIPER_CLI.')
            for lang, model in self.voices.items():
                result = work / f'{lang}.wav'
                text = 'Здравей.' if lang == 'bg' else 'Hello.'
                subprocess.run(self.speak_command(lang, model, result), input=(text + '\n').encode('utf-8'), env=CHILD_ENV,
                               check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if not audible(result):
                    raise ValueError(f'The {lang} voice did not synthesize audio.')
        super().__init__(('127.0.0.1', port), VoiceHandler)

    def transcribe_command(self, decoded, language, output):
        short_bg = False
        if self.short_bg_model and language == 'bg':
            with wave.open(str(decoded), 'rb') as stream:
                seconds = stream.getnframes() / stream.getframerate()
                short_bg = 2.5 <= seconds <= 5
        model = self.short_bg_model if short_bg else self.model
        # Keep timestamp-aware decoding for the short Bulgarian model to avoid repetitive output.
        context = ['-ac', '320'] if short_bg else ['-nt']
        return [PRLIMIT, '--as=3221225472', '--cpu=25', '--fsize=24576', '--core=0', '--',
                str(self.whisper), '-m', str(model), '-f', str(decoded), '-l', language,
                '-otxt', '-of', str(output), '-np', '-ng', '-bs', '2', '-bo', '2', '-nf',
                '-t', str(self.threads), *context]

    def speak_command(self, language, model, result):
        length_scale = '1.12' if language == 'bg' else '1.05'
        return [PRLIMIT, '--as=4294967296', '--cpu=16', '--fsize=4194304', '--core=0', '--',
                str(self.piper), '--model', str(model), '--output_file', str(result),
                '--noise-scale', '0', '--noise-w-scale', '0', '--length-scale', length_scale, '--sentence-silence', '0.25']


class VoiceHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(12)
        super().setup()

    def log_message(self, *_args):
        return

    def authorized(self):
        value = self.headers.get('Authorization', '').encode()
        return hmac.compare_digest(value, f'Bearer {self.server.token}'.encode())

    def reply(self, status, content=b'', mime='application/json'):
        try:
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-SharkAI-Voice-Worker', '1')
            self.end_headers()
            if content:
                self.wfile.write(content)
        except OSError:
            pass

    def do_GET(self):
        if not self.authorized():
            self.reply(401)
        elif self.path != '/health':
            self.reply(404)
        else:
            self.reply(200, json.dumps({'transcription': True, 'speech': sorted(self.server.voices)}).encode())

    def do_POST(self):
        if not self.authorized():
            self.reply(401)
            return
        if self.path not in ('/transcribe', '/speak'):
            self.reply(404)
            return
        if not self.server.busy.acquire(blocking=False):
            self.reply(429)
            return
        try:
            with tempfile.TemporaryDirectory(prefix='sharkai-voice-') as directory:
                work = Path(directory)
                if self.path == '/transcribe':
                    self.transcribe(work)
                else:
                    self.speak(work)
        except VoiceFailure as error:
            if error.status != 499:
                self.reply(error.status)
        except (OSError, ValueError, TypeError):
            self.reply(422)
        finally:
            self.server.busy.release()

    def read_body(self, maximum):
        size = int(self.headers.get('Content-Length', '0'))
        if size > maximum:
            raise VoiceFailure(413)
        if size <= 0:
            raise VoiceFailure(422)
        data = self.rfile.read(size)
        if len(data) != size:
            raise VoiceFailure(422)
        return data

    def transcribe(self, work):
        format_name = MIMES.get(self.headers.get_content_type())
        language = self.headers.get('X-SharkAI-Language', 'auto')
        if not format_name or language not in ('en', 'bg', 'auto'):
            raise VoiceFailure(422)
        (work / 'input').write_bytes(self.read_body(LIMIT_AUDIO))
        decoded = work / 'decoded.wav'
        self.invoke(decode_command(work, format_name), 8, invalid=422)
        if not audible(decoded):
            raise VoiceFailure(422)
        output = work / 'transcription'
        self.invoke(self.server.transcribe_command(decoded, language, output), 19)
        text = output.with_suffix('.txt').read_text(encoding='utf-8').strip()
        if not 0 < len(text) <= 6000 or not re.sub(r'\[[^\]]*\]|\([^)]*\)|[^\w]', '', text):
            raise VoiceFailure(422)
        self.reply(200, json.dumps({'text': text}, ensure_ascii=False).encode('utf-8'))

    def speak(self, work):
        if self.headers.get_content_type() != 'application/json':
            raise VoiceFailure(422)
        request = json.loads(self.read_body(6000))
        text = request.get('text') if isinstance(request, dict) else None
        language = request.get('language') if isinstance(request, dict) else None
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 1000 or language not in self.server.voices or '\0' in text:
            raise VoiceFailure(422)
        model = self.server.voices[language]
        output = work / 'speech.wav'
        source = work / 'text'
        source.write_text(' '.join(text.split()) + '\n', encoding='utf-8')
        with source.open('rb') as source_file:
            self.invoke(self.server.speak_command(language, model, output), 21, stdin=source_file)
        if not output.is_file() or output.stat().st_size > LIMIT_WAV or not audible(output):
            raise VoiceFailure(502)
        self.reply(200, output.read_bytes(), 'audio/wav')

    def invoke(self, args, seconds, stdin=subprocess.DEVNULL, invalid=502):
        try:
            child = subprocess.Popen(args, env=CHILD_ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=stdin)
        except OSError as error:
            raise VoiceFailure(503) from error
        deadline = time.monotonic() + seconds
        try:
            while child.poll() is None:
                if time.monotonic() >= deadline:
                    raise VoiceFailure(504)
                if select.select([self.connection], [], [], 0.2)[0]:
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        raise VoiceFailure(499)
                    time.sleep(0.2)
            if child.returncode != 0:
                raise VoiceFailure(invalid)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()


if __name__ == '__main__':
    port = int(os.environ.get('SHARKAI_VOICE_WORKER_PORT', '3855'))
    with VoiceServer(port) as server:
        print(f'SharkAI voice worker listening on 127.0.0.1:{port}', flush=True)
        server.serve_forever()
