"""Layout tests: charts and tables recovered from OCR boxes alone.

The coordinates in CHART are the ones RapidOCR produced for a real upload (an
"AI in Education" infographic), so the test fails if the geometry stops
pairing each year with the value printed above it.

Run inside the ml container:
    docker compose cp services/ml/tests ml:/srv/tests
    docker compose exec -w /srv ml python -m unittest discover -s /srv/tests -t /srv
"""

from __future__ import annotations

import unittest

from app.extractors import layout
from app.extractors.layout import Line


def line(text: str, x0: float, y0: float, x1: float, y1: float) -> Line:
    return Line(text, x0, y0, x1, y1)


CHART = [
    line("Global Adoption Trends", 83, 536, 311, 561),
    line("AI in Education Market Size (USD Billion)", 83, 579, 378, 600),
    line("48.2", 382, 603, 419, 622),
    line("50", 57, 613, 81, 631),
    line("37.6", 327, 630, 363, 649),
    line("40", 57, 639, 81, 660),
    line("28.9", 270, 655, 306, 673),
    line("30", 57, 668, 80, 688),
    line("21.4", 213, 677, 248, 696),
    line("20", 57, 696, 80, 717),
    line("15.7", 156, 693, 191, 714),
    line("12.1", 102, 705, 132, 724),
    line("10", 58, 724, 80, 745),
    line("0", 66, 754, 79, 768),
    line("2021", 99, 769, 137, 787),
    line("2022", 154, 768, 194, 786),
    line("2023", 211, 768, 253, 786),
    line("2024", 267, 768, 309, 786),
    line("2025", 325, 769, 364, 786),
    line("2026", 381, 769, 421, 787),
]

TABLE = [
    line("Exam Results", 40, 10, 200, 30),
    line("Student", 40, 50, 120, 70),
    line("Score", 240, 50, 300, 70),
    line("Aanya", 40, 90, 110, 110),
    line("91", 240, 90, 262, 110),
    line("Riya", 40, 130, 95, 150),
    line("78", 240, 130, 262, 150),
]


class ChartTests(unittest.TestCase):
    def test_each_year_is_paired_with_the_value_above_it(self) -> None:
        regions = layout.analyse(CHART)
        charts = [region for region in regions if region.kind == "chart"]
        self.assertEqual(len(charts), 1)
        chart = charts[0]
        self.assertEqual(chart.title, "AI in Education Market Size")
        self.assertEqual(chart.unit, "USD Billion")
        self.assertEqual(chart.columns, ["year", "value"])
        pairs = {record["year"]: record["value"] for record in chart.data}
        self.assertEqual(
            pairs,
            {2021.0: 12.1, 2022.0: 15.7, 2023.0: 21.4, 2024.0: 28.9, 2025.0: 37.6, 2026.0: 48.2},
        )

    def test_axis_ticks_are_not_data(self) -> None:
        chart = next(region for region in layout.analyse(CHART) if region.kind == "chart")
        values = {record["value"] for record in chart.data}
        self.assertTrue(values.isdisjoint({50.0, 40.0, 30.0, 20.0, 10.0, 0.0}))

    def test_rendering_states_each_record_as_a_sentence(self) -> None:
        chart = next(region for region in layout.analyse(CHART) if region.kind == "chart")
        text = layout.render(layout.to_visual(chart, 956, 1152, 0))
        self.assertIn("The chart shows that in 2024, AI in Education Market Size was 28.9 USD Billion.", text)
        self.assertIn("2021 | 12.1", text)

    def test_currency_labels_are_kept_verbatim(self) -> None:
        revenue = [
            line("Revenue", 40, 10, 160, 30),
            line("$21M", 250, 60, 300, 80),
            line("$14M", 150, 110, 200, 130),
            line("$10M", 50, 140, 100, 160),
            line("2022", 50, 200, 100, 220),
            line("2023", 150, 200, 200, 220),
            line("2024", 250, 200, 300, 220),
        ]
        chart = next(region for region in layout.analyse(revenue) if region.kind == "chart")
        self.assertEqual(chart.title, "Revenue")
        pairs = {record["year"]: record["value"] for record in chart.data}
        self.assertEqual(pairs, {2022.0: "$10M", 2023.0: "$14M", 2024.0: "$21M"})


class TableTests(unittest.TestCase):
    def test_rows_keep_their_columns(self) -> None:
        tables = [region for region in layout.analyse(TABLE) if region.kind == "table"]
        self.assertEqual(len(tables), 1)
        table = tables[0]
        self.assertEqual(table.title, "Exam Results")
        self.assertEqual(table.columns, ["Student", "Score"])
        self.assertEqual(table.data, [{"Student": "Aanya", "Score": 91.0}, {"Student": "Riya", "Score": 78.0}])
        text = layout.render(layout.to_visual(table, 400, 200, 0))
        self.assertIn("The table lists Aanya: Score 91.", text)

    def test_a_numeric_totals_row_is_not_read_as_a_chart(self) -> None:
        totals = [
            line("Q1", 40, 20, 80, 40),
            line("Q2", 140, 20, 180, 40),
            line("Q3", 240, 20, 280, 40),
            line("10", 40, 60, 70, 80),
            line("20", 140, 60, 170, 80),
            line("30", 240, 60, 270, 80),
            line("11", 40, 100, 70, 120),
            line("21", 140, 100, 170, 120),
            line("31", 240, 100, 270, 120),
        ]
        kinds = {region.kind for region in layout.analyse(totals)}
        self.assertNotIn("chart", kinds)
        self.assertIn("table", kinds)

    def test_a_wrapped_cell_is_folded_into_its_row(self) -> None:
        wrapped = [
            line("Application Area", 491, 572, 621, 595),
            line("Examples", 679, 573, 757, 594),
            line("Intelligent Tutoring", 489, 599, 636, 625),
            line("Adaptive learning platforms", 680, 601, 883, 624),
            line("Systems", 490, 622, 556, 643),
            line("(e.g., Khanmigo, Duolingo)", 679, 620, 871, 644),
            line("Automated Assessment", 491, 650, 662, 671),
            line("AI-based grading and feedback", 681, 651, 902, 671),
        ]
        table = next(region for region in layout.analyse(wrapped) if region.kind == "table")
        self.assertEqual(
            table.data[0],
            {"Application Area": "Intelligent Tutoring Systems", "Examples": "Adaptive learning platforms (e.g., Khanmigo, Duolingo)"},
        )
        self.assertEqual(len(table.data), 2)


class ReadingOrderTests(unittest.TestCase):
    def test_columns_are_read_one_after_the_other(self) -> None:
        page = [
            line("Left column first line of a paragraph that runs on", 40, 100, 300, 120),
            line("Right column first line of another paragraph here", 500, 100, 760, 120),
            line("Left column second line, which ends the thought.", 40, 122, 300, 142),
            line("Right column second line, which ends it too.", 500, 122, 760, 142),
        ]
        regions = layout.analyse(page)
        text = layout.reading_order_text(regions)
        self.assertLess(text.index("Left column second"), text.index("Right column first"))


if __name__ == "__main__":
    unittest.main()
