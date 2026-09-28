"""Extractor tests. Standard library only, so they need nothing beyond the image.

Run inside the ml container:
    docker compose cp services/ml/tests ml:/srv/tests
    docker compose exec ml python -m unittest discover -s /srv/tests -t /srv
"""

from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from app.extractors.office import extract_docx, extract_pptx, extract_xlsx
from app.extractors.tables import normalise_table, stats_text, table_blocks
from app.extractors.text import extract_delimited

ROWS = [
    ["Student", "Hours", "Score"],
    ["Aanya", 8, 91],
    ["Nandini", 6, 84],
    ["Rahul", 3, 52],
    ["Karan", 2, 41],
]


class TableTests(unittest.TestCase):
    def test_statistics_are_computed_not_estimated(self) -> None:
        header, rows = normalise_table(ROWS)
        text = stats_text("scores", header, rows) or ""
        self.assertIn("mean (average) 67", text)  # (91+84+52+41)/4 = 67
        self.assertIn("sum (total) 268", text)
        self.assertIn("maximum (highest) 91 (Aanya)", text)
        self.assertIn("minimum (lowest) 41 (Karan)", text)
        self.assertIn("Top 3 (highest first): Aanya (91), Nandini (84), Rahul (52)", text)
        self.assertNotIn("Column Student", text, "a label column is not averaged")

    def test_every_row_slice_repeats_the_header(self) -> None:
        many = [ROWS[0]] + [[f"S{i}", i, i * 2] for i in range(45)]
        blocks = table_blocks("big", many, 0)
        row_blocks = [block for block in blocks if "rows" in (block.section or "")]
        self.assertEqual(len(row_blocks), 3)  # 45 rows in slices of 20
        for block in row_blocks:
            self.assertIn("| Student | Hours | Score |", block.text)
        self.assertEqual(row_blocks[-1].section, "big — rows 41–45")

    def test_unnamed_columns_get_a_label(self) -> None:
        header, _ = normalise_table([["Name", ""], ["a", "1"]])
        self.assertEqual(header, ["Name", "Column 2"])


class DelimitedTests(unittest.TestCase):
    def test_csv_becomes_a_table_with_stats(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "00000000-0000-0000-0000-000000000000-scores.csv"
            with path.open("w", newline="") as handle:
                csv.writer(handle).writerows(ROWS)
            response = extract_delimited(str(path))
        sections = [block.section for block in response.blocks]
        self.assertEqual(sections[0], "scores.csv — statistics")
        self.assertIn("| Aanya | 8 | 91 |", response.blocks[1].text)


class OfficeTests(unittest.TestCase):
    def test_docx_blocks_follow_headings_and_keep_tables(self) -> None:
        import docx

        document = docx.Document()
        document.add_heading("Benchmark", 0)
        document.add_heading("Transformer Models", 1)
        document.add_paragraph("BERT is an encoder-only Transformer.")
        document.add_heading("Evaluation", 1)
        document.add_paragraph("The benchmark identifier is TB-2048.")
        table = document.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text, table.rows[0].cells[1].text = "Model", "Accuracy"
        cells = table.add_row().cells
        cells[0].text, cells[1].text = "BERT", "81"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "doc.docx"
            document.save(path)
            response = extract_docx(str(path))

        by_section = {block.section: block.text for block in response.blocks}
        self.assertIn("encoder-only", by_section["Transformer Models"])
        self.assertIn("TB-2048", by_section["Evaluation"])
        self.assertNotIn("TB-2048", by_section["Transformer Models"], "sections do not bleed")
        self.assertTrue(any("| BERT | 81 |" in text for text in by_section.values()))

    def test_pptx_keeps_slide_numbers_and_titles_once(self) -> None:
        from pptx import Presentation

        presentation = Presentation()
        for title, body in [("Attention", "Weighs tokens."), ("BERT vs GPT", "BERT masks tokens.")]:
            slide = presentation.slides.add_slide(presentation.slide_layouts[1])
            slide.shapes.title.text = title
            slide.placeholders[1].text_frame.text = body
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "deck.pptx"
            presentation.save(path)
            response = extract_pptx(str(path))

        self.assertEqual([block.page for block in response.blocks], [1, 2])
        self.assertEqual(response.blocks[1].section, "BERT vs GPT")
        self.assertEqual(response.blocks[1].text.count("BERT vs GPT"), 1, "title is not repeated")
        self.assertIn("BERT masks tokens.", response.blocks[1].text)

    def test_xlsx_sheets_become_tables(self) -> None:
        from openpyxl import Workbook

        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Marks"
        for row in ROWS:
            sheet.append(row)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "marks.xlsx"
            workbook.save(path)
            response = extract_xlsx(str(path))

        self.assertIn("mean (average) 67", response.blocks[0].text)
        self.assertEqual(response.blocks[0].section, "Sheet Marks — statistics")


if __name__ == "__main__":
    unittest.main()
