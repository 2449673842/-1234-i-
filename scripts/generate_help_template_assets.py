from __future__ import annotations

from pathlib import Path
import struct

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Ellipse
from matplotlib.colors import LinearSegmentedColormap


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIR = ROOT / "public"

PALETTE = {
    "green": "#1F6F54",
    "gold": "#C9A227",
    "blue": "#0F4D92",
    "red": "#B64342",
    "light_green": "#D9EEE7",
    "light_gold": "#F3E7B3",
    "light_blue": "#D9E6F5",
    "light_red": "#F3D3D0",
    "neutral": "#4D4D4D",
    "grid": "#D9D9D9",
}


def apply_publication_style() -> None:
    plt.rcParams["font.family"] = "sans-serif"
    plt.rcParams["font.sans-serif"] = ["Arial", "DejaVu Sans", "Liberation Sans"]
    plt.rcParams["svg.fonttype"] = "none"
    plt.rcParams["font.size"] = 15
    plt.rcParams["axes.spines.right"] = False
    plt.rcParams["axes.spines.top"] = False
    plt.rcParams["axes.linewidth"] = 1.6
    plt.rcParams["axes.labelcolor"] = PALETTE["neutral"]
    plt.rcParams["xtick.color"] = PALETTE["neutral"]
    plt.rcParams["ytick.color"] = PALETTE["neutral"]
    plt.rcParams["legend.frameon"] = False
    plt.rcParams["figure.facecolor"] = "white"
    plt.rcParams["axes.facecolor"] = "white"


def save_png(fig: plt.Figure, name: str) -> Path:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    out_path = PUBLIC_DIR / name
    fig.savefig(out_path, dpi=200, facecolor="white")
    plt.close(fig)
    return out_path


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as fh:
        header = fh.read(24)
    if header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG file")
    return struct.unpack(">II", header[16:24])


def draw_grouped_bar() -> Path:
    categories = ["Control", "Low dose", "Medium dose", "High dose"]
    values = {
        "Growth": np.array([0.42, 0.55, 0.71, 0.78]),
        "Uptake": np.array([0.38, 0.50, 0.64, 0.69]),
        "Stress": np.array([0.31, 0.28, 0.22, 0.19]),
    }
    errors = {
        "Growth": np.array([0.03, 0.04, 0.04, 0.03]),
        "Uptake": np.array([0.04, 0.03, 0.05, 0.04]),
        "Stress": np.array([0.02, 0.03, 0.02, 0.02]),
    }
    colors = [PALETTE["green"], PALETTE["blue"], PALETTE["gold"]]

    fig, ax = plt.subplots(figsize=(8, 5))
    x = np.arange(len(categories))
    width = 0.23

    for idx, ((label, series), color) in enumerate(zip(values.items(), colors)):
        offset = (idx - 1) * width
        bars = ax.bar(
            x + offset,
            series,
            width,
            yerr=errors[label],
            capsize=4,
            label=label,
            color=color,
            edgecolor="#222222",
            linewidth=0.9,
            error_kw={"elinewidth": 1.4, "capthick": 1.4},
        )
        for bar, val, err in zip(bars, series, errors[label]):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                val + err + 0.025,
                f"{val:.2f}",
                ha="center",
                va="bottom",
                fontsize=10,
                color=PALETTE["neutral"],
            )

    ax.set_title("Response metrics across treatment groups", fontsize=17, pad=14)
    ax.set_ylabel("Normalized response")
    ax.set_xticks(x)
    ax.set_xticklabels(categories)
    ax.set_ylim(0, 0.9)
    ax.set_yticks(np.arange(0, 1.0, 0.2))
    ax.yaxis.grid(True, color=PALETTE["grid"], linewidth=0.8, alpha=0.7)
    ax.set_axisbelow(True)
    ax.legend(ncol=3, loc="upper left", bbox_to_anchor=(0, 1.0), fontsize=11)
    fig.tight_layout(pad=1.4)
    return save_png(fig, "help-template-grouped-bar.png")


