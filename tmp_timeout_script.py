import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import chi2

# 常量
PROMOTION = "#1F78B4"
INHIBITION = "#D62728"
CI_COLOR = "#8F8B85"
ZERO_COLOR = "#333333"

# 加载数据
df = pd.DataFrame(_uploaded_data)

# 确保数值列正确
num_cols = ["LNRR", "LNRR_CI_low", "LNRR_CI_high", "LNRR_SE_proxy", "Weight_proxy"]
for col in num_cols:
    df[col] = pd.to_numeric(df[col], errors="coerce")
df = df.dropna(subset=["Site"] + num_cols).copy()

# 按 LnRR 排序并重新编号 y
df = df.sort_values("LNRR", ascending=True).reset_index(drop=True)
df["y"] = np.arange(len(df))

# 颜色（根据 LNRR 符号）
df["Color"] = np.where(df["LNRR"] >= 0, PROMOTION, INHIBITION)

# 点大小（基于 Weight_proxy 重新计算）
weight = df["Weight_proxy"].fillna(df["Weight_proxy"].median())
min_w, max_w = weight.min(), weight.max()
if max_w - min_w > 1e-12:
    df["PointSize"] = 24 + 82 * (weight - min_w) / (max_w - min_w)
else:
    df["PointSize"] = 48

# ----------------- 异质性指标（随机效应 DL 法） -----------------
effects = df["LNRR"].values
se = df["LNRR_SE_proxy"].values
var = se ** 2

w_fixed = 1.0 / var
weighted_mean_fixed = np.average(effects, weights=w_fixed)
Q = np.sum(w_fixed * (effects - weighted_mean_fixed) ** 2)
df_effect = len(effects) - 1

if Q > df_effect:
    tau2 = (Q - df_effect) / (np.sum(w_fixed) - np.sum(w_fixed ** 2) / np.sum(w_fixed))
else:
    tau2 = 0.0

w_random = 1.0 / (var + tau2)
mean_random = np.average(effects, weights=w_random)
se_random = np.sqrt(1.0 / np.sum(w_random))
ci_low = mean_random - 1.96 * se_random
ci_high = mean_random + 1.96 * se_random

I2_percent = max(0.0, (Q - df_effect) / Q) * 100 if Q > 0 else 0.0
Q_p = chi2.sf(Q, df_effect)
Q_text = f"{Q_p:.3f}" if Q_p >= 0.001 else "<0.001"

# ----------------- 绘图样式配置 -----------------
def configure_matplotlib():
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Times New Roman"],
        "mathtext.fontset": "custom",
        "mathtext.rm": "Times New Roman",
        "mathtext.it": "Times New Roman:italic",
        "mathtext.bf": "Times New Roman:bold",
        "axes.unicode_minus": False,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "svg.fonttype": "none",
    })

def style_full_box(ax):
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_linewidth(0.95)
        spine.set_color("black")
    ax.grid(False)
    ax.tick_params(axis="both", direction="out", width=0.85, length=3.8, colors="black")

configure_matplotlib()

fig = plt.figure(figsize=(8.2, 8.8), dpi=600)
ax = fig.add_axes([0.16, 0.13, 0.79, 0.79])
fig.patch.set_facecolor("white")
ax.set_facecolor("white")

# 置信区间线段
xerr_low = df["LNRR"] - df["LNRR_CI_low"]
xerr_high = df["LNRR_CI_high"] - df["LNRR"]
ax.errorbar(
    df["LNRR"], df["y"],
    xerr=[xerr_low, xerr_high],
    fmt="none",
    ecolor=CI_COLOR,
    elinewidth=1.25,
    capsize=0,
    zorder=1,
)

# 效应量散点
ax.scatter(
    df["LNRR"], df["y"],
    s=df["PointSize"],
    c=df["Color"],
    edgecolor="white",
    linewidth=0.55,
    zorder=3,
)

# 零线
ax.axvline(0, color=ZERO_COLOR, linestyle=(0, (4, 3)), linewidth=1.1, zorder=0)

# 轴刻度和标签
ax.set_yticks(df["y"])
ax.set_yticklabels(df["Site"], fontsize=8.4, fontweight="bold")
ax.invert_yaxis()
ax.set_xlim(-1.9, 3.25)
ax.set_xticks([-1, 0, 1, 2, 3])
ax.tick_params(axis="x", labelsize=10.5)

ax.set_xlabel("LnRR = ln(DTR / DCK), 3 d cumulative", fontsize=12, fontweight="bold", labelpad=8)
ax.set_ylabel("Soils sorted by LnRR", fontsize=12, fontweight="bold", labelpad=14)
ax.set_title("Variance-aware LnRR forest plot", loc="left", fontsize=15, fontweight="bold", pad=10)

style_full_box(ax)

# 统计信息文本
summary_text = (
    f"Random mean = {mean_random:.3f} "
    f"[{ci_low:.3f}, {ci_high:.3f}]\n"
    f"I$^2$ = {I2_percent:.1f}%, "
    f"tau$^2$ = {tau2:.3f}, Q p {Q_text}\n"
    "SE: temporal LnRR proxy"
)
ax.text(
    0.975, 0.965,
    summary_text,
    transform=ax.transAxes,
    ha="right", va="top",
    fontsize=10,
    fontweight="normal",
    color="black",
)

# 平台通过 plt.gcf() 获取当前 figure，无需 savefig/show