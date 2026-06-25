from __future__ import annotations

import shutil
import string
from datetime import datetime
from pathlib import Path
from random import choices

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = Path(r"C:\Users\SZC\OneDrive\Desktop\课题相关\参考图\农科院汇报")
DATA_FILE = REFERENCE_DIR / "图1重绘_绘图数据.xlsx"
REFERENCE_IMAGE = REFERENCE_DIR / "Fig1B_N2O_emission_rates_24_48_72h_log10.png"
FIGURE_ROOT = PROJECT_ROOT / "论文图统一重绘" / "3N2O排放速率箱线图"

CK_FACE = "#FF4A3A"
CK_EDGE = "#FF0000"
TR_FACE = "#2EA8FF"
TR_EDGE = "#0057FF"


def make_run_dir() -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    code = "".join(choices(string.ascii_uppercase + string.digits, k=4))
    run_dir = FIGURE_ROOT / f"改颜色{stamp}_{code}"
    run_dir.mkdir(parents=True, exist_ok=False)
    return run_dir


def prepare_output_dir() -> Path:
    return make_run_dir()


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


def load_plot_data(data_file: Path) -> pd.DataFrame:
    df = pd.read_excel(data_file, sheet_name="速率箱线图数据")
    df.columns = df.columns.str.strip()
    rate_col = "N2O排放速率(mg N/kg/d)"
    needed = [rate_col, "时间", "处理"]
    missing = [column for column in needed if column not in df.columns]
    if missing:
        raise KeyError(f"Missing columns: {missing}. Available columns: {list(df.columns)}")
    df = df[needed + [column for column in ["ID", "样本代码"] if column in df.columns]].copy()
    df["rate"] = pd.to_numeric(df[rate_col], errors="coerce")
    df = df.dropna(subset=["rate", "时间", "处理"]).copy()
    df["log10_rate_plus_1e4"] = np.log10(df["rate"] + 1e-4)
    df["时间"] = pd.Categorical(df["时间"], categories=["24 h", "48 h", "72 h"], ordered=True)
    df["处理"] = pd.Categorical(df["处理"], categories=["CK", "TR"], ordered=True)
    return df.sort_values(["时间", "处理"]).reset_index(drop=True)


def style_full_box(ax: plt.Axes) -> None:
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_linewidth(0.95)
        spine.set_color("black")
    ax.grid(False)
    ax.tick_params(axis="both", direction="out", width=0.85, length=4.0, colors="black")


def draw_boxplot(df: pd.DataFrame, output_dir: Path) -> None:
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
            values = df.loc[(df["时间"].astype(str) == time) & (df["处理"].astype(str) == group), "log10_rate_plus_1e4"].to_numpy()
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

    png_file = output_dir / "改颜色高饱和_Fig1B_N2O_emission_rates_log10_redraw_v1.png"
    pdf_file = output_dir / "改颜色高饱和_Fig1B_N2O_emission_rates_log10_redraw_v1.pdf"
    svg_file = output_dir / "改颜色高饱和_Fig1B_N2O_emission_rates_log10_redraw_v1.svg"
    fig.savefig(png_file, bbox_inches="tight", facecolor="white")
    fig.savefig(pdf_file, bbox_inches="tight", facecolor="white")
    fig.savefig(svg_file, bbox_inches="tight", facecolor="white")
    plt.close(fig)

    df.to_csv(output_dir / "Fig1B_N2O_emission_rates_log10_plot_data.csv", index=False, encoding="utf-8-sig")
    source_script = Path(__file__).resolve()
    script_copy = output_dir / "改颜色加粗_N2O排放速率箱线图_重绘_v1.py"
    if source_script != script_copy.resolve():
        shutil.copy2(source_script, script_copy)
    if REFERENCE_IMAGE.exists():
        shutil.copy2(REFERENCE_IMAGE, output_dir / "参考图_Fig1B_N2O_emission_rates_24_48_72h_log10.png")
    (output_dir / "改颜色_运行说明.txt").write_text(
        "\n".join(
            [
                "Fig1B N2O 排放速率箱线图重绘 v1 改颜色",
                f"数据文件: {DATA_FILE}",
                "数据表: 速率箱线图数据",
                "变换: log10(N2O排放速率 + 1e-4)",
                "调整: 采用高饱和红蓝配色；CK 为鲜艳红色，TR 为鲜艳蓝色；箱体边线、须线、帽线和中位数线加粗；输出文件夹命名为 改颜色YYYYMMDD_HHMMSS_生成码；其余排版、尺寸、图例位置和统计内容保持原版不变。",
                "统一规则: Times New Roman; N2O 和 log10 使用数学上下标; 全包框; 无网格线; 白色背景; 图例不遮挡主体数据。",
            ]
        ),
        encoding="utf-8",
    )
    print(f"Saved: {png_file}")
    print(f"Saved: {pdf_file}")
    print(f"Saved: {svg_file}")


if __name__ == "__main__":
    run_dir = prepare_output_dir()
    plot_df = load_plot_data(DATA_FILE)
    draw_boxplot(plot_df, run_dir)
