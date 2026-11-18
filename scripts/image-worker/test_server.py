import base64
import io
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from PIL import Image

from server import InputError, image_command, pad_frame, parse_edit_options, prepare_image


def image_payload(image, mime_type='image/png', **encode_options):
    content = io.BytesIO()
    image.save(content, format='JPEG' if mime_type == 'image/jpeg' else 'PNG', **encode_options)
    return {'image': base64.b64encode(content.getvalue()).decode(), 'mimeType': mime_type}


class ImageEditTests(unittest.TestCase):
    def test_frame_keeps_all_edges_and_extends_padding(self):
        source = Image.new('RGB', (101, 61), 'red')
        source.putpixel((0, 0), (0, 255, 0))
        source.putpixel((100, 60), (0, 0, 255))
        padded, frame = pad_frame(source)
        self.assertEqual(frame.size, (128, 64))
        self.assertEqual(padded.crop(frame.crop).tobytes(), source.tobytes())
        self.assertEqual(padded.getpixel((0, 0)), source.getpixel((0, 0)))
        self.assertEqual(padded.getpixel((127, 63)), source.getpixel((100, 60)))

    def test_downscales_landscape_without_square_crop(self):
        source = Image.new('RGB', (1024, 576), 'red')
        source.paste((0, 0, 255), (900, 0, 1024, 576))
        with TemporaryDirectory() as directory:
            target = Path(directory) / 'input.png'
            frame = prepare_image(image_payload(source), target)
            with Image.open(target) as padded:
                output = padded.crop(frame.crop)
        self.assertEqual(frame.size, (512, 320))
        self.assertEqual(output.size, (512, 288))
        self.assertEqual(output.getpixel((0, 144)), (255, 0, 0))
        self.assertEqual(output.getpixel((511, 144)), (0, 0, 255))

    def test_respects_exif_orientation_without_upscaling(self):
        source = Image.new('RGB', (200, 100))
        exif = source.getexif()
        exif[274] = 6
        with TemporaryDirectory() as directory:
            target = Path(directory) / 'input.png'
            frame = prepare_image(image_payload(source, 'image/jpeg', exif=exif), target)
            with Image.open(target) as padded:
                self.assertEqual(padded.crop(frame.crop).size, (100, 200))
                self.assertFalse(padded.getexif())

    def test_uses_bounded_strength_and_caption_in_cli(self):
        source = Image.new('RGB', (200, 100))
        _, frame = pad_frame(source)
        self.assertEqual(parse_edit_options({}, frame).strength, 0.35)
        self.assertEqual(parse_edit_options({'edit': {'mode': 'transform'}}, frame).strength, 0.55)
        options = parse_edit_options({'edit': {'strength': 0.4, 'style': 'ink <test>'}}, frame)
        server = SimpleNamespace(binary='sd-cli', model='model', lora=Path('loras/lcm.safetensors'), threads=4)
        command = image_command(server, frame, options, 'a river', 'in.png', 'out.png')
        self.assertEqual(command[command.index('-p') + 1], 'a river, ink ‹test› <lora:lcm-sdv1-5:1>')
        self.assertEqual(command[command.index('-W') + 1], '256')
        self.assertEqual(command[command.index('-H') + 1], '128')
        self.assertEqual(command[command.index('--steps') + 1], '6')
        self.assertEqual(command[-4:], ['--init-img', 'in.png', '--strength', '0.4'])

        command = image_command(server, None, None, 'a river', 'in.png', 'out.png')
        self.assertEqual(command[command.index('-W') + 1], '512')
        self.assertEqual(command[command.index('-H') + 1], '512')
        self.assertEqual(command[command.index('--steps') + 1], '4')
        self.assertNotIn('--init-img', command)

    def test_rejects_invalid_edit_options(self):
        _, frame = pad_frame(Image.new('RGB', (80, 80)))
        invalid = (
            None, {'mode': []}, {'mode': 'unknown'}, {'override': 'foo'},
            {'strength': True}, {'strength': float('nan')}, {'strength': 0.9}, {'strength': '0.4'},
            {'style': 'a' * 241}, {'style': 'ink\0'},
        )
        for edit in invalid:
            with self.subTest(edit=edit), self.assertRaises(InputError) as failed:
                parse_edit_options({'edit': edit}, frame)
            self.assertEqual(failed.exception.status, 422)
        self.assertIsNone(parse_edit_options({}, None))
        with self.assertRaises(InputError):
            parse_edit_options({'edit': {}}, None)