def draw_regression() -> Path:
    x = np.array([1.1, 1.5, 2.0, 2.4, 2.8, 3.2, 3.7, 4.1, 4.5, 5.0, 5.4, 5.9])
    y = np.array([2.0, 2.4, 2.8, 3.0, 3.5, 3.8, 4.0, 4.6, 4.7, 5.2, 5.5, 5.9])
    slope, intercept = np.polyfit(x, y, 1)
    fit_x = np.linspace(0.9, 6.1, 200)
    fit_y = slope * fit_x + intercept
    band = 0.32 + 0.04 * np.abs(fit_x - fit_x.mean())

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.fill_between(
        fit_x,
        fit_y - band,
        fit_y + band,
        color=PALETTE["light_blue"],
        alpha=0.95,
        linewidth=0,
        label="95% confidence band",
    )
    ax.plot(fit_x, fit_y, color=PALETTE["blue"], linewidth=2.8, label="Linear fit")
    ax.scatter(
        x,
        y,
        s=78,
        color=PALETTE["green"],
        edgecolor="white",
        linewidth=1.2,
        zorder=3,
        label="Observed samples",
    )
    ax.text(
        0.05,
        0.92,
        "r = 0.98   p < 0.001",
        transform=ax.transAxes,
        fontsize=12,
        color=PALETTE["neutral"],
    )
    ax.set_title("Predictor-response association", fontsize=17, pad=14)
    ax.set_xlabel("Predictor intensity")
    ax.set_ylabel("Measured response")
    ax.set_xlim(0.8, 6.2)
    ax.set_ylim(1.6, 6.4)
    ax.yaxis.grid(True, color=PALETTE["grid"], linewidth=0.8, alpha=0.7)
    ax.set_axisbelow(True)
    ax.legend(loc="lower right", fontsize=11)
    fig.tight_layout(pad=1.4)
    return save_png(fig, "help-template-regression.png")


def draw_heatmap() -> Path:
    matrix = np.array(
        [
            [1.8, 1.2, 0.4, -0.7, -1.2],
            [1.1, 0.6, 0.1, -0.2, -0.8],
            [0.3, -0.2, -0.5, 0.4, 0.9],
            [-0.7, -0.4, 0.2, 1.0, 1.4],
            [-1.4, -0.8, 0.1, 1.2, 1.9],
        ]
    )
    rows = ["Gene A", "Gene B", "Gene C", "Gene D", "Gene E"]
    cols = ["T0", "T1", "T2", "T3", "T4"]
    cmap = LinearSegmentedColormap.from_list(
        "green_gold_blue_red",
        [PALETTE["blue"], "white", PALETTE["gold"], PALETTE["red"]],
        N=256,
    )

    fig, ax = plt.subplots(figsize=(8, 5))
    im = ax.imshow(matrix, cmap=cmap, vmin=-2, vmax=2, aspect="auto")
    ax.set_title("Expression change by time point", fontsize=17, pad=14)
    ax.set_xticks(np.arange(len(cols)))
    ax.set_xticklabels(cols)
    ax.set_yticks(np.arange(len(rows)))
    ax.set_yticklabels(rows)
    ax.tick_params(axis="both", length=0)
    ax.set_frame_on(False)

    for i in range(matrix.shape[0]):
        for j in range(matrix.shape[1]):
            val = matrix[i, j]
            text_color = "white" if abs(val) > 1.15 else PALETTE["neutral"]
            ax.text(j, i, f"{val:+.1f}", ha="center", va="center", fontsize=11, color=text_color)

    ax.set_xticks(np.arange(-0.5, len(cols), 1), minor=True)
    ax.set_yticks(np.arange(-0.5, len(rows), 1), minor=True)
    ax.grid(which="minor", color="white", linewidth=2.0)
    ax.tick_params(which="minor", bottom=False, left=False)
    cbar = fig.colorbar(im, ax=ax, fraction=0.045, pad=0.04)
    cbar.set_label("Z-score", color=PALETTE["neutral"])
    cbar.outline.set_linewidth(0)
    fig.tight_layout(pad=1.4)
    return save_png(fig, "help-template-heatmap.png")


