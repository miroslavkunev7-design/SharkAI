"""SharkAI image worker using a separately installed stable-diffusion.cpp CLI."""

import base64
import binascii
import hmac
import io
import json
import os
import select
import socket
import subprocess
import tempfile
import threading
import time
import warnings
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageOps

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_REQUEST_BYTES = (MAX_IMAGE_BYTES + 2) // 3 * 4 + 8192
MAX_OUTPUT_BYTES = 5 * 1024 * 1024
LIMIT_SECONDS = 150
IMAGE_SIDE = 512
LATENT_STRIDE = 64
MIN_EDIT_STRENGTH = 0.20
MAX_EDIT_STRENGTH = 0.65
EDIT_STRENGTHS = {'preserve': 0.35, 'transform': 0.55}
PIL_FORMATS = {'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP'}
Image.MAX_IMAGE_PIXELS = 24_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)


class InputError(Exception):
    def __init__(self, status):
        self.status = status


@dataclass(frozen=True)
class ImageFrame:
    size: tuple[int, int]
    crop: tuple[int, int, int, int]


@dataclass(frozen=True)
class EditOptions:
    strength: float
    style: str


def required_file(name):
    path = Path(os.environ[name]).resolve(strict=True)
    if not path.is_file():
        raise ValueError(f'{name} must point to a local file.')
    return path


def parse_edit_options(payload, frame):
    if 'edit' not in payload:
        return EditOptions(EDIT_STRENGTHS['preserve'], '') if frame else None
    edit = payload['edit']
    if not frame or not isinstance(edit, dict) or edit.keys() - {'mode', 'strength', 'style'}:
        raise InputError(422)
    mode = edit.get('mode', 'preserve')
    if not isinstance(mode, str) or mode not in EDIT_STRENGTHS:
        raise InputError(422)
    strength = edit.get('strength', EDIT_STRENGTHS[mode])
    if type(strength) not in (float, int) or not MIN_EDIT_STRENGTH <= strength <= MAX_EDIT_STRENGTH:
        raise InputError(422)
    style = edit.get('style', '')
    if not isinstance(style, str) or len(style) > 240 or any(ord(char) < 32 for char in style):
        raise InputError(422)
    return EditOptions(strength, style.strip())


