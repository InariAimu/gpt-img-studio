"""Export app icons from public/app-icon.png; requires Pillow.

Master: harness-scope/assets/icons/openai-pixel.png, generated from
harness-scope/assets/gpt.jpg in the same atlas as its DeepSeek app icon.
Matches Harness Scope's 128px RGBA PNG and nine Windows ICO sizes.
"""

from io import BytesIO
from pathlib import Path
from struct import pack

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128)


def main():
    with Image.open(ROOT / "public/app-icon.png") as master:
        if master.size != (128, 128):
            raise ValueError("The app icon master must be 128x128 pixels")
        image = master.convert("RGBA")

    destination = ROOT / "src-tauri/icons"
    destination.mkdir(parents=True, exist_ok=True)
    image.save(destination / "icon.png")

    entries = []
    payloads = []
    offset = 6 + 16 * len(SIZES)
    for size in SIZES:
        output = BytesIO()
        image.resize((size, size), Image.Resampling.NEAREST).save(output, "PNG")
        payload = output.getvalue()
        entries.append(pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(payload), offset))
        payloads.append(payload)
        offset += len(payload)
    (destination / "icon.ico").write_bytes(
        pack("<HHH", 0, 1, len(SIZES)) + b"".join(entries) + b"".join(payloads)
    )
    print("Built 128x128 RGBA PNG and ICO sizes:", ", ".join(map(str, SIZES)))


if __name__ == "__main__":
    main()
