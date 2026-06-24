from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

BLUE = "#1F78B4"
RED = "#D62728"
ZERO = "#333333"


def configure_matplotlib() -> None:
    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman"],
            "mathtext.fontset": "custom",
            "mathtext.rm": "Times New Roman",
            "mathtext.it": "Times New Roman:italic",
            "mathtext.bf": "Times New Roman:bold",
            "axes.unicode_minus": False,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )


def style_full_box(ax: plt.Axes) -> None:
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_linewidth(0.9)
        spine.set_color("black")
    ax.grid(False)
    ax.tick_params(axis="both", direction="out", width=0.8, length=3.5, colors="black")


def draw_ranked_response(df: pd.DataFrame) -> None:
    configure_matplotlib()

    df = df.sort_values("LNRR", ascending=True).reset_index(drop=True)
    df["y"] = np.arange(len(df))
    df["Group"] = np.where(df["LNRR"] > 0, "Promoted", "Suppressed/non-promoted")
    df["Color"] = np.where(df["LNRR"] > 0, BLUE, RED)

    promoted_n = int((df["LNRR"] > 0).sum())
    non_promoted_n = int((df["LNRR"] <= 0).sum())
    total_n = len(df)

    fig = plt.figure(figsize=(8.2, 7.2), dpi=600)
    ax = fig.add_axes([0.14, 0.11, 0.815, 0.805])
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    for _, row in df.iterrows():
        x = float(row["LNRR"])
        y = float(row["y"])
        color = row["Color"]
        ax.hlines(y, 0, x, color=color, linewidth=1.9, zorder=2)
        ax.scatter(x, y, s=34, color=color, edgecolor="white", linewidth=0.6, zorder=3)

    ax.axvline(0, color=ZERO, linestyle=(0, (4, 3)), linewidth=1.0, zorder=1)

    ax.set_yticks(df["y"])
    ax.set_yticklabels(df["Site"], fontsize=8.4, fontweight="bold")
    ax.invert_yaxis()

    xmin = float(df["LNRR"].min())
    xmax = float(df["LNRR"].max())
    span = xmax - xmin
    ax.set_xlim(xmin - 0.12 * span, xmax + 0.23 * span)
    ax.set_ylim(total_n - 0.15, -0.85)
    ax.set_xticks([-1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0])
    ax.tick_params(axis="x", labelsize=10.5)

    ax.set_xlabel("LnRR = ln(DTR / DCK)", fontsize=12, fontweight="bold", labelpad=7)
    ax.set_ylabel("Site code", fontsize=12, fontweight="bold", labelpad=20)
    ax.set_title(
        "Ferrihydrite-induced N$_2$O response ranked by site code",
        fontsize=15,
        fontweight="bold",
        pad=11,
    )
    style_full_box(ax)

    handles = [
        plt.Line2D([0], [0], color=BLUE, marker="o", markersize=6, linewidth=1.9, label="Promoted: LnRR > 0"),
        plt.Line2D([0], [0], color=RED, marker="o", markersize=6, linewidth=1.9, label="Suppressed/non-promoted: LnRR <= 0"),
    ]
    ax.legend(handles=handles, loc="upper right", bbox_to_anchor=(0.985, 0.992), frameon=False, fontsize=10, handlelength=1.8)

    x_stat = xmax + 0.17 * span
    y_stat = total_n - 1.8
    ax.text(x_stat, y_stat, f"LnRR > 0: {promoted_n}\nLnRR <= 0: {non_promoted_n}\nn = {total_n}", ha="right", va="bottom", fontsize=10, fontweight="bold", zorder=4)

    plt.show()


if __name__ == "__main__":
    df = pd.DataFrame(_uploaded_data)
    draw_ranked_response(df)