def pad_frame(image):
    width, height = image.size
    padded_width = ((width + LATENT_STRIDE - 1) // LATENT_STRIDE) * LATENT_STRIDE
    padded_height = ((height + LATENT_STRIDE - 1) // LATENT_STRIDE) * LATENT_STRIDE
    left = (padded_width - width) // 2
    top = (padded_height - height) // 2
    right = left + width
    bottom = top + height
    frame = ImageFrame((padded_width, padded_height), (left, top, right, bottom))
    if frame.size == image.size:
        return image, frame

    canvas = Image.new('RGB', frame.size)
    canvas.paste(image, (left, top))
    # Extend the source edges so diffusion sees no artificial bars around the frame.
    if left:
        canvas.paste(image.crop((0, 0, 1, height)).resize((left, height)), (0, top))
    if right < padded_width:
        canvas.paste(image.crop((width - 1, 0, width, height)).resize((padded_width - right, height)), (right, top))
    if top:
        canvas.paste(canvas.crop((0, top, padded_width, top + 1)).resize((padded_width, top)), (0, 0))
    if bottom < padded_height:
        canvas.paste(canvas.crop((0, bottom - 1, padded_width, bottom)).resize((padded_width, padded_height - bottom)), (0, bottom))
    return canvas, frame


def prepare_image(payload, path):
    image = payload.get('image')
    mime_type = payload.get('mimeType')
    if image is None and mime_type is None:
        return
    if not isinstance(image, str) or not isinstance(mime_type, str) or mime_type not in PIL_FORMATS:
        raise InputError(422)
    try:
        data = base64.b64decode(image, validate=True)
        if len(data) > MAX_IMAGE_BYTES:
            raise InputError(413)
        with Image.open(io.BytesIO(data)) as original:
            if original.format != PIL_FORMATS[mime_type] or getattr(original, 'is_animated', False):
                raise InputError(422)
            oriented = ImageOps.exif_transpose(original)
            normalized = oriented.convert('RGB')
            normalized.thumbnail((IMAGE_SIDE, IMAGE_SIDE), Image.Resampling.LANCZOS)
            normalized, frame = pad_frame(normalized)
            normalized.info.clear()
            normalized.save(path, format='PNG')
            return frame
    except (binascii.Error, ValueError, OSError, Image.DecompressionBombWarning, Image.DecompressionBombError) as error:
        raise InputError(422) from error


def image_command(server, frame, options, prompt, input_path, output_path):
    if options and options.style:
        prompt = f'{prompt}, {options.style}'
    prompt = prompt.replace('<', '‹').replace('>', '›')
    width, height = frame.size if frame else (IMAGE_SIDE, IMAGE_SIDE)
    # The pinned img2img sampler evaluates only the tail of its schedule.
    # Six entries let both default edit modes differ without exceeding four evaluations.
    command = [
        str(server.binary), '-m', str(server.model), '-o', str(output_path),
        '--lora-model-dir', str(server.lora.parent), '-p', f'{prompt} <lora:lcm-sdv1-5:1>',
        '--sampling-method', 'lcm', '--scheduler', 'lcm', '--steps', '6' if frame else '4',
        '--cfg-scale', '1.0', '-W', str(width), '-H', str(height), '-t', str(server.threads), '-s', '-1',
    ]
    if frame:
        command.extend(['--init-img', str(input_path), '--strength', str(options.strength)])
    return command


class ImageServer(ThreadingHTTPServer):
    def __init__(self, port):
        self.token = os.environ['SHARKAI_IMAGE_WORKER_TOKEN'].strip()
        if len(self.token) < 24:
            raise ValueError('Set a private SHARKAI_IMAGE_WORKER_TOKEN with at least 24 characters.')
        self.binary = required_file('SHARKAI_SD_CLI')
        self.model = required_file('SHARKAI_SD_MODEL')
        self.lora = required_file('SHARKAI_SD_LCM_LORA')
        if not os.access(self.binary, os.X_OK) or self.lora.name != 'lcm-sdv1-5.safetensors':
            raise ValueError('Use an executable sd-cli and the LCM adapter named lcm-sdv1-5.safetensors.')
        self.child_env = {key: os.environ[key] for key in ('PATH', 'LD_LIBRARY_PATH') if key in os.environ}
        subprocess.run(
            [str(self.binary), '--version'], cwd=self.binary.parent, env=self.child_env,
            check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.threads = min(8, max(1, int(os.environ.get('SHARKAI_SD_THREADS', '4'))))
        self.busy = threading.Lock()
        super().__init__(('127.0.0.1', port), ImageHandler)

    def ready(self):
        return self.binary.is_file() and self.model.is_file() and self.lora.is_file()


class ImageHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(15)
        super().setup()

    def log_message(self, *_args):
        return

    def respond(self, status, content=b''):
        try:
            self.send_response(status)
            self.send_header('X-SharkAI-Image-Worker', '1')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            if content:
                self.send_header('Content-Type', 'image/png')
            self.end_headers()
            if content:
                self.wfile.write(content)
        except OSError:
            pass

    def authenticated(self):
        supplied = self.headers.get('Authorization', '').encode()
        return hmac.compare_digest(supplied, f'Bearer {self.server.token}'.encode())

    def do_GET(self):
        if not self.authenticated():
            self.respond(401)
        elif self.path != '/health':
            self.respond(404)
        else:
            self.respond(204 if self.server.ready() else 503)

    def do_POST(self):
        if not self.authenticated():
            self.respond(401)
            return
        if self.path != '/images':
            self.respond(404)
            return
        if not self.server.ready():
            self.respond(503)
            return
        if not self.server.busy.acquire(blocking=False):
            self.respond(429)
            return
        try:
            self.generate()
        except InputError as error:
            self.respond(error.status)
        except (ValueError, OSError):
            self.respond(422)
        finally:
            self.server.busy.release()

    def generate(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size > MAX_REQUEST_BYTES:
            raise InputError(413)
        if size <= 0 or self.headers.get_content_type() != 'application/json':
            raise InputError(422)
        data = json.loads(self.rfile.read(size))
        prompt = data.get('prompt') if isinstance(data, dict) else None
        if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 3000 or '\x00' in prompt:
            raise InputError(422)
        with tempfile.TemporaryDirectory(prefix='sharkai-image-') as work:
            workdir = Path(work)
            input_path = workdir / 'input.png'
            output_path = workdir / 'output.png'
            frame = prepare_image(data, input_path)
            options = parse_edit_options(data, frame)
            status = self.invoke(image_command(self.server, frame, options, prompt.strip(), input_path, output_path))
            if status == 499:
                return
            if status != 200:
                self.respond(status)
                return
            if not output_path.is_file() or not 0 < output_path.stat().st_size <= MAX_OUTPUT_BYTES:
                self.respond(502)
                return
            try:
                with Image.open(output_path) as result:
                    expected_size = frame.size if frame else (IMAGE_SIDE, IMAGE_SIDE)
                    if result.format != 'PNG' or result.size != expected_size:
                        raise InputError(502)
                    if frame:
                        result = result.crop(frame.crop)
                    result.info.clear()
                    content = io.BytesIO()
                    result.save(content, format='PNG')
            except (OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
                raise InputError(502) from error
            if content.tell() > MAX_OUTPUT_BYTES:
                raise InputError(502)
            self.respond(200, content.getvalue())

    def invoke(self, command):
        try:
            child = subprocess.Popen(
                command, cwd=self.server.binary.parent, env=self.server.child_env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except OSError:
            return 503
        deadline = time.monotonic() + LIMIT_SECONDS
        try:
            while child.poll() is None:
                if time.monotonic() >= deadline:
                    return 504
                if select.select([self.connection], [], [], 0.25)[0]:
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        return 499
                    time.sleep(0.25)
            return 200 if child.returncode == 0 else 502
        except OSError:
            return 499
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()


if __name__ == '__main__':
    port = int(os.environ.get('SHARKAI_IMAGE_WORKER_PORT', '3850'))
    with ImageServer(port) as server:
        print(f'SharkAI image worker listening on 127.0.0.1:{port}', flush=True)
        server.serve_forever()
