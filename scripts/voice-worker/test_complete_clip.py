import http.client
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from server import AUTO_CPU_SECONDS, FFMPEG, LIMIT_AUDIO, LIMIT_SECONDS, RATE, VoiceHandler, VoiceServer


def wav(frames, rate=RATE):
    output = io.BytesIO()
    cycle = b'\xe8\x03' * 20 + b'\x18\xfc' * 20
    repetitions, tail = divmod(frames, 40)
    with wave.open(output, 'wb') as stream:
        stream.setparams((1, 2, rate, frames, 'NONE', 'not compressed'))
        stream.writeframes(cycle * repetitions + cycle[:tail * 2])
    return output.getvalue()


class CompleteClipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), VoiceHandler)
        cls.server.token = 'disposable-local-voice-fixture'
        cls.server.voices = {}
        cls.server.busy = threading.BoundedSemaphore(2)
        cls.server.inferences = []
        cls.server.transcribe_command = cls.transcribe_command
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    @classmethod
    def transcribe_command(cls, decoded, _language, output):
        # Keep HTTP, request limits, and isolated FFmpeg real. Substitute only
        # the expensive recognizer when checking exact sample boundaries.
        with wave.open(str(decoded), 'rb') as stream:
            frames = stream.getnframes()
        cls.server.inferences.append(frames)
        return [sys.executable, '-c', 'import sys; from pathlib import Path; Path(sys.argv[1]).write_text("recognition fixture")',
                str(output.with_suffix('.txt'))]

    def call(self, data=None, *, complete=False, auth=True, mime='audio/wav', length=None):
        method, path = ('GET', '/health') if data is None else ('POST', '/transcribe')
        headers = {'Content-Type': mime}
        if auth:
            headers['Authorization'] = f'Bearer {self.server.token}'
        if complete:
            headers['X-SharkAI-Full-Clip'] = '1'
        if length is not None:
            headers['Content-Length'] = str(length)
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=12)
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_health_is_authenticated_and_advertises_complete_clip(self):
        self.assertEqual(self.call(auth=False)[0], 401)
        status, headers, body = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(headers['X-SharkAI-Voice-Worker'], '1')
        self.assertEqual(json.loads(body), {'transcription': True, 'completeClip': True, 'speech': []})

    def test_automatic_language_detection_has_a_separate_bounded_cpu_limit(self):
        model = VoiceServer.__new__(VoiceServer)
        model.whisper = '/model/whisper-cli'
        model.model = '/model/checkpoint.bin'
        model.short_bg_model = None
        model.threads = 4
        auto = model.transcribe_command('input.wav', 'auto', 'output')
        explicit = model.transcribe_command('input.wav', 'en', 'output')
        self.assertIn(f'--cpu={AUTO_CPU_SECONDS}:{AUTO_CPU_SECONDS + 1}', auto)
        self.assertEqual(auto[auto.index('-l') + 1], 'auto')
        self.assertIn('--cpu=25', explicit)

    def test_cpu_budget_expiry_returns_timeout(self):
        exhausted = [sys.executable, '-c', 'import os, signal; os.kill(os.getpid(), signal.SIGXCPU)']
        with patch.object(self.server, 'transcribe_command', return_value=exhausted):
            status, headers, _body = self.call(wav(RATE), complete=True)
        self.assertEqual(status, 504)
        self.assertIsNone(headers.get('X-SharkAI-Full-Clip'))

    def test_exact_twenty_seconds_reaches_recognizer_and_is_acknowledged(self):
        rate = 48000
        status, headers, body = self.call(wav(LIMIT_SECONDS * rate, rate), complete=True)
        self.assertEqual(status, 200)
        self.assertEqual(headers['X-SharkAI-Full-Clip'], '1')
        self.assertEqual(json.loads(body), {'text': 'recognition fixture'})
        self.assertEqual(self.server.inferences[-1], LIMIT_SECONDS * RATE)

    def test_one_extra_normalized_frame_is_rejected_before_recognizer(self):
        before = len(self.server.inferences)
        status, headers, body = self.call(wav(LIMIT_SECONDS * RATE + 1), complete=True)
        self.assertEqual(status, 413)
        self.assertEqual(headers['X-SharkAI-Voice-Limit'], 'duration')
        self.assertIsNone(headers.get('X-SharkAI-Full-Clip'))
        self.assertEqual(body, b'')
        self.assertEqual(len(self.server.inferences), before)

    def test_compressed_webm_duration_uses_audio_frames(self):
        encoded = subprocess.run(
            [FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'],
            input=wav((LIMIT_SECONDS + 1) * RATE), stdout=subprocess.PIPE, check=True, timeout=10,
        ).stdout
        before = len(self.server.inferences)
        status, headers, _body = self.call(encoded, mime='audio/webm', complete=True)
        self.assertEqual(status, 413)
        self.assertEqual(headers['X-SharkAI-Voice-Limit'], 'duration')
        self.assertEqual(len(self.server.inferences), before)

    def test_aac_packet_padding_keeps_the_exact_twenty_second_clip(self):
        maximum = LIMIT_SECONDS * RATE
        for frame_count in (maximum, maximum + 480):
            with self.subTest(frame_count=frame_count), tempfile.TemporaryDirectory() as folder:
                target = Path(folder) / 'clip.m4a'
                subprocess.run(
                    [FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'aac', str(target)],
                    input=wav(frame_count), check=True, timeout=10,
                )
                before = len(self.server.inferences)
                status, headers, _body = self.call(target.read_bytes(), mime='audio/mp4', complete=True)
                if frame_count == maximum:
                    self.assertEqual(status, 200)
                    self.assertEqual(headers['X-SharkAI-Full-Clip'], '1')
                    self.assertEqual(self.server.inferences[-1], maximum)
                else:
                    self.assertEqual(status, 413)
                    self.assertEqual(headers['X-SharkAI-Voice-Limit'], 'duration')
                    self.assertEqual(len(self.server.inferences), before)

    def test_size_limit_is_distinct_and_unauthorized_requests_do_not_decode(self):
        before = len(self.server.inferences)
        status, headers, _body = self.call(b'', complete=True, length=LIMIT_AUDIO + 1)
        self.assertEqual(status, 413)
        self.assertIsNone(headers.get('X-SharkAI-Voice-Limit'))
        self.assertEqual(self.call(wav(RATE), auth=False, complete=True)[0], 401)
        self.assertEqual(len(self.server.inferences), before)

    def test_truncated_audio_payload_does_not_produce_a_partial_transcript(self):
        before = len(self.server.inferences)
        status, headers, _body = self.call(wav(RATE)[:-801], complete=True)
        self.assertEqual(status, 422)
        self.assertIsNone(headers.get('X-SharkAI-Full-Clip'))
        self.assertEqual(len(self.server.inferences), before)

    def test_legacy_request_still_transcribes_the_first_twenty_seconds(self):
        status, headers, _body = self.call(wav((LIMIT_SECONDS + 1) * RATE))
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get('X-SharkAI-Full-Clip'))
        self.assertEqual(self.server.inferences[-1], LIMIT_SECONDS * RATE)


if __name__ == '__main__':
    unittest.main()
