import matplotlib.pyplot as plt
import numpy as np


labels = ["Quality", "Speed", "Cost", "Reliability"]
values_a = np.array([0.82, 0.64, 0.48, 0.91])
values_b = np.array([0.58, 0.79, 0.72, 0.55])
angles = np.linspace(0, 2 * np.pi, len(labels), endpoint=False)
angles_closed = np.r_[angles, angles[0]]

fig, ax = plt.subplots(figsize=(4, 4), subplot_kw={"projection": "polar"})
fig.subplots_adjust(left=0.20, right=0.80, bottom=0.20, top=0.80)
ax.set_ylim(0, 1)
ax.set_xticks(angles)
ax.set_xticklabels(labels)

for values, color, label, alpha in (
    (values_a, "#3366cc", "Model A", 0.25),
    (values_b, "#dd5544", "Model B", 0.18),
):
    values_closed = np.r_[values, values[0]]
    ax.plot(angles_closed, values_closed, color=color, linewidth=2.0, label=label)
    ax.fill(angles_closed, values_closed, color=color, alpha=alpha)

ax.text(
    0.5,
    0.94,
    "Radar note",
    transform=ax.transAxes,
    ha="center",
    va="center",
    bbox={
        "boxstyle": "round,pad=0.30",
        "facecolor": "#ffeeaa",
        "edgecolor": "#333333",
        "alpha": 0.8,
        "linewidth": 1.2,
    },
)
ax.legend(loc="center", bbox_to_anchor=(0.78, 0.82))