def draw_boxplot() -> Path:
    groups = ["Control", "Low dose", "Medium dose", "High dose"]
    values = [
        np.array([0.42, 0.45, 0.48, 0.51, 0.53, 0.57, 0.59, 0.62]),
        np.array([0.50, 0.54, 0.58, 0.60, 0.64, 0.68, 0.70, 0.73]),
        np.array([0.61, 0.66, 0.69, 0.72, 0.76, 0.79, 0.83, 0.86]),
        np.array([0.67, 0.72, 0.75, 0.79, 0.82, 0.85, 0.88, 0.91]),
    ]
    colors = [PALETTE["light_green"], PALETTE["light_blue"], PALETTE["light_gold"], PALETTE["light_red"]]
    point_colors = [PALETTE["green"], PALETTE["blue"], PALETTE["gold"], PALETTE["red"]]

    fig, ax = plt.subplots(figsize=(8, 5))
    positions = np.arange(1, len(groups) + 1)
    box = ax.boxplot(
        values,
        positions=positions,
        widths=0.52,
        patch_artist=True,
        showfliers=False,
        medianprops={"color": "#222222", "linewidth": 1.8},
        whiskerprops={"color": "#333333", "linewidth": 1.3},
        capprops={"color": "#333333", "linewidth": 1.3},
        boxprops={"edgecolor": "#333333", "linewidth": 1.3},
    )
    for patch, color in zip(box["boxes"], colors):
        patch.set_facecolor(color)

    jitter = np.array([-0.14, -0.10, -0.05, -0.01, 0.04, 0.08, 0.12, 0.15])
    for pos, group_values, color in zip(positions, values, point_colors):
        ax.scatter(
            np.full_like(group_values, pos, dtype=float) + jitter,
            group_values,
            s=56,
            color=color,
            edgecolor="white",
            linewidth=0.9,
            alpha=0.95,
            zorder=3,
        )

    ax.set_title("Distribution of response by treatment", fontsize=17, pad=14)
    ax.set_ylabel("Normalized response")
    ax.set_xticks(positions)
    ax.set_xticklabels(groups)
    ax.set_ylim(0.35, 0.98)
    ax.yaxis.grid(True, color=PALETTE["grid"], linewidth=0.8, alpha=0.7)
    ax.set_axisbelow(True)
    fig.tight_layout(pad=1.4)
    return save_png(fig, "help-template-boxplot.png")


def draw_time_series() -> Path:
    time = np.array([0, 2, 4, 6, 8, 10, 12])
    control = np.array([0.42, 0.46, 0.49, 0.52, 0.55, 0.57, 0.58])
    treated = np.array([0.43, 0.52, 0.61, 0.68, 0.74, 0.78, 0.81])
    control_err = np.array([0.035, 0.032, 0.034, 0.037, 0.036, 0.034, 0.033])
    treated_err = np.array([0.038, 0.041, 0.044, 0.045, 0.043, 0.040, 0.039])

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.fill_between(
        time,
        control - control_err,
        control + control_err,
        color=PALETTE["light_blue"],
        alpha=0.85,
        linewidth=0,
    )
    ax.fill_between(
        time,
        treated - treated_err,
        treated + treated_err,
        color=PALETTE["light_green"],
        alpha=0.9,
        linewidth=0,
    )
    ax.plot(time, control, color=PALETTE["blue"], linewidth=2.6, marker="o", markersize=6.5, label="Control")
    ax.plot(time, treated, color=PALETTE["green"], linewidth=2.6, marker="o", markersize=6.5, label="Treatment")
    ax.errorbar(time, control, yerr=control_err, fmt="none", ecolor=PALETTE["blue"], elinewidth=1.2, capsize=3)
    ax.errorbar(time, treated, yerr=treated_err, fmt="none", ecolor=PALETTE["green"], elinewidth=1.2, capsize=3)

    ax.set_title("Temporal response trajectory", fontsize=17, pad=14)
    ax.set_xlabel("Time after treatment (days)")
    ax.set_ylabel("Mean response")
    ax.set_xlim(-0.5, 12.5)
    ax.set_ylim(0.34, 0.9)
    ax.set_xticks(time)
    ax.yaxis.grid(True, color=PALETTE["grid"], linewidth=0.8, alpha=0.7)
    ax.set_axisbelow(True)
    ax.legend(loc="upper left", fontsize=11)
    fig.tight_layout(pad=1.4)
    return save_png(fig, "help-template-time-series.png")


