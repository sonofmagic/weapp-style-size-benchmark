#!/usr/bin/env python3
"""Plot the measured page-count supplement (requires matplotlib==3.10.8).

Run from any directory:
    python src/experiments/plot-page-growth.py

Only a complete, repeatable and validated matrix is accepted.
Native logical checks and H5 visual checks are disclosed separately; no extrapolated points are drawn.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager, ticker


SCHEMES = ("tailwind", "panda", "stylex")
TARGETS = ("weapp", "web")
MODES = ("reuse", "unique")
PAGE_COUNTS = (1, 5, 10, 20, 50)
LABELS = {"tailwind": "Tailwind", "panda": "Panda", "stylex": "StyleX"}
COLORS = {"tailwind": "#087f8c", "panda": "#b16b14", "stylex": "#7655bd"}
MARKERS = {"tailwind": "o", "panda": "s", "stylex": "^"}


def validate_report(report: dict) -> dict[tuple, dict]:
    if report.get("schemaVersion") != 1:
        raise ValueError("Unsupported page-growth report schema")
    if report.get("status") != "validated":
        raise ValueError("Only a validated page-growth experiment can be plotted")
    protocol = report.get("protocol", {})
    if protocol.get("pageCounts") != list(PAGE_COUNTS) or protocol.get("nodesPerPage") != 20:
        raise ValueError("Unexpected page-growth protocol")
    if protocol.get("buildRounds") != 2 or protocol.get("profile") != "standard":
        raise ValueError("The plot requires two clean builds with standard settings")
    if protocol.get("production") is not True or protocol.get("minify") is not True or protocol.get("sourcemap") is not False:
        raise ValueError("The plot requires minified production builds without sourcemaps")
    for gate in ("headless", "web"):
        if report.get("validation", {}).get(gate, {}).get("status") != "passed":
            raise ValueError(f"Page-growth validation has not passed: {gate}")
    expected = {
        (scheme, target, mode, count)
        for scheme in SCHEMES
        for target in TARGETS
        for mode in MODES
        for count in PAGE_COUNTS
    }
    rows = {}
    for row in report.get("rows", []):
        key = tuple(row.get(name) for name in ("scheme", "target", "mode", "pageCount"))
        if key not in expected or key in rows:
            raise ValueError(f"Unexpected or duplicate page-growth row: {key}")
        if row.get("nodesPerPage") != 20:
            raise ValueError(f"The plot requires exactly 20 style probes per page: {key}")
        if row.get("profile") != "standard":
            raise ValueError(f"The plot requires standard production settings: {key}")
        if row.get("repeatable") is not True:
            raise ValueError(f"Unstable production output cannot be plotted: {key}")
        if row.get("referenceValidation", {}).get("status") != "passed":
            raise ValueError(f"Artifact reference validation has not passed: {key}")
        validation = row.get("validation", {})
        expected_visual = "not-run" if row.get("target") == "weapp" else "passed"
        if validation.get("status") != "passed" or validation.get("visual") != expected_visual:
            raise ValueError(f"Page-growth row validation is incomplete or misreported: {key}")
        measurement = row.get("measurement", {})
        files = measurement.get("files", [])
        if not files:
            raise ValueError(f"Missing physical artifact file manifest: {key}")
        for metric in ("raw", "gzip", "brotli"):
            value = measurement.get("totals", {}).get(metric)
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"Invalid {metric} measurement: {key}")
            if sum(file[metric] for file in files) != value:
                raise ValueError(f"File totals disagree with measurement: {key}/{metric}")
        for kind in ("style", "script", "template", "json", "asset"):
            value = measurement.get("byKind", {}).get(kind, {}).get("raw")
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"Missing file-kind measurement: {key}/{kind}")
        rows[key] = row
    if set(rows) != expected:
        raise ValueError(f"Incomplete page-growth matrix: expected {len(expected)}, got {len(rows)}")
    return rows


def configure_fonts(explicit_font: Path | None) -> None:
    candidates = [explicit_font] if explicit_font else []
    candidates.extend([
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/System/Library/Fonts/Hiragino Sans GB.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
    ])
    for candidate in candidates:
        if candidate and candidate.is_file():
            font_manager.fontManager.addfont(str(candidate))
            family = font_manager.FontProperties(fname=str(candidate)).get_name()
            plt.rcParams["font.family"] = [family, "DejaVu Sans"]
            break
    else:
        raise ValueError("No Chinese chart font found; pass --font /absolute/path/to/font.ttf")
    plt.rcParams.update({
        "axes.unicode_minus": False,
        "font.size": 11.5,
        "axes.titlesize": 13,
        "axes.labelsize": 11,
        "xtick.labelsize": 10,
        "ytick.labelsize": 10,
        "svg.fonttype": "path",
        "svg.hashsalt": "weapp-style-size-benchmark-page-growth-v1",
        "savefig.facecolor": "white",
    })


def raw_value(row: dict, metric: str) -> float:
    measurement = row["measurement"]
    value = measurement["totals"]["raw"] if metric == "total" else measurement["byKind"]["style"]["raw"]
    return value / 1024


def visual_status(report: dict) -> str:
    return "双构建一致；原生仅 headless 逻辑检查；H5 首 / 中 / 末页效果校验通过；本补测未跑微信 IDE。"


def draw(report: dict, rows: dict[tuple, dict], directory: Path, metric: str) -> list[Path]:
    is_total = metric == "total"
    stem = "page-growth" if is_total else "style-growth"
    title = "页面数增长：最终产物体积" if is_total else "页面数增长：WXSS / CSS 文件体积"
    y_label = "最终产物（raw KiB）" if is_total else "样式文件（raw KiB）"
    fig, axes = plt.subplots(2, 2, figsize=(13.8, 9.2), sharex=True)
    fig.patch.set_facecolor("white")
    fig.subplots_adjust(left=0.075, right=0.975, bottom=0.14, top=0.80, wspace=0.25, hspace=0.39)
    fig.text(0.075, 0.955, title, fontsize=21, weight="medium", color="#182332", va="top")
    fig.text(0.075, 0.907, "实测 1 / 5 / 10 / 20 / 50 页  ·  每页 20 个样式探针，另有固定标题 / 布局  ·  同一主包  ·  常规生产", fontsize=11.5, color="#536170")

    for target_index, target in enumerate(TARGETS):
        for mode_index, mode in enumerate(MODES):
            ax = axes[target_index, mode_index]
            panel_values = [raw_value(row, metric) for key, row in rows.items() if key[1:3] == (target, mode)]
            maximum = max(panel_values) * 1.12 or 1
            for scheme in SCHEMES:
                values = [raw_value(rows[(scheme, target, mode, count)], metric) for count in PAGE_COUNTS]
                ax.plot(PAGE_COUNTS, values, label=LABELS[scheme], color=COLORS[scheme], marker=MARKERS[scheme], markersize=6, markeredgewidth=0, linewidth=2.4, clip_on=True)
            platform = "微信原生" if target == "weapp" else "H5"
            scenario = "跨页复用同一组 20 款样式" if mode == "reuse" else "每页新增 20 款独特样式"
            ax.set_title(f"{platform} · {scenario}", loc="left", pad=15, color="#182332")
            ax.set_xlim(0, 52)
            ax.set_ylim(0, maximum)
            ax.set_xticks(PAGE_COUNTS)
            ax.tick_params(axis="both", length=0, pad=7, colors="#536170", labelbottom=True)
            ax.yaxis.set_major_locator(ticker.MaxNLocator(nbins=4, min_n_ticks=3))
            ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda value, _: f"{value:,.0f}" if value >= 10 else f"{value:g}"))
            ax.set_axisbelow(True)
            ax.grid(axis="y", linewidth=0.8, color="#e1e6eb")
            ax.set_facecolor("white")
            for spine in ("top", "right"):
                ax.spines[spine].set_visible(False)
            for spine in ("left", "bottom"):
                ax.spines[spine].set_color("#c5ced7")
                ax.spines[spine].set_linewidth(0.7)
            ax.set_xlabel("页面数（页）", labelpad=8, color="#536170")
            ax.set_ylabel(y_label, labelpad=10, color="#536170")

    handles, labels = axes[0, 0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper left", bbox_to_anchor=(0.071, 0.877), ncol=3, frameon=False, handlelength=2.2, columnspacing=2.4, fontsize=12)
    footnotes = ["所有标记均来自真实生产构建，无外推。各面板纵轴独立、均从 0 开始；不可通过线条角度跨面板比较增速。"]
    if is_total:
        footnotes.append("总量包含 WXSS/CSS、JS、WXML/HTML、JSON 与资源；每个物理文件分别计量，未按内容去重。")
    else:
        footnotes.append("按文件扩展名分类：H5 的 ShadowRoot CSS 可内嵌在 JS 中，本图不代表 H5 的全部样式负载。")
    footnotes.append(visual_status(report))
    for index, text in enumerate(footnotes):
        fig.text(0.075, 0.081 - index * 0.025, text, color="#536170", fontsize=9.5, va="top")

    directory.mkdir(parents=True, exist_ok=True)
    files = []
    for extension in ("png", "svg"):
        destination = directory / f"{stem}.{extension}"
        metadata = {"Creator": "weapp-style-size-benchmark page-growth plotter"}
        if extension == "svg":
            metadata.update({"Date": None, "Title": title, "Description": "真实页面数，每页20个样式探针，另有固定标题和布局；单一主包、常规生产配置。全部为实测点，无外推，各面板纵轴独立。"})
        fig.savefig(destination, dpi=200, metadata=metadata)
        if extension == "svg":
            destination.write_text("\n".join(line.rstrip() for line in destination.read_text().splitlines()) + "\n")
        files.append(destination)
    plt.close(fig)
    return files


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=root / "reports/page-growth/results.json")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--font", type=Path, help="Chinese-capable TTF/OTF/TTC font")
    args = parser.parse_args()
    source = args.input.resolve()
    report = json.loads(source.read_text())
    rows = validate_report(report)
    configure_fonts(args.font)
    destination = (args.output_dir or source.parent).resolve()
    for metric in ("total", "style"):
        for file in draw(report, rows, destination, metric):
            print(file)


if __name__ == "__main__":
    main()
