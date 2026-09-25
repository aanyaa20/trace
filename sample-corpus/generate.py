"""Builds the sample corpus.

Run inside the ml image, which already has PyMuPDF, Pillow and ffmpeg:

    say -v Samantha -o sample-corpus/briefing.aiff "..."      # macOS only
    docker run --rm -v "$PWD/sample-corpus:/work" -w /work trace-ml python generate.py

The generated files are committed, so cloning the repository is enough; this
script exists to document where they came from and to regenerate them if the
text ever changes.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pymupdf as fitz
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent

HANDBOOK = [
    (
        "Retrieval Architecture",
        "The retrieval layer combines two independent signals. Dense vectors capture "
        "semantic similarity, so a question phrased differently from the source text "
        "still matches. Sparse BM25 vectors capture exact terminology, so rare "
        "identifiers and proper nouns are not lost in the embedding. The two ranked "
        "lists are combined with reciprocal rank fusion inside the vector database. "
        "Fusion happens server side because moving both candidate lists across the "
        "network only to re-sort them wastes a round trip.",
    ),
    (
        "Chunking Policy",
        "Chunks target eight hundred characters with one hundred and fifty characters "
        "of overlap, and splits land on sentence boundaries. Page boundaries are never "
        "crossed: a chunk that spans two pages has no single page number, and page "
        "attribution is the guarantee the system makes. Transcript segments are the "
        "opposite case and are merged, because a single whisper segment is a few "
        "seconds of speech and too small to retrieve against. Merging widens the "
        "timestamp span, which loses nothing.",
    ),
    (
        "Abstention Policy",
        "The sufficiency gate is deterministic. It compares the number of chunks "
        "scoring above a configured threshold against a configured minimum. When the "
        "corpus does not clear the bar after three iterations, the system abstains "
        "instead of answering. Abstention is the correct output when evidence is "
        "thin, not a failure of the system. The thresholds are configuration rather "
        "than constants so that the evaluation can sweep them.",
    ),
]


def build_text_pdf() -> None:
    doc = fitz.open()
    for title, body in HANDBOOK:
        page = doc.new_page()
        page.insert_text((72, 96), title, fontsize=18, fontname="hebo")
        page.insert_textbox(
            fitz.Rect(72, 130, 523, 700), body, fontsize=11, fontname="helv", lineheight=1.5
        )
    doc.save(OUT / "handbook.pdf")
    doc.close()


def _render_text_image(lines: list[str], size: tuple[int, int], font_size: int) -> Image.Image:
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)
    except OSError:
        font = ImageFont.load_default()
    y = 60
    for line in lines:
        draw.text((60, y), line, fill="black", font=font)
        y += int(font_size * 1.8)
    return image


def build_scanned_pdf() -> None:
    """A PDF with no text layer at all, so extraction must fall through to OCR."""
    image = _render_text_image(
        [
            "LAB NOTEBOOK",
            "",
            "Experiment 4: threshold sweep",
            "Minimum score 0.55 gave the best",
            "balance between false answers and",
            "over abstention on the pilot set.",
            "",
            "Lower values answered too often.",
            "Higher values refused good questions.",
        ],
        (1240, 1754),
        34,
    )
    # JPEG rather than a lossless render, which would be several megabytes for
    # a committed fixture. Downscaling further than this is a false economy:
    # at half size the recogniser still reads the glyphs at high confidence but
    # starts merging words, so "LAB NOTEBOOK" comes back as "LABNOTEBOOK".
    scan = OUT / "scanned-notes.jpg"
    image.resize((992, 1403), Image.LANCZOS).save(scan, quality=92, optimize=True)

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(fitz.Rect(0, 0, 595, 842), filename=str(scan))
    doc.save(OUT / "scanned-notes.pdf")
    doc.close()
    scan.unlink()


def build_image() -> None:
    _render_text_image(
        [
            "trace pipeline",
            "",
            "upload  ->  extract  ->  chunk",
            "chunk   ->  embed    ->  qdrant",
            "query   ->  grade    ->  answer",
            "",
            "dense 384d  +  bm25 sparse",
        ],
        (1000, 640),
        30,
    ).save(OUT / "architecture.png")


def build_media() -> None:
    source = OUT / "briefing.aiff"
    if not source.exists():
        # The narration source is macOS-only and is not committed. The encoded
        # outputs are, so a rebuild of the documents alone still works here.
        if (OUT / "briefing.mp3").exists() and (OUT / "lecture.mp4").exists():
            print("briefing.aiff absent; keeping the committed mp3 and mp4")
            return
        raise SystemExit(
            "briefing.aiff is missing and no committed media to fall back on; "
            "regenerate it with the macOS say command shown in the module docstring"
        )

    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source),
         "-ac", "1", "-ar", "16000", "-b:a", "64k", str(OUT / "briefing.mp3")],
        check=True,
    )

    # A still image plus the same narration: enough for the video path to
    # exercise both whisper and keyframe extraction without a large file.
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-loop", "1", "-i", str(OUT / "architecture.png"),
         "-i", str(OUT / "briefing.mp3"),
         "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "64k", "-shortest", "-r", "2",
         str(OUT / "lecture.mp4")],
        check=True,
    )


if __name__ == "__main__":
    build_text_pdf()
    build_scanned_pdf()
    build_image()
    build_media()
    for path in sorted(OUT.iterdir()):
        if path.suffix in {".pdf", ".png", ".mp3", ".mp4"}:
            print(f"{path.name:24} {path.stat().st_size:>9,} bytes")
