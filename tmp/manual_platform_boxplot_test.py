from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

CK_FACE = "#FF4A3A"
CK_EDGE = "#FF0000"
TR_FACE = "#2EA8FF"
TR_EDGE = "#0057FF"


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
        spine.set_linewidth(0.95)
        spine.set_color("black")
    ax.grid(False)
    ax.tick_params(axis="both", direction="out", width=0.85, length=4.0, colors="black")


def load_plot_data() -> pd.DataFrame:
    df = pd.DataFrame(_uploaded_data)
    df.columns = [str(column).strip() for column in df.columns]
    rate_col = "N2O排放速率(mg N/kg/d)"
    needed = [rate_col, "时间", "处理"]
    missing = [column for column in needed if column not in df.columns]
    if missing:
        raise KeyError(f"Missing columns: {missing}. Available columns: {list(df.columns)}")
    df = df[needed + [column for column in ["ID", "样本代码"] if column in df.columns]].copy()
    df["rate"] = pd.to_numeric(df[rate_col], errors="coerce")
    df = df.dropna(subset=["rate", "时间", "处理"]).copy()
    df["时间"] = df["时间"].astype(str).str.strip()
    df["处理"] = df["处理"].astype(str).str.strip()
    df["log10_rate_plus_1e4"] = np.log10(df["rate"] + 1e-4)
    df["时间"] = pd.Categorical(df["时间"], categories=["24 h", "48 h", "72 h"], ordered=True)
    df["处理"] = pd.Categorical(df["处理"], categories=["CK", "TR"], ordered=True)
    return df.sort_values(["时间", "处理"]).reset_index(drop=True)


def draw_boxplot(df: pd.DataFrame) -> None:
    configure_matplotlib()
    rng = np.random.default_rng(20260616)

    times = ["24 h", "48 h", "72 h"]
    groups = ["CK", "TR"]
    centers = np.arange(len(times), dtype=float)
    offsets = {"CK": -0.18, "TR": 0.18}
    box_width = 0.28

    fig = plt.figure(figsize=(8.2, 5.4), dpi=600)
    ax = fig.add_axes([0.115, 0.15, 0.83, 0.76])
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    for time_idx, time in enumerate(times):
        for group in groups:
            values = df.loc[
                (df["时间"].astype(str) == time) & (df["处理"].astype(str) == group),
                "log10_rate_plus_1e4",
            ].to_numpy()
            pos = centers[time_idx] + offsets[group]
            face = CK_FACE if group == "CK" else TR_FACE
            edge = CK_EDGE if group == "CK" else TR_EDGE
            point_alpha = 0.82 if group == "CK" else 0.88

            ax.boxplot(
                values,
                positions=[pos],
                widths=box_width,
                patch_artist=True,
                showfliers=False,
                medianprops=dict(color="black", linewidth=1.9),
                boxprops=dict(facecolor=face, edgecolor=edge, linewidth=1.75, alpha=0.42),
                whiskerprops=dict(color=edge, linewidth=1.65),
                capprops=dict(color=edge, linewidth=1.65),
            )
            jitter = rng.normal(0, 0.023, size=len(values))
            ax.scatter(
                np.full(len(values), pos) + jitter,
                values,
                s=21,
                color=edge,
                edgecolor="white",
                linewidth=0.35,
                alpha=point_alpha,
                zorder=3,
            )

    ax.set_xlim(-0.55, len(times) - 0.45)
    ax.set_ylim(-3.85, 0.6)
    ax.set_xticks(centers)
    ax.set_xticklabels(times, fontsize=12, fontweight="bold")
    ax.set_yticks(np.arange(-3.5, 0.6, 0.5))
    ax.tick_params(axis="y", labelsize=11)
    ax.set_xlabel("Incubation time", fontsize=13, fontweight="bold", labelpad=8)
    ax.set_ylabel(r"log$_{10}$(N$_2$O emission rate + 1e-4)", fontsize=13, fontweight="bold", labelpad=10)
    ax.set_title(r"N$_2$O emission rates at 24, 48 and 72 h (log$_{10}$ scale)", fontsize=15, fontweight="bold", pad=12)
    style_full_box(ax)

    handles = [
        plt.Line2D(
            [0],
            [0],
            marker="s",
            markersize=8,
            linestyle="None",
            markerfacecolor=CK_FACE,
            markeredgecolor=CK_EDGE,
            markeredgewidth=1.5,
            label="CK",
        ),
        plt.Line2D(
            [0],
            [0],
            marker="s",
            markersize=8,
            linestyle="None",
            markerfacecolor=TR_FACE,
            markeredgecolor=TR_EDGE,
            markeredgewidth=1.5,
            label="TR",
        ),
    ]
    ax.legend(handles=handles, loc="upper right", frameon=False, fontsize=11, handletextpad=0.5, borderaxespad=0.6)


plot_df = load_plot_data()
draw_boxplot(plot_df)