def draw_forest() -> Path:
    labels = ["Overall", "Soil organic C", "High moisture", "Low moisture", "Neutral pH", "Acidic pH"]
    effects = np.array([0.18, 0.34, 0.27, -0.06, 0.22, 0.05])
    lower = np.array([0.06, 0.16, 0.08, -0.22, 0.04, -0.12])
    upper = np.array([0.30, 0.52, 0.46, 0.10, 0.40, 0.22])
    y = np.arange(len(labels))[::-1]

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.axvline(0, color=PALETTE["neutral"], linewidth=1.5, linestyle="--", label="No effect")
    for idx, (effect, lo, hi) in enumerate(zip(effects, lower, upper)):
        color = PALETTE["green"] if lo > 0 else PALETTE["gold"] if hi < 0 else PALETTE["blue"]
        ax.hlines(y[idx], lo, hi, color=color, linewidth=2.2)
        ax.plot(effect, y[idx], "s", color=color, markersize=8, markeredgecolor="white", markeredgewidth=0.9)
        ax.text(0.57, y[idx], f"{effect:+.2f} [{lo:+.2f}, {hi:+.2f}]", va="center", fontsize=11, color=PALETTE["neutral"])

    ax.set_title("Effect estimates with 95% confidence intervals", fontsize=17, pad=14)
    ax.set_xlabel("Effect size")
    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    ax.set_xlim(-0.32, 0.82)
    ax.set_ylim(-0.7, len(labels) - 0.3)
    ax.xaxis.grid(True, color=PALETTE["grid"], linewidth=0.8, alpha=0.7)
    ax.set_axisbelow(True)
    fig.tight_layout(pad=1.4)
    return save_png(fig, "help-template-forest.png")


def add_confidence_ellipse(ax: plt.Axes, points: np.ndarray, color: str) -> None:
    cov = np.cov(points, rowvar=False)
    vals, vecs = np.linalg.eigh(cov)
    order = vals.argsort()[::-1]
    vals = vals[order]
    vecs = vecs[:, order]
    angle = np.degrees(np.arctan2(vecs[1, 0], vecs[0, 0]))
    width, height = 2 * np.sqrt(vals * 5.991)
    ellipse = Ellipse(
        xy=points.mean(axis=0),
        width=width,
        height=height,
        angle=angle,
        facecolor=color,
        edgecolor=color,
        linewidth=1.8,
        alpha=0.18,
        zorder=1,
    )
    ax.add_patch(ellipse)


def draw_ordination() -> Path:
    early = np.array(
        [
            [-1.45, 0.18],
            [-1.20, 0.42],
            [-1.02, -0.08],
            [-0.86, 0.24],
            [-0.70, -0.30],
            [-0.55, 0.04],
        ]
    )
    mid = np.array(
        [
            [-0.20, -0.62],
            [0.02, -0.36],
            [0.18, -0.76],
            [0.36, -0.22],
            [0.48, -0.54],
            [0.65, -0.18],
        ]
    )
    late = np.array(
        [
            [0.62, 0.36],
            [0.82, 0.58],
            [1.02, 0.22],
            [1.16, 0.72],
            [1.34, 0.40],
            [1.48, 0.86],
        ]
    )
    groups = [
        ("Early", early, PALETTE["blue"]),
        ("Middle", mid, PALETTE["gold"]),
        ("Late", late, PALETTE["green"]),
    ]

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.axhline(0, color=PALETTE["grid"], linewidth=1.0)
    ax.axvline(0, color=PALETTE["grid"], linewidth=1.0)
    for label, points, color in groups:
        add_confidence_ellipse(ax, points, color)
        ax.scatter(
            points[:, 0],
            points[:, 1],
            s=72,
            color=color,
            edgecolor="white",
            linewidth=1.1,
            label=label,
            zorder=3,
        )

    ax.set_title("Ordination of sample composition", fontsize=17, pad=14)
    ax.set_xlabel("PCoA1 (42.6% variance explained)")
    ax.set_ylabel("PCoA2 (18.4% variance explained)")
    ax.set_xlim(-1.8, 1.8)
    ax.set_ylim(-1.05, 1.15)
    ax.xaxis.grid(True, color=PALETTE["grid"], linewidth=0.8, alpha=0.55)
    ax.yaxis.grid(True, color=PALETTE["grid"], linewidth=0.8, alpha=0.55)
    ax.set_axisbelow(True)
    ax.legend(loc="upper left", fontsize=11)
    fig.tight_layout(pad=1.4)
    return save_png(fig, "help-template-ordination.png")


def main() -> None:
    apply_publication_style()
    outputs = [
        draw_grouped_bar(),
        draw_regression(),
        draw_heatmap(),
        draw_boxplot(),
        draw_time_series(),
        draw_forest(),
        draw_ordination(),
    ]
    for path in outputs:
        width, height = png_size(path)
        rel = path.relative_to(ROOT).as_posix()
        print(f"{rel}: {width}x{height}px")


if __name__ == "__main__":
    main()
